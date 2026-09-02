import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { startProcess, checkPortStatus } from '@/lib/process-manager';
import { killStrayListeners } from '@/lib/ports';
import { isRemoteProject, proxyProjectAction } from '@/lib/route-decision';
import { invalidateRemoteProjectCache } from '@/lib/remote-sync';
import { startRepairJob } from '@/lib/llm-repair';
import { logActivity } from '@/lib/activity';
import { requireApprovedUser } from '@/lib/auth';

// Companion projects that should be auto-started when the parent project starts.
const COMPANION_AUTO_START: Record<string, string> = {
  'hermes web': 'hermes bridge',
};

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; envId: string }> }
) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(_req);
  if (authGuard.error) return authGuard.error;
  try {
    const { id, envId } = await params;

    const env = await db.environment.findUnique({
      where: { id: envId },
      include: { project: true },
    });

    if (!env) {
      return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    }
    if (env.projectId !== id) {
      return NextResponse.json({ error: 'Environment does not belong to this project' }, { status: 403 });
    }

    // Remote project → proxy to agent
    if (isRemoteProject(env.project)) {
      const result = await proxyProjectAction(
        env.project.deviceId!,
        `/projects/${id}/environments/${envId}/start`,
        'POST'
      );
      // The process state changed on the agent — drop the sync cache so the
      // next list GET re-syncs instead of serving the pre-start snapshot.
      invalidateRemoteProjectCache();
      return NextResponse.json(result.data, { status: result.status });
    }

    // Local project → existing logic
    let envVars: Record<string, string> = {};
    try {
      envVars = JSON.parse(env.envVars);
    } catch {
      // ignore parse errors
    }

    // ---- Start-conflict resolution -------------------------------------
    // If the project is ALREADY running (typically on another port — a stray
    // from an old port config, a previous dashboard session, or a manual
    // start), kill the original process(es) first so the start lands on the
    // freshly configured port instead of failing with "port in use" or
    // forking a duplicate instance. Ports of sibling environments that are
    // legitimately running (other envs of this project) are preserved.
    try {
      const siblings = await db.environment.findMany({
        where: { projectId: id, id: { not: envId }, status: 'running' },
        select: { port: true },
      });
      const killed = await killStrayListeners(
        env.project.path,
        siblings.map((s) => s.port),
      );
      if (killed.length > 0) {
        // This env's own stray (old pid from a previous port) is dead — reset
        // the stale running state so the start below is a clean slate.
        if (env.status === 'running') {
          await db.environment.update({ where: { id: envId }, data: { status: 'stopped', pid: null } });
        }
        logActivity({
          type: 'start',
          level: 'warn',
          message: `Killed ${killed.length} stray process(es) of '${env.project.name}' before start`,
          projectId: id,
          projectName: env.project.name,
          envId,
          envName: env.name,
          detail: killed.map((k) => `port ${k.port} pid ${k.pid}: ${(k.command || k.cwd).slice(0, 80)}`).join('; '),
        });
      }
    } catch {
      // Stray sweep is best-effort — a failure here must not block the start.
    }

    const result = await startProcess(
      id,
      env.name,
      env.cmd,
      env.project.path,
      envVars,
      env.port
    );

    if (result.success) {
      await db.environment.update({
        where: { id: envId },
        data: { status: 'running', pid: result.pid },
      });

      logActivity({
        type: 'start',
        level: 'success',
        message: `Environment '${env.name}' started on port ${env.port}`,
        projectId: id,
        projectName: env.project.name,
        envId,
        envName: env.name,
        detail: result.pid ? `pid: ${result.pid}` : undefined,
      });

      // Auto-start companion project (best-effort, never fails the parent request)
      const companionName = COMPANION_AUTO_START[env.project.name.toLowerCase()];
      let companionStarted: { name: string; ok: boolean; reason?: string } | null = null;
      if (companionName) {
        try {
          const companion = await db.project.findFirst({
            where: { name: companionName },
            include: { environments: true },
          });
          if (companion && companion.environments.length > 0) {
            const targetEnv = companion.environments[0];
            if (targetEnv) {
              const portActive = await checkPortStatus(targetEnv.port);
              if (!portActive) {
                let compEnvVars: Record<string, string> = {};
                try { compEnvVars = JSON.parse(targetEnv.envVars); } catch { /* ignore */ }
                const compResult = await startProcess(
                  companion.id,
                  targetEnv.name,
                  targetEnv.cmd,
                  companion.path,
                  compEnvVars,
                  targetEnv.port
                );
                if (compResult.success) {
                  await db.environment.update({
                    where: { id: targetEnv.id },
                    data: { status: 'running', pid: compResult.pid },
                  });
                  companionStarted = { name: companion.name, ok: true };
                } else {
                  companionStarted = { name: companion.name, ok: false, reason: compResult.error };
                }
              } else {
                companionStarted = { name: companion.name, ok: true, reason: 'already running' };
              }
            }
          } else {
            companionStarted = { name: companionName, ok: false, reason: 'not configured' };
          }
        } catch (e: any) {
          companionStarted = { name: companionName, ok: false, reason: e?.message || 'unknown' };
        }
      }

      return NextResponse.json({ ok: true, pid: result.pid, companionStarted });
    } else {
      await db.environment.update({
        where: { id: envId },
        data: { status: 'stopped', pid: null },
      });

      logActivity({
        type: 'error',
        level: 'error',
        message: `Environment '${env.name}' failed to start`,
        projectId: id,
        projectName: env.project.name,
        envId,
        envName: env.name,
        detail: result.error,
      });

      // Auto LLM repair: kick off a background repair job on failure.
      // Suppress with ?noRepair=1 (used by internal retries).
      let repair: { jobId: string; started: boolean } | undefined;
      if (_req.nextUrl.searchParams.get('noRepair') !== '1') {
        try {
          const jobId = startRepairJob({
            projectId: id,
            envId,
            kind: 'start',
            initialError: result.error || 'unknown error',
          });
          repair = { jobId, started: true };
        } catch {
          // repair is best-effort — never fail the request because of it
        }
      }
      return NextResponse.json({ ok: false, error: result.error, repair }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { startProcess, checkPortStatus } from '@/lib/process-manager';
import { isRemoteProject, proxyProjectAction } from '@/lib/route-decision';

// Companion projects that should be auto-started when the parent project starts.
const COMPANION_AUTO_START: Record<string, string> = {
  'hermes web': 'hermes bridge',
};

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; envId: string }> }
) {
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
      return NextResponse.json(result.data, { status: result.status });
    }

    // Local project → existing logic
    let envVars: Record<string, string> = {};
    try {
      envVars = JSON.parse(env.envVars);
    } catch {
      // ignore parse errors
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
      return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

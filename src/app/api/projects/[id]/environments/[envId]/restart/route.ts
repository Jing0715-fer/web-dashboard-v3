import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { restartProcess } from '@/lib/process-manager';
import { isRemoteProject, proxyProjectAction } from '@/lib/route-decision';
import { invalidateRemoteProjectCache } from '@/lib/remote-sync';
import { startRepairJob } from '@/lib/llm-repair';
import { logActivity } from '@/lib/activity';
import { requireApprovedUser } from '@/lib/auth';

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
        `/projects/${id}/environments/${envId}/restart`,
        'POST'
      );
      invalidateRemoteProjectCache();
      return NextResponse.json(result.data, { status: result.status });
    }

    // Local project → existing logic
    let envVars: Record<string, string> = {};
    try {
      envVars = JSON.parse(env.envVars);
    } catch {
      // ignore
    }

    const restartStartedAt = Date.now();
    const result = await restartProcess(
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
        type: 'restart',
        level: 'success',
        message: `Environment '${env.name}' restarted on port ${env.port}`,
        projectId: id,
        projectName: env.project.name,
        envId,
        envName: env.name,
        detail: result.pid ? `pid: ${result.pid}` : undefined,
        durationMs: Date.now() - restartStartedAt,
      });

      return NextResponse.json({ ok: true, pid: result.pid });
    } else {
      logActivity({
        type: 'error',
        level: 'error',
        message: `Environment '${env.name}' failed to restart`,
        projectId: id,
        projectName: env.project.name,
        envId,
        envName: env.name,
        detail: result.error,
      });

      // Auto LLM repair on restart failure
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
          // repair is best-effort
        }
      }
      return NextResponse.json({ ok: false, error: result.error, repair }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

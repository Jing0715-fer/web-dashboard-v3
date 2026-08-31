import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { restartProcess } from '@/lib/process-manager';
import { isRemoteProject, proxyProjectAction } from '@/lib/route-decision';
import { startRepairJob } from '@/lib/llm-repair';

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
        `/projects/${id}/environments/${envId}/restart`,
        'POST'
      );
      return NextResponse.json(result.data, { status: result.status });
    }

    // Local project → existing logic
    let envVars: Record<string, string> = {};
    try {
      envVars = JSON.parse(env.envVars);
    } catch {
      // ignore
    }

    const result = await restartProcess(
      id,
      env.name,
      env.cmd,
      env.project.path,
      envVars,
      env.port
    );

    if (result.success) {
      return NextResponse.json({ ok: true, pid: result.pid });
    } else {
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

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { stopProcess } from '@/lib/process-manager';
import { isRemoteProject, proxyProjectAction } from '@/lib/route-decision';

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
        `/projects/${id}/environments/${envId}/stop`,
        'POST'
      );
      return NextResponse.json(result.data, { status: result.status });
    }

    // Local project → existing logic
    const result = await stopProcess(id, env.name, env.port);

    // Update DB status
    await db.environment.update({
      where: { id: envId },
      data: { status: 'stopped', pid: null },
    });

    return NextResponse.json({ ok: result.success, error: result.error });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

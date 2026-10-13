import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { captureThumbnail } from '@/lib/thumbnail';
import { isRemoteProject } from '@/lib/route-decision';
import { requireApprovedUser } from '@/lib/auth';

// POST /api/projects/[id]/environments/[envId]/thumbnail — capture a live
// preview screenshot of a RUNNING environment, on demand.
//
// This is the manual counterpart of the automatic capture that fires after
// env start/restart/rebuild. Awaits the capture so the caller can toast the
// outcome (the port is normally already warm, so the wait is one probe).
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; envId: string }> }
) {
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

    // The process runs on the remote device — only its own agent could
    // screenshot it. The card UI hides the capture action for remote projects;
    // this guard keeps hand-crafted requests honest too.
    if (isRemoteProject(env.project)) {
      return NextResponse.json(
        { error: 'Thumbnails are captured on the device where the project runs' },
        { status: 400 },
      );
    }

    if (env.status !== 'running') {
      return NextResponse.json(
        { error: 'Start the environment first — thumbnails capture the live page' },
        { status: 409 },
      );
    }

    const result = await captureThumbnail({
      projectId: env.projectId,
      projectName: env.project.name,
      envId,
      envName: env.name,
      port: env.port,
      // Manual capture implies the user is looking at a running card — the
      // port should answer immediately, so keep the readiness budget short.
      skipReadinessWait: false,
    });

    if (result.ok) {
      return NextResponse.json({ ok: true, thumbnail: { file: result.file, capturedAt: result.capturedAt, bytes: result.bytes } });
    }
    return NextResponse.json({ ok: false, error: result.error, reason: result.reason }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

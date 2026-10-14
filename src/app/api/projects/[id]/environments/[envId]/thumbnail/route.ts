import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { captureThumbnail, remoteCaptureTargetUrls } from '@/lib/thumbnail';
import { isRemoteProject } from '@/lib/route-decision';
import { requireApprovedUser } from '@/lib/auth';

// POST /api/projects/[id]/environments/[envId]/thumbnail — capture a live
// preview screenshot of a RUNNING environment, on demand.
//
// This is the manual counterpart of the automatic capture that fires after
// env start/restart/rebuild. Awaits the capture so the caller can toast the
// outcome (the port is normally already warm, so the wait is one probe).
//
// v1.24: remote projects are captured too — the dashboard's headless
// Chromium loads the page through the device agent's HTTP proxy (which can
// reach even 127.0.0.1-bound dev servers on that machine), falling back to
// the direct device URL when the agent predates the proxy endpoint.
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
      include: { project: { include: { device: true } } },
    });
    if (!env) {
      return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    }
    if (env.projectId !== id) {
      return NextResponse.json({ error: 'Environment does not belong to this project' }, { status: 403 });
    }

    // ---- Remote project: capture through the device agent's proxy ----
    if (isRemoteProject(env.project)) {
      const device = env.project.device;
      if (!device) {
        return NextResponse.json(
          { error: 'The device this project runs on is unknown — re-pair it in the devices panel' },
          { status: 400 },
        );
      }
      if (device.status !== 'online') {
        return NextResponse.json(
          { error: 'The device is offline — thumbnails need its agent to reach the running page' },
          { status: 409 },
        );
      }
      // Remote env status comes from the agent's listing; a stale row can say
      // "stopped" while the process actually runs — trust the caller's card
      // (it renders live status) and let the readiness wait arbitrate.
      const targetUrls = remoteCaptureTargetUrls(device.ip, device.port, device.apiKey, env.port);
      const result = await captureThumbnail({
        projectId: env.projectId,
        projectName: env.project.name,
        envId,
        envName: env.name,
        port: env.port,
        targetUrls,
      });
      if (result.ok) {
        return NextResponse.json({ ok: true, thumbnail: { file: result.file, capturedAt: result.capturedAt, bytes: result.bytes } });
      }
      return NextResponse.json({ ok: false, error: result.error, reason: result.reason }, { status: 400 });
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

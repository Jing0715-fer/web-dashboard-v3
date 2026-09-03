import { NextRequest, NextResponse } from 'next/server';
import { requireApprovedUser } from '@/lib/auth';
import { applyRemoteAnalysis } from '@/lib/remote-apply';

/**
 * POST /api/mesh/apply-remote
 * Applies a completed remote auto-debug analysis on the remote device:
 * creates (or updates) the project and its environments via the agent API,
 * optionally starts the verified dev environment, then the dashboard's
 * project sync mirrors it locally.
 *
 * Thin wrapper over the shared lib (src/lib/remote-apply.ts) — the same
 * logic also runs server-side automatically when a remote analysis finishes
 * (src/lib/harness/auto-apply.ts).
 *
 * Body: { device: {id, ip, port, apiKey}, path, name, analysis, autoStart }
 */
export async function POST(req: NextRequest) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const body = await req.json();
    const { device, path: projectPath, name, analysis, autoStart } = body || {};
    if (!device?.ip || !device?.port || !device?.apiKey) {
      return NextResponse.json({ error: 'device config missing' }, { status: 400 });
    }
    if (!projectPath || !analysis?.environments?.length) {
      return NextResponse.json({ error: 'path and analysis are required' }, { status: 400 });
    }

    const outcome = await applyRemoteAnalysis({ device, path: projectPath, name, analysis, autoStart });
    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.error || 'Failed to apply on device' }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      projectId: outcome.projectId,
      started: outcome.started,
      environments: outcome.environments,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

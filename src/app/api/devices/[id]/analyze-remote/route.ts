import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { proxyToAgent } from '@/lib/remote-agent';
import { networkInterfaces } from 'os';
import { requireApprovedUser } from '@/lib/auth';
import { registerRemoteAutoApply, getAutoApplyOutcome } from '@/lib/harness/auto-apply';

/**
 * Remote project auto-debug analysis — proxies to the device agent's
 * analyze-project endpoint, supplying this dashboard's in-process LLM
 * gateway URL (same port as the dashboard itself) so the remote device
 * needs no LLM credentials of its own.
 *
 *   POST /api/devices/[id]/analyze-remote  {path, name, usedPorts?}  → {jobId}
 *   GET  /api/devices/[id]/analyze-remote?jobId=...                  → job status
 *
 * Every started job is registered with the server-side auto-apply watcher:
 * when the remote analysis completes, the project + verified environments
 * are created on the device automatically (no auto-start — that stays a user
 * decision). Closing the dialog / reloading before clicking "add" can no
 * longer lose the remote result. The GET response is enriched with `applied`
 * so the dialog can render the auto-saved state.
 */

function getLanIp(): string {
  for (const lists of Object.values(networkInterfaces())) {
    for (const ni of lists ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const { id } = await params;
    const device = await db.device.findUnique({ where: { id } });
    if (!device) return NextResponse.json({ error: 'Device not found' }, { status: 404 });

    const body = await req.json();
    if (!body?.path) return NextResponse.json({ error: 'path is required' }, { status: 400 });

    const usedPorts = Array.isArray(body.usedPorts) ? body.usedPorts : [];
    // In-process gateway lives on the dashboard port itself (formerly :3021).
    const llmBaseUrl = `http://${getLanIp()}:3000/api/llm/v1`;

    const result = await proxyToAgent(
      { ip: device.ip, port: device.port, apiKey: device.apiKey },
      '/analyze-project',
      'POST',
      { path: body.path, name: body.name, llmBaseUrl, usedPorts: [...usedPorts, 3000, 3100] }
    );
    if (!result.ok) {
      return NextResponse.json({ error: result.data?.error || `Agent returned ${result.status}` }, { status: 502 });
    }

    // Register for server-side auto-apply when the remote job completes.
    if (result.data?.jobId) {
      const registered = await registerRemoteAutoApply(
        String(result.data.jobId),
        id,
        String(body.path),
        body.name ? String(body.name) : undefined,
      );
      return NextResponse.json({ ...result.data, autoApply: registered ? 'registered' : 'unavailable' });
    }
    return NextResponse.json(result.data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const { id } = await params;
    const jobId = req.nextUrl.searchParams.get('jobId');
    if (!jobId) return NextResponse.json({ error: 'jobId is required' }, { status: 400 });

    const device = await db.device.findUnique({ where: { id } });
    if (!device) return NextResponse.json({ error: 'Device not found' }, { status: 404 });

    const result = await proxyToAgent(
      { ip: device.ip, port: device.port, apiKey: device.apiKey },
      `/analyze-project/${jobId}`,
      'GET'
    );
    if (!result.ok) {
      return NextResponse.json({ error: result.data?.error || `Agent returned ${result.status}` }, { status: 502 });
    }
    const data = result.data ?? {};
    const applied = getAutoApplyOutcome(jobId);
    if (applied !== undefined) (data as any).applied = applied;
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

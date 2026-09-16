import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { proxyToAgent } from '@/lib/remote-agent';
import { networkInterfaces } from 'os';
import { requireApprovedUser } from '@/lib/auth';
import { probeRemoteAgentHealth } from '@/lib/agent-health';
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
 *
 * Error contract (beyond plain HTTP errors): failures the UI can render a
 * dedicated message for carry a machine `code` —
 *   AGENT_ANALYZE_UNSUPPORTED  the agent answered but has no analyze-project
 *                              endpoint (pre-1.14 TS agents / old packages);
 *                              `agentVersion` says what is running.
 *   JOB_NOT_FOUND              the job vanished (agent restarted / GC) — the
 *                              dialog stops polling and offers a restart.
 */

function getLanIp(): string {
  for (const lists of Object.values(networkInterfaces())) {
    for (const ni of lists ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

/** The in-process LLM gateway lives on the dashboard's own port. Deriving it
 * from the request's Host header (with a process.env.PORT fallback) keeps
 * remote analysis working when the dashboard doesn't run on the default
 * :3000 — the old hardcode pointed remote agents at a dead port. */
function getGatewayBaseUrl(req: NextRequest): string {
  let port = process.env.PORT ? String(parseInt(process.env.PORT, 10) || 3000) : '3000';
  try {
    const host = req.headers.get('host') || '';
    const m = host.match(/:(\d+)$/);
    if (m) port = m[1];
  } catch { /* keep fallback */ }
  return `http://${getLanIp()}:${port}/api/llm/v1`;
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
    const llmBaseUrl = getGatewayBaseUrl(req);

    const result = await proxyToAgent(
      { ip: device.ip, port: device.port, apiKey: device.apiKey },
      '/analyze-project',
      'POST',
      { path: body.path, name: body.name, llmBaseUrl, usedPorts: [...usedPorts, 3000, 3100] }
    );
    if (!result.ok) {
      // 404 from the agent = the endpoint doesn't exist on that process:
      // the device runs a pre-1.14 TS agent (the reference variant didn't
      // ship analyze-project until v1.14) or a stale downloaded package.
      // A bare "Not found" told the user nothing — probe the agent's health
      // (no auth, 60s-cached) for its running version and say what to do.
      if (result.status === 404) {
        const probe = await probeRemoteAgentHealth(device);
        const agentVersion = probe.version || null;
        const error = probe.reachable && agentVersion
          ? `The agent on ${device.name} (v${agentVersion}) does not support remote project analysis — it needs the analyze endpoint introduced in agent v1.14. Update the agent on that device (in the project directory: git pull, then restart the agent; or re-download the package from the Devices panel) and retry.`
          : `The agent on ${device.name} did not recognize the analysis request (HTTP 404) and its version could not be determined. Make sure a current Dashboard Agent is running on that device's ip:port, update it, and retry.`;
        return NextResponse.json(
          { error, code: 'AGENT_ANALYZE_UNSUPPORTED', agentVersion },
          { status: 502 },
        );
      }
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
      // A missing job is terminal — most often the device agent restarted
      // (jobs are in-memory) or aged out of the 1h GC. Retrying the same
      // jobId can never succeed, so tell the dialog to stop polling.
      if (result.status === 404) {
        return NextResponse.json(
          {
            error: 'The analysis job no longer exists on the device — the agent most likely restarted. Start the analysis again.',
            code: 'JOB_NOT_FOUND',
          },
          { status: 502 },
        );
      }
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

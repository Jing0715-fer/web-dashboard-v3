import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { listGitBranches } from '@/lib/git-branches';
import { requireApprovedUser } from '@/lib/auth';
import { proxyProjectAction } from '@/lib/route-decision';
import { probeRemoteAgentHealth } from '@/lib/agent-health';

/**
 * GET /api/projects/:id/branches[?fetch=1] — branch list for the
 * switch-branch picker.
 *
 * Local project: reads the checkout here (`git for-each-ref` over local +
 * origin/* refs; `?fetch=1` runs `git fetch --prune` first so freshly pushed
 * branches appear).
 *
 * Remote project: proxies to the device agent's
 * GET /api/agent/projects/:id/branches — the checkout lives on that machine.
 * Legacy agents without the endpoint answer 404, reported as an actionable
 * "update the agent on that machine" error (same contract as pull).
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;

  try {
    const { id } = await ctx.params;
    const fetch = new URL(req.url).searchParams.get('fetch') === '1';

    const project = await db.project.findUnique({ where: { id } });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Remote project → the agent runs git on that machine.
    if (project.deviceId) {
      const result = await proxyProjectAction(
        project.deviceId,
        `/projects/${id}/branches${fetch ? '?fetch=1' : ''}`,
        'GET',
      );
      if (result.ok) {
        return NextResponse.json(result.data, { status: 200 });
      }
      if (result.data?.error === 'Device not found') {
        return NextResponse.json(
          { error: 'This project points at a device that no longer exists on this dashboard' },
          { status: 404 },
        );
      }
      if (result.status === 404) {
        let running = '';
        try {
          const device = await db.device.findUnique({ where: { id: project.deviceId } });
          if (device) {
            const h = await probeRemoteAgentHealth({ id: device.id, ip: device.ip, port: device.port });
            if (h.version) running = ` — its agent reports v${h.version}`;
          }
        } catch { /* best-effort */ }
        return NextResponse.json(
          {
            error: `This device agent is too old to list branches${running} — on that machine: git pull the repo, then RESTART the agent`,
          },
          { status: 502 },
        );
      }
      return NextResponse.json(
        { error: result.data?.error || 'Failed to list branches' },
        { status: result.status },
      );
    }

    // Local project.
    const list = await listGitBranches(project.path, fetch);
    if (list.error && list.branches.length === 0) {
      return NextResponse.json({ error: list.error }, { status: 400 });
    }
    return NextResponse.json(list, { status: 200 });
  } catch (e: any) {
    return NextResponse.json(
      { error: 'Branch list failed', detail: String(e?.message || e).slice(0, 400) },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  checkLocalRepoUpdate,
  checkRemoteRepoUpdate,
  type RepoUpdateStatus,
} from '@/lib/git-update-check';
import { proxyToAgent } from '@/lib/remote-agent';
import { requireApprovedUser } from '@/lib/auth';

/**
 * GET /api/projects/updates — batch remote-repository freshness check.
 *
 * Called by the dashboard once after load, then every 10 minutes. Each
 * project's result is one of current / behind / ahead / diverged / differs /
 * unknown (see lib/git-update-check.ts). Cards render an "update available"
 * hint for behind / diverged / differs; everything else degrades silently:
 *
 *  - local projects: `git ls-remote --symref` + `git fetch` into FETCH_HEAD +
 *    `rev-list --count` → precise behind/ahead numbers
 *  - device projects: one GET /api/agent/versions proxy per device, then the
 *    agent-reported SHA is compared with the remote HEAD (direction unknown —
 *    'differs'); agents without /versions or offline devices yield 'unknown'
 *  - results are cached 5 minutes in-process; `?refresh=1` (sent right after
 *    a pull) bypasses the cache so stale "behind" hints disappear immediately
 */
export async function GET(req: NextRequest) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;

  const refresh = req.nextUrl.searchParams.get('refresh') === '1';

  try {
    const projects = await db.project.findMany({
      select: { id: true, path: true, deviceId: true, repoUrl: true },
    });
    const updates: Record<string, RepoUpdateStatus | null> = {};

    // Projects without a repo URL get `null` — the card simply has nothing
    // to check (the repo row shows the "connect repo" CTA instead).
    for (const p of projects) {
      if (!p.repoUrl) updates[p.id] = null;
    }

    // 1) Local projects — parallel ls-remote + fetch + rev-list.
    const local = projects.filter((p) => p.repoUrl && !p.deviceId);
    await Promise.all(
      local.map(async (p) => {
        updates[p.id] = await checkLocalRepoUpdate(p.id, p.path, p.repoUrl!, refresh);
      }),
    );

    // 2) Device projects — one /versions proxy per device, then compare each
    //    reported checkout SHA against the remote HEAD.
    const remote = projects.filter((p) => p.repoUrl && p.deviceId);
    if (remote.length > 0) {
      const devices = await db.device.findMany({
        select: { id: true, ip: true, port: true, apiKey: true },
      });
      const byDevice = new Map(devices.map((d) => [d.id, d]));
      const deviceIds = [...new Set(remote.map((p) => p.deviceId!))];

      await Promise.all(
        deviceIds.map(async (deviceId) => {
          const device = byDevice.get(deviceId);
          const onDevice = remote.filter((x) => x.deviceId === deviceId);
          if (!device) {
            for (const p of onDevice) {
              updates[p.id] = { state: 'unknown', behind: null, ahead: null, remoteSha: null, checkedAt: new Date().toISOString(), error: 'device not found' };
            }
            return;
          }
          const result = await proxyToAgent(
            { ip: device.ip, port: device.port, apiKey: device.apiKey },
            '/versions',
            'GET',
            undefined,
            10000,
          );
          if (result.ok && result.data?.versions) {
            const agentVersions = result.data.versions as Record<string, { sha?: string } | null>;
            await Promise.all(
              onDevice.map(async (p) => {
                const sha = agentVersions[p.id]?.sha;
                updates[p.id] =
                  typeof sha === 'string' && sha.trim()
                    ? await checkRemoteRepoUpdate(p.id, p.repoUrl!, sha, refresh)
                    : { state: 'unknown', behind: null, ahead: null, remoteSha: null, checkedAt: new Date().toISOString(), error: 'agent reported no version' };
              }),
            );
          } else {
            // Agent offline or predates /versions — no hint, no error.
            for (const p of onDevice) {
              updates[p.id] = { state: 'unknown', behind: null, ahead: null, remoteSha: null, checkedAt: new Date().toISOString(), error: 'agent unreachable' };
            }
          }
        }),
      );
    }

    return NextResponse.json({ updates });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

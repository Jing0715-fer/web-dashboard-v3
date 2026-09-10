import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readGitVersion, type GitVersionMap } from '@/lib/git-version';
import { proxyToAgent } from '@/lib/remote-agent';
import { requireApprovedUser } from '@/lib/auth';

/**
 * GET /api/projects/versions — batch git version snapshot for ALL projects.
 *
 * Cards call this ONCE (not per project): local projects are read in
 * parallel; remote projects are grouped by device so each agent gets a
 * single GET /api/agent/versions request. Agents that predate the version
 * endpoint (404) simply yield `null` entries — cards hide the version chip
 * instead of erroring.
 */
export async function GET(req: NextRequest) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;

  try {
    const projects = await db.project.findMany({
      select: { id: true, path: true, deviceId: true },
    });
    const versions: GitVersionMap = {};

    // 1) Local projects — parallel git reads.
    const local = projects.filter((p) => !p.deviceId);
    await Promise.all(
      local.map(async (p) => {
        versions[p.id] = await readGitVersion(p.path);
      }),
    );

    // 2) Remote projects — ONE proxy call per device.
    const remote = projects.filter((p) => p.deviceId);
    if (remote.length > 0) {
      const devices = await db.device.findMany({
        select: { id: true, ip: true, port: true, apiKey: true },
      });
      const byDevice = new Map(devices.map((d) => [d.id, d]));
      const deviceIds = [...new Set(remote.map((p) => p.deviceId!))];

      await Promise.all(
        deviceIds.map(async (deviceId) => {
          const device = byDevice.get(deviceId);
          if (!device) return;
          const result = await proxyToAgent(
            { ip: device.ip, port: device.port, apiKey: device.apiKey },
            '/versions',
            'GET',
            undefined,
            10000,
          );
          if (result.ok && result.data?.versions) {
            for (const p of remote.filter((x) => x.deviceId === deviceId)) {
              const v = (result.data.versions as GitVersionMap)[p.id];
              versions[p.id] = v === undefined ? null : v;
            }
          } else {
            // Agent offline or legacy (no /versions endpoint) — no version
            // info, but the repo row still renders from the cached repoUrl.
            for (const p of remote.filter((x) => x.deviceId === deviceId)) {
              versions[p.id] = null;
            }
          }
        }),
      );
    }

    return NextResponse.json({ versions });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { listListeningPorts, type OwnedPortEntry } from '@/lib/ports';
import { requireApprovedUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/ports — live inventory of every listening TCP port with the owning
 * process (pid, command) and, when known, which dashboard environment the
 * port belongs to. Powers the Ports panel.
 */
export async function GET(req: NextRequest) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const [entries, envs] = await Promise.all([
      listListeningPorts(),
      db.environment.findMany({ include: { project: { select: { id: true, name: true, deviceId: true } } } }),
    ]);

    // Local envs: port → owner. Remote envs keep their port mapping too — the
    // panel flags them as remote so the user knows the process lives on
    // another machine and cannot be killed from here.
    const ownerByPort = new Map<number, OwnedPortEntry['owner']>();
    for (const env of envs) {
      if (!ownerByPort.has(env.port)) {
        ownerByPort.set(env.port, {
          projectId: env.project.id,
          projectName: env.project.name,
          envId: env.id,
          envName: env.name,
          remote: env.project.deviceId != null,
        });
      }
    }

    const reserved = new Set<number>([3000]);
    const p = parseInt(process.env.PORT || '', 10);
    if (Number.isFinite(p) && p > 0) reserved.add(p);

    const ports: OwnedPortEntry[] = entries.map((e) => ({
      ...e,
      owner: ownerByPort.get(e.port) ?? null,
      reserved: reserved.has(e.port),
    }));

    return NextResponse.json({ ports, count: ports.length });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message || 'Failed to list ports' }, { status: 500 });
  }
}

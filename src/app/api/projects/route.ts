import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { enrichEnvStatuses } from '@/lib/env-status';
import { getRemoteProjectsCached } from '@/lib/remote-sync';
import { logActivity } from '@/lib/activity';
import { requireApprovedUser } from '@/lib/auth';

// GET /api/projects - List all projects with environments and status
// Aggregates local projects (deviceId=null) and remote projects from devices
export async function GET(req: Request) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    // 1. Get local projects (deviceId = null)
    const localProjects = await db.project.findMany({
      where: { deviceId: null },
      include: { environments: true },
      orderBy: [{ order: 'asc' }, { updatedAt: 'desc' }],
    });

    // P1-4: enrich + reconcile DB status with actual port state in one ss call.
    // Stale "running" rows (DB says running but port not listening) get cleared.
    const localEnvs = await enrichEnvStatuses(
      localProjects.flatMap((p) => p.environments)
    );
    const localEnvsById = new Map(localEnvs.map((e) => [e.id, e]));

    const enrichedLocal = localProjects.map((project) => ({
      ...project,
      deviceName: null,
      deviceId: null,
      deviceStatus: null,
      environments: project.environments.map((env) => {
        const reconciled = localEnvsById.get(env.id);
        return reconciled ? { ...env, status: reconciled.status } : env;
      }),
    }));

    // 2. Remote projects: served from the SWR sync cache (see
    //    src/lib/remote-sync.ts). This call never blocks on unreachable
    //    devices beyond the short probe budgets — a hanging agent can no
    //    longer stall the whole dashboard list. `?fresh=1` (manual refresh
    //    button) bypasses the cache and forces a real agent sync.
    const forceSync = new URL(req.url).searchParams.get('fresh') === '1';
    const dedupedRemote = await getRemoteProjectsCached(forceSync);

    // 3. Include projects in local DB that have a deviceId (cached remote
    //    projects for devices that were offline / unreachable on this
    //    request).
    //
    // Dedupe key is `deviceId+path` instead of just `id`: when the Windows agent
    // regenerates a project's ID (e.g. on first registration, or after a path
    // change), the new ID lands in `enrichedRemote` while the old ID is still
    // sitting in the local DB. Filtering by ID alone would leak the stale row
    // as a duplicate card (the "two Foundry UI" bug). Filtering by path
    // collapses both rows into one canonical entry — the live one wins.
    const liveKeys = new Set(
      dedupedRemote.map((p: any) => `${p.deviceId}::${p.path}`)
    );
    const allCachedRemoteProjects = await db.project.findMany({
      where: { deviceId: { not: null } },
      include: { environments: true, device: true },
    });
    const cachedRemoteProjects = allCachedRemoteProjects.filter(
      (p) => !liveKeys.has(`${p.deviceId}::${p.path}`)
    );

    // Bug #3 fix (revised): cached remotes used to run a LOCAL port probe on
    // their environments — but the processes run on the remote host, so the
    // local probe always came back "not listening" and wrongly flipped
    // genuinely-running remote envs to "stopped" (and rewrote the DB row).
    // For a device we currently can't reach, we simply report the cached
    // status as-is; the next successful agent sync will correct it.
    const cachedRemotes = cachedRemoteProjects.map(project => ({
      ...project,
      deviceName: project.device?.name || 'Unknown Device',
      deviceIp: project.device?.ip || 'localhost',
      deviceStatus: project.device?.status || 'offline',
      environments: project.environments.map((env) => ({
        ...env,
        status: env.status || 'stopped',
      })),
    }));

    // 5. Combine and return
    return NextResponse.json({ projects: [...enrichedLocal, ...dedupedRemote, ...cachedRemotes] });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/projects - Create a new project (local or remote)
export async function POST(req: NextRequest) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const body = await req.json();
    const { path, name, description, icon, deviceId } = body;

    if (!path) {
      return NextResponse.json({ error: 'Project path is required' }, { status: 400 });
    }

    // Extract name from path if not provided
    const projectName = name || path.split('/').filter(Boolean).pop() || 'Untitled';

    const project = await db.project.create({
      data: {
        name: projectName,
        path,
        description: description || '',
        icon: icon || 'folder',
        deviceId: deviceId || null,
      },
      include: { environments: true },
    });

    logActivity({
      type: 'create',
      level: 'success',
      message: `Project '${project.name}' created`,
      projectId: project.id,
      projectName: project.name,
      detail: `path: ${project.path}`,
    });

    return NextResponse.json({ project }, { status: 201 });
  } catch (e: any) {
    if (e.code === 'P2002') {
      return NextResponse.json({ error: 'A project with this path already exists on this device' }, { status: 409 });
    }
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { enrichEnvStatuses } from '@/lib/env-status';
import { fetchRemoteProjects, type RemoteAgentConfig } from '@/lib/remote-agent';

// GET /api/projects - List all projects with environments and status
// Aggregates local projects (deviceId=null) and remote projects from devices
export async function GET() {
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

    // 2. Get remote projects from devices (try all non-offline devices, plus offline ones with a shorter timeout)
    const devices = await db.device.findMany();
    const remoteResults = await Promise.allSettled(
      devices.map(async (device) => {
        try {
          const config: RemoteAgentConfig = { ip: device.ip, port: device.port, apiKey: device.apiKey };
          const projects = await fetchRemoteProjects(config);
          
          // If we got projects, mark device as online
          if (projects.length > 0 && device.status !== 'online') {
            await db.device.update({
              where: { id: device.id },
              data: { status: 'online', lastSeen: new Date() },
            }).catch(() => {});
          }
          
          return projects.map((p: any) => ({
            ...p,
            deviceId: device.id,
            deviceName: device.name,
            deviceIp: device.ip,
            deviceStatus: 'online' as const,
            environments: (p.environments || []).map((e: any) => ({
              ...e,
              status: e.status || 'stopped',
            })),
          }));
        } catch {
          // Device unreachable - return empty with offline status
          if (device.status !== 'offline') {
            await db.device.update({
              where: { id: device.id },
              data: { status: 'offline' },
            }).catch(() => {});
          }
          return [];
        }
      })
    );

    const enrichedRemote = remoteResults.flatMap(r => r.status === 'fulfilled' ? r.value : []);

    // Dedupe live remote projects by (deviceId, path). The Windows agent
    // occasionally returns the same project twice — usually because the
    // agent's local project registry has two rows for the same path
    // (e.g. one from a stale manual registration + one from the auto-scan).
    // Without this, the dashboard would render two cards for one project.
    //
    // Tiebreaker: when collapsing, prefer the row that carries
    // environments. If both have none, first-wins. We also drop rows
    // missing deviceId/path because they cannot be uniquely addressed
    // for control actions.
    const remoteByKey = new Map<string, any>();
    for (const p of enrichedRemote as any[]) {
      if (!p.deviceId || !p.path) continue;
      const key = `${p.deviceId}::${p.path}`;
      const existing = remoteByKey.get(key);
      if (!existing) {
        remoteByKey.set(key, p);
        continue;
      }
      const existingHasEnv = (existing.environments?.length ?? 0) > 0;
      const incomingHasEnv = (p.environments?.length ?? 0) > 0;
      if (incomingHasEnv && !existingHasEnv) {
        remoteByKey.set(key, p);
      }
    }
    const dedupedRemote = Array.from(remoteByKey.values());

    // 3. Persist live remote projects to local DB so start/stop routes can find them.
    //    Use the agent's own id/deviceId so subsequent requests resolve the same rows.
    for (const remote of dedupedRemote) {
      try {
        const envData = (remote.environments || []).map((e: any) => ({
          id: e.id,
          projectId: remote.id,
          name: e.name,
          cmd: e.cmd,
          port: e.port,
          envVars: typeof e.envVars === 'string' ? e.envVars : JSON.stringify(e.envVars || {}),
          status: e.status || 'stopped',
          pid: e.pid ?? null,
        }));
        // P2-1: wrap upsert + delete-then-create in a single transaction so a
        // concurrent GET can't see an empty environments array mid-sync.
        await db.$transaction(async (tx) => {
          await tx.project.upsert({
            where: { id: remote.id },
            update: {
              name: remote.name,
              path: remote.path,
              description: remote.description || '',
              icon: remote.icon || 'folder',
              tags: typeof remote.tags === 'string' ? remote.tags : JSON.stringify(remote.tags || []),
              deviceId: remote.deviceId,
            },
            create: {
              id: remote.id,
              name: remote.name,
              path: remote.path,
              description: remote.description || '',
              icon: remote.icon || 'folder',
              tags: typeof remote.tags === 'string' ? remote.tags : JSON.stringify(remote.tags || []),
              deviceId: remote.deviceId,
              order: remote.order ?? 0,
            },
          });
          // Sync environments: delete-then-create keeps them aligned with the agent.
          await tx.environment.deleteMany({ where: { projectId: remote.id } });
          if (envData.length > 0) {
            await tx.environment.createMany({ data: envData });
          }
        });
      } catch (e) {
        // best-effort: don't fail the GET if a single remote project fails to persist
        console.error('Failed to persist remote project', remote.id, e);
      }
    }

    // 4. Also include projects in local DB that have a deviceId (cached remote projects
    //    for devices that were offline / not reachable on this request).
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

    // Bug #3 fix: cached remotes had no port-state reconciliation, so a
    // process that died on the device left a stale "running" row in our DB
    // forever (visible to the user as a permanently-running project that
    // never restarts). Run the same enrich pass as for local projects —
    // `enrichEnvStatuses` will clear stale running rows when the port is
    // not actually listening. For remote devices we can't kill the
    // process from here (it's on the other host), so we just report
    // reality and trust the next agent sync to re-create the row if it
    // really is still running.
    const cachedRemoteEnvs = await enrichEnvStatuses(
      cachedRemoteProjects.flatMap((p) => p.environments)
    );
    const cachedEnvsById = new Map(cachedRemoteEnvs.map((e) => [e.id, e]));

    const cachedRemotes = cachedRemoteProjects
      .map(project => ({
        ...project,
        deviceName: project.device?.name || 'Unknown Device',
        deviceIp: project.device?.ip || 'localhost',
        deviceStatus: project.device?.status || 'offline',
        environments: project.environments.map((env) => {
          const reconciled = cachedEnvsById.get(env.id);
          return reconciled ? { ...env, status: reconciled.status } : { ...env, status: env.status || 'stopped' };
        }),
      }));

    // 5. Combine and return
    return NextResponse.json({ projects: [...enrichedLocal, ...dedupedRemote, ...cachedRemotes] });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/projects - Create a new project (local or remote)
export async function POST(req: NextRequest) {
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

    return NextResponse.json({ project }, { status: 201 });
  } catch (e: any) {
    if (e.code === 'P2002') {
      return NextResponse.json({ error: 'A project with this path already exists on this device' }, { status: 409 });
    }
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

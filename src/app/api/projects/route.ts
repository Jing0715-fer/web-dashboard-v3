import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { batchCheckPorts } from '@/lib/process-manager';
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

    // Batch check all local ports at once for efficiency
    const allPorts = localProjects.flatMap(p => p.environments.map(e => e.port));
    const activePorts = await batchCheckPorts(allPorts);

    // Enrich local projects with running status
    const enrichedLocal = localProjects.map((project) => ({
      ...project,
      deviceName: null,
      deviceId: null,
      deviceStatus: null,
      environments: project.environments.map((env) => ({
        ...env,
        status: activePorts.has(env.port) ? 'running' : 'stopped',
      })),
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

    // 3. Also include projects in local DB that have a deviceId (cached remote projects)
    const cachedRemoteProjects = await db.project.findMany({
      where: { deviceId: { not: null } },
      include: { environments: true, device: true },
    });

    // Add cached remote projects that weren't fetched from live agents
    const liveDeviceIds = new Set(enrichedRemote.map(p => p.deviceId));
    const cachedRemotes = cachedRemoteProjects
      .filter(p => !liveDeviceIds.has(p.deviceId))
      .map(project => ({
        ...project,
        deviceName: project.device?.name || 'Unknown Device',
        deviceStatus: project.device?.status || 'offline',
        environments: project.environments.map((env) => ({
          ...env,
          status: env.status || 'stopped',
        })),
      }));

    // 4. Combine and return
    return NextResponse.json({ projects: [...enrichedLocal, ...enrichedRemote, ...cachedRemotes] });
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

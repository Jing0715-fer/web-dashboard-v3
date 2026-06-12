import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { batchCheckPorts } from '@/lib/process-manager';
import { SELF_PROJECT_PATHS } from '@/lib/self-guard';
import { fetchRemoteProjects, type RemoteAgentConfig } from '@/lib/remote-agent';

// GET /api/projects - List all projects with environments and status
// Aggregates local projects (deviceId=null) and remote projects from online devices
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

    // 2. Get remote projects from online devices
    const devices = await db.device.findMany({ where: { status: 'online' } });
    const remoteResults = await Promise.allSettled(
      devices.map(async (device) => {
        const config: RemoteAgentConfig = { ip: device.ip, port: device.port, apiKey: device.apiKey };
        const projects = await fetchRemoteProjects(config);
        return projects.map((p: any) => ({
          ...p,
          deviceId: device.id,
          deviceName: device.name,
          deviceStatus: device.status,
          environments: (p.environments || []).map((e: any) => ({
            ...e,
            status: e.status || 'stopped', // Agent provides its own status
          })),
        }));
      })
    );

    const enrichedRemote = remoteResults.flatMap(r => r.status === 'fulfilled' ? r.value : []);

    // 3. Combine and return
    return NextResponse.json({ projects: [...enrichedLocal, ...enrichedRemote] });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/projects - Create a new project (local only)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { path, name, description, icon } = body;

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
        deviceId: null, // Local project
      },
      include: { environments: true },
    });

    return NextResponse.json({ project }, { status: 201 });
  } catch (e: any) {
    if (e.code === 'P2002') {
      return NextResponse.json({ error: 'A project with this path already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

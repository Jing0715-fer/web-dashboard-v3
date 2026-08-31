import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isRemoteProject, proxyProjectAction } from '@/lib/route-decision';

// POST /api/projects/[id]/duplicate - Duplicate a project with all its environments
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const project = await db.project.findUnique({
      where: { id },
      include: { environments: true, device: true },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Remote project → proxy to agent
    if (isRemoteProject(project)) {
      const result = await proxyProjectAction(
        project.deviceId!,
        `/projects/${id}/duplicate`,
        'POST'
      );
      return NextResponse.json(result.data, { status: result.status });
    }

    // Local project → duplicate
    const newName = `${project.name} (Copy)`;
    const newPath = project.path + '-copy';

    // Check if a project with the new path already exists on this device
    const existing = await db.project.findFirst({
      where: { path: newPath, deviceId: project.deviceId },
    });
    if (existing) {
      return NextResponse.json(
        { error: 'A duplicated project already exists at this path' },
        { status: 409 }
      );
    }

    // Create the duplicated project
    const duplicated = await db.project.create({
      data: {
        name: newName,
        path: newPath,
        description: project.description,
        icon: project.icon,
        tags: project.tags,
        deviceId: project.deviceId,
        environments: {
          create: project.environments.map((env) => ({
            name: env.name,
            cmd: env.cmd,
            port: env.port,
            envVars: env.envVars,
            status: 'stopped',
          })),
        },
      },
      include: { environments: true },
    });

    return NextResponse.json({ project: duplicated }, { status: 201 });
  } catch (e: any) {
    if (e.code === 'P2002') {
      return NextResponse.json(
        { error: 'A project with this path already exists' },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

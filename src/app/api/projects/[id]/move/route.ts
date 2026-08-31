import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { stopProcess, batchCheckPorts } from '@/lib/process-manager';

// POST /api/projects/[id]/move - Move a project to a different device
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { targetDeviceId } = body; // null = local, string = device ID

    const project = await db.project.findUnique({
      where: { id },
      include: { environments: true, device: true },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Only allow moving local projects (remote project management is via agent)
    if (project.deviceId !== null) {
      return NextResponse.json(
        { error: 'Cannot move remote projects. Use the remote agent directly.' },
        { status: 400 }
      );
    }

    // Validate target device exists if specified
    if (targetDeviceId !== null) {
      const device = await db.device.findUnique({ where: { id: targetDeviceId } });
      if (!device) {
        return NextResponse.json({ error: 'Target device not found' }, { status: 404 });
      }
    }

    // Stop all running environments before moving
    const ports = project.environments.map(e => e.port);
    const activePorts = await batchCheckPorts(ports);
    for (const env of project.environments) {
      if (activePorts.has(env.port)) {
        await stopProcess(id, env.name, env.port);
      }
    }

    // Move the project to the target device
    const moved = await db.project.update({
      where: { id },
      data: {
        deviceId: targetDeviceId,
        // Reset all environment statuses to stopped after move
        environments: {
          updateMany: {
            where: { projectId: id },
            data: { status: 'stopped', pid: null },
          },
        },
      },
      include: { environments: true, device: true },
    });

    const enriched = {
      ...moved,
      deviceName: moved.device?.name || null,
      deviceStatus: moved.device?.status || null,
      environments: moved.environments.map((env) => ({
        ...env,
        status: 'stopped' as const,
      })),
    };

    return NextResponse.json({ project: enriched });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

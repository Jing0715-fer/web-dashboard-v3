import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { stopProcess } from '@/lib/process-manager';
import { isRemoteProject, proxyProjectAction } from '@/lib/route-decision';

// PUT /api/projects/[id]/environments/[envId]
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; envId: string }> }
) {
  try {
    const { id, envId } = await params;
    const body = await req.json();

    const existing = await db.environment.findUnique({
      where: { id: envId },
      include: { project: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    }
    if (existing.projectId !== id) {
      return NextResponse.json({ error: 'Environment does not belong to this project' }, { status: 403 });
    }

    // Remote project → proxy to agent
    if (isRemoteProject(existing.project)) {
      const result = await proxyProjectAction(
        existing.project.deviceId!,
        `/projects/${id}/environments/${envId}`,
        'PUT',
        body
      );
      return NextResponse.json(result.data, { status: result.status });
    }

    // Local project → existing logic
    const { name, cmd, port, envVars } = body;
    const portNum = port !== undefined ? parseInt(String(port), 10) : undefined;
    if (portNum !== undefined && (isNaN(portNum) || portNum < 1 || portNum > 65535)) {
      return NextResponse.json({ error: 'Port must be between 1 and 65535' }, { status: 400 });
    }

    // Block reserved ports
    if (portNum !== undefined) {
      const reservedPorts = new Set<number>([
        3000,
        ...(process.env.RESERVED_PORTS?.split(',').map(p => parseInt(p.trim(), 10)).filter(n => !isNaN(n)) ?? []),
      ]);
      if (reservedPorts.has(portNum)) {
        return NextResponse.json(
          { error: `Port ${portNum} is reserved (cannot bind a project to the dashboard's own port). ` +
                    `Use a different port, e.g. 4000-4999.` },
          { status: 400 }
        );
      }
    }

    const environment = await db.environment.update({
      where: { id: envId },
      data: {
        ...(name !== undefined && { name }),
        ...(cmd !== undefined && { cmd }),
        ...(port !== undefined && { port: parseInt(String(port), 10) }),
        ...(envVars !== undefined && { envVars: JSON.stringify(envVars) }),
      },
    });

    return NextResponse.json({ environment });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// DELETE /api/projects/[id]/environments/[envId]
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; envId: string }> }
) {
  try {
    const { id, envId } = await params;

    const existing = await db.environment.findUnique({
      where: { id: envId },
      include: { project: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    }
    if (existing.projectId !== id) {
      return NextResponse.json({ error: 'Environment does not belong to this project' }, { status: 403 });
    }

    // Remote project → proxy to agent
    if (isRemoteProject(existing.project)) {
      const result = await proxyProjectAction(
        existing.project.deviceId!,
        `/projects/${id}/environments/${envId}`,
        'DELETE'
      );
      return NextResponse.json(result.data, { status: result.status });
    }

    // Local project → existing logic
    // Stop the process if running
    await stopProcess(id, existing.name, existing.port);

    await db.environment.delete({ where: { id: envId } });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

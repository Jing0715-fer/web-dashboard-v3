import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// POST /api/projects/[id]/environments - Add environment
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { name, cmd, port, envVars } = body;

    if (!name || !cmd || !port) {
      return NextResponse.json(
        { error: 'name, cmd, and port are required' },
        { status: 400 }
      );
    }

    // Check project exists
    const project = await db.project.findUnique({ where: { id } });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const portNum = parseInt(String(port), 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return NextResponse.json({ error: 'Port must be between 1 and 65535' }, { status: 400 });
    }

    // Block reserved ports (e.g. 3000 for web-dashboard itself)
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

    // Check for duplicate environment name
    const existing = await db.environment.findFirst({
      where: { projectId: id, name },
    });
    if (existing) {
      return NextResponse.json(
        { error: `Environment '${name}' already exists` },
        { status: 409 }
      );
    }

    // Check for port conflicts across all environments
    const conflictingEnv = await db.environment.findFirst({
      where: { port: portNum, NOT: { id: undefined } },
    });
    if (conflictingEnv) {
      return NextResponse.json({ error: `Port ${portNum} is already in use by another environment` }, { status: 409 });
    }

    const environment = await db.environment.create({
      data: {
        projectId: id,
        name,
        cmd,
        port: portNum,
        envVars: JSON.stringify(envVars || {}),
      },
    });

    return NextResponse.json({ environment }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// GET /api/projects/[id]/environments - List environments
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const environments = await db.environment.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'asc' },
    });
    return NextResponse.json({ environments });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

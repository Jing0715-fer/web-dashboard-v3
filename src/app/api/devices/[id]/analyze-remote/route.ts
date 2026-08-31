import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { proxyToAgent } from '@/lib/remote-agent';
import { networkInterfaces } from 'os';
import { requireApprovedUser } from '@/lib/auth';

/**
 * Remote project auto-debug analysis — proxies to the device agent's
 * analyze-project endpoint, supplying this dashboard's llm-gateway URL so
 * the remote device needs no LLM credentials of its own.
 *
 *   POST /api/devices/[id]/analyze-remote  {path, name, usedPorts?}  → {jobId}
 *   GET  /api/devices/[id]/analyze-remote?jobId=...                  → job status
 */

function getLanIp(): string {
  for (const lists of Object.values(networkInterfaces())) {
    for (const ni of lists ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const { id } = await params;
    const device = await db.device.findUnique({ where: { id } });
    if (!device) return NextResponse.json({ error: 'Device not found' }, { status: 404 });

    const body = await req.json();
    if (!body?.path) return NextResponse.json({ error: 'path is required' }, { status: 400 });

    const usedPorts = Array.isArray(body.usedPorts) ? body.usedPorts : [];
    const llmBaseUrl = `http://${getLanIp()}:3021/v1`;

    const result = await proxyToAgent(
      { ip: device.ip, port: device.port, apiKey: device.apiKey },
      '/analyze-project',
      'POST',
      { path: body.path, name: body.name, llmBaseUrl, usedPorts: [...usedPorts, 3000, 3100, 3021, 3022] }
    );
    if (!result.ok) {
      return NextResponse.json({ error: result.data?.error || `Agent returned ${result.status}` }, { status: 502 });
    }
    return NextResponse.json(result.data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const { id } = await params;
    const jobId = req.nextUrl.searchParams.get('jobId');
    if (!jobId) return NextResponse.json({ error: 'jobId is required' }, { status: 400 });

    const device = await db.device.findUnique({ where: { id } });
    if (!device) return NextResponse.json({ error: 'Device not found' }, { status: 404 });

    const result = await proxyToAgent(
      { ip: device.ip, port: device.port, apiKey: device.apiKey },
      `/analyze-project/${jobId}`,
      'GET'
    );
    if (!result.ok) {
      return NextResponse.json({ error: result.data?.error || `Agent returned ${result.status}` }, { status: 502 });
    }
    return NextResponse.json(result.data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

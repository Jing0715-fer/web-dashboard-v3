import { NextRequest, NextResponse } from 'next/server';
import { requireApprovedUser } from '@/lib/auth';

/**
 * Proxy to the local harness-agent service (deepseek-harness orchestration).
 *   GET  /api/harness/health
 *   POST /api/harness/analyze
 *   GET  /api/harness/sessions/:id
 *   POST /api/harness/sessions/:id/cancel
 */
const HARNESS_BASE = process.env.HARNESS_AGENT_URL || 'http://127.0.0.1:3022';

async function proxy(req: NextRequest, path: string) {
  const url = `${HARNESS_BASE}/api/harness/${path}`;
  const init: RequestInit = {
    method: req.method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (req.method === 'POST') {
    init.body = await req.text();
  }
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  const { path } = await params;
  try {
    return await proxy(req, path.join('/'));
  } catch (e: any) {
    return NextResponse.json({ error: `harness-agent 不可达: ${e.message}` }, { status: 502 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  const { path } = await params;
  try {
    return await proxy(req, path.join('/'));
  } catch (e: any) {
    return NextResponse.json({ error: `harness-agent 不可达: ${e.message}` }, { status: 502 });
  }
}

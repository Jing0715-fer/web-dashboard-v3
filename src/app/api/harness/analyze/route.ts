import { NextRequest, NextResponse } from 'next/server';
import { existsSync, statSync } from 'fs';
import { resolve, basename } from 'path';
import { requireApprovedUser } from '@/lib/auth';
import {
  ensureEngine,
  startAnalysis,
  sessionView,
  resolveGatewayBaseUrl,
  dshAvailable,
} from '@/lib/harness/engine';

/**
 * POST /api/harness/analyze — start a deepseek-harness analysis session for
 * a local project directory. Body: {path, name?, usedPorts?, maxAttempts?}.
 * Returns {sessionId, ...sessionView} — same shape as the former
 * standalone harness-agent so the frontend wizard is unchanged.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  ensureEngine();

  if (!dshAvailable()) {
    return NextResponse.json(
      {
        error:
          'dsh 未安装：请在项目根目录执行依赖安装（bun install / npm install）后重启仪表盘',
      },
      { status: 503 },
    );
  }

  try {
    const body = await req.json();
    const path = resolve(String(body?.path || ''));
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return NextResponse.json({ error: `Invalid project path: ${path}` }, { status: 400 });
    }
    const usedPorts = Array.isArray(body?.usedPorts)
      ? body.usedPorts.map(Number).filter((n: any) => Number.isInteger(n))
      : [];
    const maxAttempts = Math.min(Math.max(Number(body?.maxAttempts) || 3, 1), 5);

    // dsh (spawned locally) must reach this server's in-process LLM gateway.
    let llmBaseUrl: string;
    try {
      llmBaseUrl = await resolveGatewayBaseUrl(req.nextUrl.origin);
    } catch (e: any) {
      return NextResponse.json({ error: String(e?.message || e) }, { status: 503 });
    }

    const s = startAnalysis(path, String(body?.name || basename(path)), usedPorts, maxAttempts, llmBaseUrl);
    return NextResponse.json({ sessionId: s.id, ...sessionView(s) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

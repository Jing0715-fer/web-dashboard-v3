import { NextRequest, NextResponse } from 'next/server';
import { requireApprovedUser } from '@/lib/auth';
import { ensureEngine, listSessions, sessionView } from '@/lib/harness/engine';

/**
 * GET /api/harness/sessions — list analysis sessions (newest first).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  ensureEngine();
  const list = listSessions().map(sessionView);
  return NextResponse.json({ sessions: list, count: list.length });
}

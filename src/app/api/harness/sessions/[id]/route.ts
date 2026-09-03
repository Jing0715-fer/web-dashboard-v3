import { NextRequest, NextResponse } from 'next/server';
import { requireApprovedUser } from '@/lib/auth';
import { ensureEngine, getSession, sessionView } from '@/lib/harness/engine';

/**
 * GET /api/harness/sessions/:id — session status + progress + result.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  ensureEngine();
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  return NextResponse.json(sessionView(s));
}

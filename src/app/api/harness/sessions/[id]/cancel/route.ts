import { NextRequest, NextResponse } from 'next/server';
import { requireApprovedUser } from '@/lib/auth';
import { ensureEngine, cancelSession, sessionView } from '@/lib/harness/engine';

/**
 * POST /api/harness/sessions/:id/cancel — kill the dsh run and mark the
 * session cancelled.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  ensureEngine();
  const { id } = await params;
  const s = cancelSession(id);
  if (!s) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  return NextResponse.json(sessionView(s));
}

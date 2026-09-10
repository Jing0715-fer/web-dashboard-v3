import { NextRequest, NextResponse } from 'next/server';
import { requireApprovedUser } from '@/lib/auth';
import { engineHealth, ensureEngine } from '@/lib/harness/engine';

/**
 * GET /api/harness/health — in-process harness engine status.
 * (Replaces the former proxy to the standalone harness-agent :3022.)
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  ensureEngine();
  return NextResponse.json(engineHealth());
}

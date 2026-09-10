import { NextRequest, NextResponse } from 'next/server';
import { resolveRepairApproval } from '@/lib/llm-repair';
import { requireApprovedUser } from '@/lib/auth';

/**
 * POST /api/repair-jobs/[jobId]/approve
 * Resolves a pending manual-approval request for a repair command that failed
 * the safe-allowlist check. Body: { approved: boolean } — `true` runs the
 * command, `false` (or a 10-minute timeout on the server) skips it.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const { jobId } = await params;
    let approved = true;
    try {
      const body = await req.json();
      approved = body?.approved !== false;
    } catch {
      // empty body defaults to approve
    }
    const ok = resolveRepairApproval(jobId, approved);
    if (!ok) {
      return NextResponse.json(
        { error: 'No pending approval for this job (already resolved or job not found)' },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true, approved });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

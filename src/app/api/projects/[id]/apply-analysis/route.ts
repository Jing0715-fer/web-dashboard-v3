import { NextRequest, NextResponse } from 'next/server';
import { requireApprovedUser } from '@/lib/auth';
import { applyAnalysisToProject } from '@/lib/apply-analysis';

/**
 * POST /api/projects/[id]/apply-analysis
 * Applies a completed harness-agent analysis result to the project.
 * Thin wrapper over the shared lib (src/lib/apply-analysis.ts) — the same
 * logic also runs server-side automatically when an analysis finishes
 * (src/lib/harness/auto-apply.ts), so results are never lost when the
 * wizard is closed before the user clicks "save".
 *
 * Body: { analysis: {projectName, description, icon, environments[], summary} }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const { id } = await params;
    const body = await req.json();
    const analysis = body?.analysis;

    const outcome = await applyAnalysisToProject(id, analysis);
    if (!outcome.ok) {
      // Keep the legacy response shape for the wizard's manual-save path.
      const status = outcome.status === 'project-not-found' ? 404 : 400;
      return NextResponse.json({ error: outcome.error || 'Failed to apply analysis', dropped: outcome.dropped }, { status });
    }

    return NextResponse.json({
      project: outcome.project,
      applied: outcome.applied,
      dropped: outcome.dropped,
      suggestedName: outcome.suggestedName,
      summary: outcome.summary,
    });
  } catch (e: any) {
    console.error('Apply-analysis error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

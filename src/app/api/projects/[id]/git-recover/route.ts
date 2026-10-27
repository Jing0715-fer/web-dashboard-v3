import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logActivity } from '@/lib/activity';
import { requireApprovedUser } from '@/lib/auth';
import { diagnoseStuckState, recoverStuckState, type RecoveryMode } from '@/lib/git-stuck-recovery';

/**
 * POST /api/projects/:id/git-recover — v1.42 stuck-git-state recovery.
 *
 * When the pull agent's backup precheck refuses to stash an unmerged index
 * ("resolve or commit them first"), this endpoint finishes the job:
 *
 *   { action: 'diagnose' }                        — read-only inventory of
 *                                                   the wedged state (op
 *                                                   kind, unmerged paths,
 *                                                   stash entries).
 *   { action: 'recover', mode: 'abort-op' }       — git's own --abort for
 *                                                   merge/rebase/cherry-
 *                                                   pick/revert.
 *   { action: 'recover', mode: 'ours' }           — keep the pulled (HEAD)
 *                                                   version; stashed side
 *                                                   extracted as .local.bak.
 *   { action: 'recover', mode: 'theirs' }         — keep the stashed (local)
 *                                                   version; pulled side
 *                                                   extracted as .pulled.bak.
 *   { action: 'recover', mode: 'discard-local',
 *     confirm: true }                             — reset --hard HEAD (the
 *                                                   stash entries SURVIVE);
 *                                                   requires the explicit
 *                                                   confirm flag.
 *
 * Same authorization as the pull-agent route (approved user) and the same
 * local-only rule — git must run where the code lives.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RECOVERY_MODES: RecoveryMode[] = ['abort-op', 'ours', 'theirs', 'discard-local'];

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApprovedUser(req);
  if (guard.error) return guard.error;

  const { id } = await ctx.params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  if (project.deviceId) {
    return NextResponse.json(
      {
        error: 'Git recovery runs locally — this project lives on a paired device. Run the recovery on that machine, or move the project to this machine first',
      },
      { status: 400 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action === 'recover' ? 'recover' : 'diagnose';

  if (action === 'diagnose') {
    const diag = await diagnoseStuckState(project.path);
    return NextResponse.json(diag, { status: diag.ok ? 200 : 500 });
  }

  // ---- recover ----
  const mode = String(body.mode || '') as RecoveryMode;
  if (!RECOVERY_MODES.includes(mode)) {
    return NextResponse.json(
      { error: `Invalid mode: ${String(body.mode || '(empty)')} — expected one of ${RECOVERY_MODES.join(', ')}` },
      { status: 400 },
    );
  }
  if (mode === 'discard-local' && body.confirm !== true) {
    return NextResponse.json(
      {
        error: 'discard-local resets the working tree to HEAD — post-conflict manual edits would be lost. Re-send with confirm: true once you have checked the .local.bak files / stash entries cover what you need.',
      },
      { status: 400 },
    );
  }

  const result = await recoverStuckState(project.path, mode);
  try {
    await logActivity({
      type: 'pull',
      level: result.ok ? 'warn' : 'error',
      message: `${result.ok ? 'Recovered' : 'Recovery failed'} stuck git state (${mode}) in ${project.name}`,
      projectId: project.id,
      projectName: project.name,
      detail: result.detail.slice(0, 300),
    });
  } catch { /* logging is best-effort */ }
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

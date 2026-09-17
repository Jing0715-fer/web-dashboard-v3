import { NextRequest, NextResponse } from 'next/server';
import { existsSync } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db';
import { requireApprovedUser } from '@/lib/auth';
import { sanitizeConflictFiles } from '@/lib/pull-conflict';
import { collectGitContext, diagnosePullFailure } from '@/lib/pull-diagnose';

/**
 * POST /api/projects/:id/pull-diagnose — AI diagnosis of a failed pull
 * (dashboard v1.19).
 *
 * Body (round-tripped by the frontend from the pull response that failed):
 *   { error: string, detail?: string, transient?: boolean, branch?: string,
 *     locale?: 'en'|'zh', modified?: string[], untracked?: string[] }
 *
 * Flow:
 *   1. collect read-only git context for LOCAL projects (status/log/remotes/
 *      stash — remote URLs token-stripped before anything leaves the box)
 *   2. ask the configured LLM provider (Settings → LLM Configuration; the
 *      built-in z-ai SDK is the fallback) to name the root cause and pick
 *      ONE whitelisted strategy: retry | stash | force | manual
 *   3. answer { ok: true, diagnosis, provider, model }
 *
 * The LLM never generates commands — 'stash'/'force' execute through the
 * SAME v1.17 pull route (validated file lists, pathspec-sanitized), and
 * only after the user confirms in the dialog ('force' asks twice).
 *
 * When the diagnosis itself fails (no LLM configured, provider down,
 * unparseable answer) the answer is 200 { ok: false, error } so the
 * frontend can fall back to the v1.17 conflict dialog / plain error toast
 * instead of dead-ending.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    return await handleDiagnose(req, ctx);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: 'Diagnose request failed', detail: String(e?.message || e).slice(0, 300) },
      { status: 500 },
    );
  }
}

async function handleDiagnose(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;

  const { id } = await params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project) {
    return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
  }

  // Untrusted body — clamp every field before it reaches the prompt.
  let error = '';
  let detail = '';
  let transient = false;
  let branch = '';
  let locale = 'en';
  let modified: string[] = [];
  let untracked: string[] = [];
  try {
    const body = await req.json();
    error = String(body?.error || '').slice(0, 400);
    detail = String(body?.detail || '').slice(0, 1200);
    transient = !!body?.transient;
    if (typeof body?.branch === 'string') branch = body.branch.trim().slice(0, 120);
    locale = body?.locale === 'zh' ? 'zh' : 'en';
    modified = sanitizeConflictFiles(body?.modified);
    untracked = sanitizeConflictFiles(body?.untracked);
  } catch { /* no body — the bare error below is the diagnosis input */ }
  if (!error && !detail) {
    return NextResponse.json(
      { ok: false, error: 'Nothing to diagnose — pass the pull failure error/detail' },
      { status: 400 },
    );
  }

  // Read-only context for LOCAL projects. Remote projects run git on the
  // device agent — their repo state is not reachable from here, and the
  // LLM works from the error text + conflict lists alone.
  let gitContext = '';
  if (!project.deviceId && project.path && existsSync(project.path) && existsSync(join(project.path, '.git'))) {
    try {
      gitContext = await collectGitContext(project.path);
    } catch { /* soft-fail — diagnose with less context */ }
  }

  try {
    const { diagnosis, provider, model } = await diagnosePullFailure({
      error: error || 'git pull failed',
      detail: detail || undefined,
      transient,
      branch: branch || undefined,
      locale,
      modified,
      untracked,
      projectName: project.name,
      repoUrl: project.repoUrl || undefined,
      gitContext,
    });
    return NextResponse.json({ ok: true, diagnosis, provider, model });
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: 'AI diagnosis is unavailable right now',
        detail: String(e?.message || e).slice(0, 300),
        // Enough signal for the frontend to fall back to the v1.17 dialog.
        fallback: modified.length > 0 || untracked.length > 0 ? 'conflict' : 'error',
      },
      { status: 200 },
    );
  }
}

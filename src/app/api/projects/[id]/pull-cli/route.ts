import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db';
import { requireApprovedUser } from '@/lib/auth';
import { isValidBranchName } from '@/lib/git-branches';
import { logActivity } from '@/lib/activity';
import { invalidateUpdateCache } from '@/lib/git-update-check';
import { syncDepsAfterPull } from '@/lib/pull-deps-sync';
import { runCliSession } from '@/lib/llm-repair/cli-session';

const execFileAsync = promisify(execFile);

/**
 * POST /api/projects/[id]/pull-cli (v1.34)
 *
 * Code-pull delegation to a local agent CLI — the 'cli' option of pullMode
 * (LLM settings → 功能引擎 → 代码拉取). The CLI runs the whole sync loop
 * (safeguard local changes → pull → resolve/restore) while the dashboard
 * keeps the authority: the RESULT is derived from git itself (HEAD before
 * vs after), never from the CLI's self-report — same doctrine as the
 * repair engine's independent verification.
 *
 * Contract (mirrors analyze-cli):
 *   200 { ok: true,  status: 'updated'|'up_to_date', before, after, cli, summary, switchedTo? }
 *   200 { ok: false, error, fallbackReason } — the FRONTEND then reruns
 *        the plain pull route (which carries its own AI diagnosis ladder).
 *
 * Local projects only (git must run where the code lives). Branch names
 * are validated before they ever reach the task file.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PULL_CLI_TIMEOUT_MS = 8 * 60_000;
const TASK_FILE = '.dashboard-pull-task.md';

interface GitSnapshot {
  head: string;
  branch: string;
  dirty: string;
}

async function gitSnapshot(projectPath: string): Promise<GitSnapshot | null> {
  try {
    if (!existsSync(join(projectPath, '.git'))) return null;
    const opts = { cwd: projectPath, timeout: 15_000, windowsHide: true } as const;
    const [{ stdout: headOut }, { stdout: branchOut }, { stdout: statusOut }] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], opts),
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts),
      execFileAsync('git', ['status', '--porcelain'], opts),
    ]);
    const dirty = statusOut
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, 1500);
    return { head: headOut.trim(), branch: branchOut.trim() || '(detached)', dirty };
  } catch {
    return null;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const { id } = await params;
    let branch = '';
    try {
      const body = await req.json();
      if (body && typeof body.branch === 'string') branch = body.branch.trim();
    } catch { /* no body / not JSON */ }
    if (branch && !isValidBranchName(branch)) {
      return NextResponse.json({ ok: false, error: 'invalid-branch', fallbackReason: `Invalid branch name: ${branch.slice(0, 80)}` }, { status: 200 });
    }

    const project = await db.project.findUnique({ where: { id } });
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    if (project.deviceId) {
      return NextResponse.json({ ok: false, error: 'remote-project', fallbackReason: 'CLI 拉取只能在本机项目上运行（远程项目由设备端 agent 执行 git）' }, { status: 200 });
    }

    // ---- authority snapshot: state BEFORE the CLI touches anything ----
    const before = await gitSnapshot(project.path);
    if (!before) {
      return NextResponse.json({ ok: false, error: 'not-a-repo', fallbackReason: '项目目录不是可用的 git 仓库（无 .git 或 git 不可用）' }, { status: 200 });
    }

    const taskContent = `# Pull task: ${project.name}

## Mission
Synchronize this working copy with its remote (${branch ? `switch to / pull branch "${branch}"` : 'pull the current branch'}), while preserving every local uncommitted change. You have full read/write/command access in this directory — work autonomously. Do NOT ask questions.

## Method (backup-first, in order)
1. Record the current local changes (git status) BEFORE touching anything.
2. Fetch + pull. If the pull is blocked by local modifications:
   - back up the affected files first (copy them aside or stash WITH a named message),
   - then complete the sync,
   - then restore the local changes on top of the new code (resolve conflicts in favor of keeping the user's edits working).
3. ${branch ? `Target branch: "${branch}" — switch to it if it is not current, then pull.` : 'Stay on the current branch.'}

## Constraints (NON-NEGOTIABLE)
1. NEVER run git push, git commit, or git reset --hard that would DISCARD uncommitted user changes without a backup.
2. Read-only git (status/diff/log/fetch) is always fine.
3. Keep changes minimal: this is a sync, not a refactor. Do not touch unrelated files.
4. Ports 3000 and 3100-3105 belong to the dashboard — never bind or kill anything on them.

## Output contract (NON-NEGOTIABLE)
Your FINAL output must contain ONE fenced \`\`\`json block with EXACTLY this shape:
\`\`\`json
{ "status": "updated" | "up_to_date" | "failed", "summary": "one-line Chinese summary of what happened" }
\`\`\`
The dashboard independently compares HEAD before/after — a claimed-but-unhappened pull counts as up_to_date, and a claimed pull that lost local changes counts as failure.

## Environment facts
- Project root (your working directory): ${project.path}
- Current branch: ${before.branch}
- HEAD before: ${before.head}
- Platform: ${process.platform}${process.platform === 'win32' ? ' — the shell is cmd.exe; Unix commands do not exist. Use dir/type/tasklist or your own file tools.' : ''}
- Local changes right now:
${before.dirty || '(clean working tree)'}

Exit after printing the JSON block.
`;

    const session = await runCliSession({
      projectPath: project.path,
      taskFile: TASK_FILE,
      taskContent,
      timeoutMs: PULL_CLI_TIMEOUT_MS,
      tag: `pull-${project.id.slice(0, 8)}`,
    });

    if (!session.cli) {
      logActivity({ type: 'pull', level: 'warn', message: `CLI 拉取回退：${project.name}`, projectId: project.id, projectName: project.name, detail: 'pullMode=cli 但未检出可用的 Agent CLI' });
      return NextResponse.json({ ok: false, error: 'no-cli', fallbackReason: '未检出可用的本机 Agent CLI' }, { status: 200 });
    }
    if (session.error && !session.stdout.trim()) {
      return NextResponse.json({ ok: false, error: 'cli-run-failed', fallbackReason: session.error || `Agent CLI（${session.cli.label}）无法启动` }, { status: 200 });
    }

    // ---- authority verification: what did git ACTUALLY do? ----
    const after = await gitSnapshot(project.path);
    if (!after) {
      return NextResponse.json({ ok: false, error: 'git-broken-after', fallbackReason: 'CLI 运行后工作树不可读（git snapshot 失败）' }, { status: 200 });
    }

    const updated = after.head !== before.head;
    const switchedTo = after.branch !== before.branch ? after.branch : undefined;
    const status: 'updated' | 'up_to_date' = updated ? 'updated' : 'up_to_date';

    if (!updated) {
      // The CLI may still have produced output; if it clearly failed to even
      // run the sync, let the frontend fall back to the plain pull + AI
      // diagnosis ladder instead of reporting a no-op as success.
      const cliClaimedFailure = /"status"\s*:\s*"failed"/i.test(session.stdout);
      if (cliClaimedFailure || (!session.ok && !session.summary)) {
        logActivity({ type: 'pull', level: 'warn', message: `CLI 拉取回退：${project.name}`, projectId: project.id, projectName: project.name, detail: (session.summary || session.error || `Agent CLI（${session.cli.label}）未完成同步`).slice(0, 300) });
        return NextResponse.json({ ok: false, error: 'cli-noop', fallbackReason: session.summary || session.error || `Agent CLI（${session.cli.label}）未能完成同步` }, { status: 200 });
      }
    }

    invalidateUpdateCache([project.id]);
    logActivity({
      type: 'pull',
      level: updated ? 'success' : 'info',
      message: `CLI 拉取${updated ? '完成' : '：已是最新'}：${project.name}${switchedTo ? ` → ${switchedTo}` : ''}（${session.cli.label}）`,
      projectId: project.id,
      projectName: project.name,
      detail: (session.summary || '').slice(0, 300) || `HEAD ${before.head.slice(0, 8)} → ${after.head.slice(0, 8)}`,
    });
    if (updated) {
      syncDepsAfterPull({
        projectPath: project.path,
        projectId: project.id,
        projectName: project.name,
        before: before.head,
        after: after.head,
      });
    }

    return NextResponse.json({
      ok: true,
      engine: 'cli',
      status,
      before: before.head,
      after: after.head,
      switchedTo,
      cli: session.cli,
      summary: session.summary || '',
      localChangesAfter: after.dirty.slice(0, 1200),
    });
  } catch (e: any) {
    console.error('Pull CLI error:', e);
    return NextResponse.json({ ok: false, error: 'route-crashed', fallbackReason: String(e?.message || e).slice(0, 300) }, { status: 200 });
  }
}

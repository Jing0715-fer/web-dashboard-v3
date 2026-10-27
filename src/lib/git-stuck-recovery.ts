/**
 * Stuck-git-state recovery (v1.42).
 *
 * The pull agent's backup precheck (v1.39) refuses to stash an unmerged
 * index — structurally impossible, git answers "needs merge" — and until
 * now the only way out was a manual terminal session: figure out WHICH
 * operation left the conflict stages behind (a merge? a rebase? the agent's
 * own conflicted stash-pop rollback?), then pick the right incantation.
 * Real-world report: a repo with 3382 modified files and 171 unmerged paths
 * wedged every subsequent pull with "resolve or commit them first".
 *
 * This module makes the dashboard finish that job:
 *
 *   diagnoseStuckState()  — read-only: names the in-progress operation
 *                           (merge / rebase / cherry-pick / revert /
 *                           stash-pop-conflict / unknown-conflict), lists
 *                           the unmerged paths and the stash entries
 *                           (dashboard-agent labels flagged as ours).
 *   recoverStuckState()   — four modes, same invariant as the pull agent:
 *                           NOTHING IS EVER LOST.
 *     'abort-op'      git's own --abort for merge/rebase/cherry-pick/revert
 *                     (restores the pre-operation state by design).
 *     'ours'          resolve every unmerged path to the HEAD ("ours")
 *                     version — for a conflicted stash-pop this keeps the
 *                     PULLED code in the tree; the stashed side is extracted
 *                     next to each file as <path>.local.bak AND stays inside
 *                     the stash entry (git never drops a conflicted pop).
 *     'theirs'        mirror: keep the stashed ("theirs") version — the
 *                     user's local edits win — and extract the pulled side
 *                     as <path>.pulled.bak.
 *     'discard-local' git reset --hard HEAD: clean tree at the already-
 *                     pulled commit. Stash entries SURVIVE (we never touch
 *                     refs/stash); only post-conflict manual edits would be
 *                     lost, so the route demands an explicit confirm.
 *
 * The engine never talks to an LLM — fixed, auditable git plumbing only.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { unmergedPaths, findStashIndexByLabel } from '@/lib/pull-agent';

const execFileAsync = promisify(execFile);

/** Per-file git timeout — conflict resolution touches one path at a time. */
const GIT_TIMEOUT_MS = 30_000;
/** reset --hard on a huge tree — generous ceiling, it is still a local op. */
const RESET_TIMEOUT_MS = 120_000;
/** Cap the .bak extraction content at 8 MB per file (blobs can be huge). */
const BAK_MAX_BYTES = 8 * 1024 * 1024;

// ============================== types ==============================

export type StuckOp =
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'revert'
  | 'stash-pop-conflict'
  | 'unknown-conflict';

export interface StashEntryInfo {
  index: number;
  /** Full stash message (e.g. "On main: dashboard-agent 20261026-221408"). */
  label: string;
  /** True when the message ends with a dashboard-agent label — the user's
   * backed-up local changes from an agent run. */
  ours: boolean;
}

export interface StuckDiagnosis {
  ok: boolean;
  /** False when the repo has neither conflict stages nor an in-progress
   * operation — nothing to recover. */
  stuck: boolean;
  op: StuckOp | null;
  unmerged: string[];
  /** "a.txt, b.txt … (+166 more)" — same display style as the precheck. */
  unmergedShown: string;
  stash: StashEntryInfo[];
  branch: string;
  head: string;
  error?: string;
}

export type RecoveryMode = 'abort-op' | 'ours' | 'theirs' | 'discard-local';

export interface RecoveryResult {
  ok: boolean;
  mode: RecoveryMode;
  /** Unmerged paths actually cleared (0 + ok=false means the mode refused). */
  resolved: number;
  /** Files extracted as <path>.local.bak (mode 'ours' — the stashed side). */
  localBaks: string[];
  /** Files extracted as <path>.pulled.bak (mode 'theirs' — the HEAD side). */
  pulledBaks: string[];
  /** Paths where the losing side had no extractable blob (deleted/added
   * asymmetric stages) — reported, never silently dropped. */
  skippedBaks: string[];
  /** Stash entries still present after the recovery (labels). */
  stashRemaining: string[];
  /** Human-readable transcript lines for the report view. */
  steps: string[];
  detail: string;
}

// ============================== plumbing ==============================

/** Run git, capture stdout; throws with git's own text on failure. */
async function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
  });
  return String(stdout || '').trim();
}

/** Resolve the repository's real git dir (linked worktrees keep it
 * elsewhere — <cwd>/.git is only the common case). */
async function gitDir(cwd: string): Promise<string> {
  try {
    const gd = await git(cwd, ['rev-parse', '--git-dir'], 15_000);
    if (gd) return isAbsolute(gd) ? gd : join(cwd, gd);
  } catch { /* not a repo — callers surface that */ }
  return join(cwd, '.git');
}

/** Parse `git stash list` into entries, flagging dashboard-agent labels. */
function parseStashList(list: string): StashEntryInfo[] {
  const out: StashEntryInfo[] = [];
  for (const raw of list.split('\n')) {
    const line = raw.trim();
    const m = line.match(/^stash@\{(\d+)\}:\s*(.*)$/);
    if (!m) continue;
    out.push({
      index: parseInt(m[1], 10) || 0,
      label: m[2].slice(0, 200),
      // same end-anchored shape the pull agent's label matcher uses
      ours: /dashboard-agent \d{8}-\d{6}$/.test(m[2].trim()),
    });
  }
  return out;
}

// ============================== diagnosis ==============================

/** Read-only inventory of whatever wedged the repository. Safe to run any
 * time — no git command below writes anything. */
export async function diagnoseStuckState(cwd: string): Promise<StuckDiagnosis> {
  const base: StuckDiagnosis = {
    ok: true, stuck: false, op: null, unmerged: [], unmergedShown: '',
    stash: [], branch: '', head: '',
  };
  try {
    let branch = '';
    try {
      branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 15_000);
    } catch { /* unborn / not a repo */ }
    let head = '';
    try {
      head = (await git(cwd, ['rev-parse', '--short', 'HEAD'], 15_000)).slice(0, 7);
    } catch { /* unborn */ }

    const unmerged = await unmergedPaths(cwd);
    const stash = parseStashList(await git(cwd, ['stash', 'list'], 15_000).catch(() => ''));

    // In-progress operation markers inside the git dir. Order matters:
    // rebase-merge/rebase-apply before MERGE_HEAD — a rebase can hold both.
    let op: StuckOp | null = null;
    const gd = await gitDir(cwd);
    if (existsSync(join(gd, 'rebase-merge')) || existsSync(join(gd, 'rebase-apply'))) {
      op = 'rebase';
    } else if (existsSync(join(gd, 'MERGE_HEAD'))) {
      op = 'merge';
    } else if (existsSync(join(gd, 'CHERRY_PICK_HEAD'))) {
      op = 'cherry-pick';
    } else if (existsSync(join(gd, 'REVERT_HEAD'))) {
      op = 'revert';
    } else if (unmerged.length > 0) {
      // No operation marker + conflict stages: the classic residue of a
      // conflicted `git stash pop` (ours or the user's own) — git leaves
      // the stages behind and KEEPS the stash entry.
      op = stash.length > 0 ? 'stash-pop-conflict' : 'unknown-conflict';
    }

    const stuck = unmerged.length > 0 || op !== null;
    const shown = unmerged.slice(0, 5).join(', ') + (unmerged.length > 5 ? ` … (+${unmerged.length - 5} more)` : '');
    return { ...base, stuck, op, unmerged, unmergedShown: shown, stash, branch, head };
  } catch (e: unknown) {
    return { ...base, ok: false, error: String((e as Error)?.message || e).slice(0, 300) };
  }
}

// ============================== recovery ==============================

/** Extract one side of a conflicted path straight from the index stages
 * (":2:" = HEAD/"ours", ":3:" = stash/"theirs") and write it next to the
 * file with the given suffix. Fail-soft: false when the stage has no blob
 * (asymmetric delete/add conflicts) or the blob is too large to sidecar. */
async function extractStageBak(cwd: string, path: string, stage: 2 | 3, suffix: '.local.bak' | '.pulled.bak'): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['show', `:${stage}:${path}`], {
      cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: BAK_MAX_BYTES,
    });
    const content = String(stdout || '');
    if (!content) return false;
    const target = join(cwd, `${path}${suffix}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`);
    return true;
  } catch {
    return false; // no such stage (deleted side) or oversized blob
  }
}

/** Resolve one unmerged path to the chosen side. Returns how it resolved:
 * 'checkout' (stage content restored), 'rm' (the chosen side deleted the
 * file — path removed and marked resolved) or 'failed'. */
async function resolvePathToSide(cwd: string, path: string, side: 'ours' | 'theirs'): Promise<'checkout' | 'rm' | 'failed'> {
  try {
    await execFileAsync('git', ['checkout', `--${side}`, '--', path], {
      cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    });
    return 'checkout';
  } catch { /* the chosen side has no stage for this path (a delete) */ }
  try {
    // The chosen side DELETED this path: resolve by removing it. --force
    // because the worktree holds the conflicted merge result.
    await execFileAsync('git', ['rm', '--force', '--', path], {
      cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    });
    return 'rm';
  } catch {
    return 'failed';
  }
}

/** Mark every unmerged path resolved (git add), then unstage everything
 * (mixed reset) so the user's changes land back as ordinary working-tree
 * edits — the same deterministic finish the pull agent's restore phase
 * uses. Returns the paths that could not be resolved. */
async function finishResolution(cwd: string, unmerged: string[]): Promise<string[]> {
  const unresolved: string[] = [];
  for (const p of unmerged) {
    try {
      await execFileAsync('git', ['add', '--', p], {
        cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      unresolved.push(p);
    }
  }
  // Unstage: conflicts are resolved, but nothing should stay staged.
  await execFileAsync('git', ['reset'], {
    cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
  }).catch(() => { /* already clean */ });
  return unresolved;
}

/** Recover a wedged repository. Refuses (ok=false, nothing touched) when
 * the diagnosis and the mode disagree — aborting requires an abortable
 * operation, resolving requires conflict stages. */
export async function recoverStuckState(
  cwd: string,
  mode: RecoveryMode,
): Promise<RecoveryResult> {
  const diag = await diagnoseStuckState(cwd);
  const base: RecoveryResult = {
    ok: false, mode, resolved: 0, localBaks: [], pulledBaks: [], skippedBaks: [],
    stashRemaining: diag.stash.map((s) => s.label), steps: [], detail: '',
  };
  if (!diag.ok) return { ...base, detail: diag.error || 'diagnosis failed' };

  const say = (line: string) => { base.steps.push(line); };

  // ---- mode: abort-op (merge / rebase / cherry-pick / revert) ----
  if (mode === 'abort-op') {
    const op = diag.op;
    if (op !== 'merge' && op !== 'rebase' && op !== 'cherry-pick' && op !== 'revert') {
      return { ...base, detail: `no in-progress ${['merge', 'rebase', 'cherry-pick', 'revert'].join('/')} to abort (found: ${op || 'nothing'})` };
    }
    say(`git ${op} --abort`);
    try {
      await execFileAsync('git', [op, '--abort'], {
        cwd, timeout: RESET_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      });
    } catch (e: unknown) {
      return { ...base, detail: `git ${op} --abort failed: ${String((e as Error)?.message || '').slice(0, 200)}` };
    }
    const after = await unmergedPaths(cwd);
    if (after.length > 0) {
      return { ...base, detail: `${op} --abort ran but ${after.length} path(s) are still unmerged`, steps: [...base.steps, ...after.slice(0, 10)] };
    }
    say('conflict stages cleared; repository back at the pre-operation state');
    return { ...base, ok: true, resolved: diag.unmerged.length, detail: `${op} aborted — repository restored to its pre-${op} state` };
  }

  // ---- shared precondition for the resolve modes ----
  if (diag.unmerged.length === 0) {
    return { ...base, detail: 'no unresolved conflict paths to resolve' };
  }

  // ---- mode: ours (keep the HEAD / pulled version in the tree) ----
  if (mode === 'ours' || mode === 'theirs') {
    const keepSide = mode;                       // stage side that wins
    const loseSide = mode === 'ours' ? 3 : 2;    // stage extracted as .bak
    const suffix = mode === 'ours' ? '.local.bak' : '.pulled.bak';
    say(`resolving ${diag.unmerged.length} path(s) to the ${mode === 'ours' ? 'pulled (HEAD)' : 'stashed (local)'} version`);

    // 1. Extract the LOSING side first — the index stages vanish once the
    //    conflicts are resolved, and that blob is the only clean copy.
    for (const p of diag.unmerged) {
      const okBak = await extractStageBak(cwd, p, loseSide as 2 | 3, suffix);
      if (okBak) {
        if (mode === 'ours') base.localBaks.push(`${p}${suffix}`); else base.pulledBaks.push(`${p}${suffix}`);
        say(`extracted ${p}${suffix}`);
      } else {
        base.skippedBaks.push(p);
      }
    }

    // 2. Take the winning side for every path (checkout, falling back to
    //    rm when the winning side deleted the file).
    let checkoutCount = 0;
    let rmCount = 0;
    const failedPaths: string[] = [];
    for (const p of diag.unmerged) {
      const how = await resolvePathToSide(cwd, p, keepSide);
      if (how === 'checkout') checkoutCount++;
      else if (how === 'rm') rmCount++;
      else failedPaths.push(p);
    }
    say(`${checkoutCount} path(s) restored from the ${mode} side, ${rmCount} removed (deleted on that side)${failedPaths.length ? `, ${failedPaths.length} FAILED` : ''}`);

    // 3. Mark resolved + unstage (mixed reset) — the tree returns to the
    //    ordinary "dirty working changes" shape the pull agent can stash.
    const unresolved = await finishResolution(cwd, diag.unmerged);
    if (unresolved.length > 0 || failedPaths.length > 0) {
      return {
        ...base,
        detail: `${unresolved.length + failedPaths.length} path(s) could not be resolved automatically (stages may be asymmetric) — resolve them manually`,
        steps: [...base.steps, ...failedPaths.slice(0, 10), ...unresolved.slice(0, 10)],
      };
    }

    const after = await unmergedPaths(cwd);
    if (after.length > 0) {
      return { ...base, detail: `${after.length} path(s) still unmerged after resolution` };
    }
    say('all conflict stages cleared');
    return {
      ...base,
      ok: true,
      resolved: diag.unmerged.length,
      detail: mode === 'ours'
        ? `kept the pulled version in the tree; the local version was extracted as ${base.localBaks.length} .local.bak file(s) and stays inside the stash entry`
        : `kept the local (stashed) version in the tree; the pulled version was extracted as ${base.pulledBaks.length} .pulled.bak file(s)`,
    };
  }

  // ---- mode: discard-local (hard reset to the already-pulled HEAD) ----
  if (mode === 'discard-local') {
    say('git reset --hard HEAD (stash entries are NOT touched)');
    try {
      await execFileAsync('git', ['reset', '--hard', 'HEAD'], {
        cwd, timeout: RESET_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      });
    } catch (e: unknown) {
      return { ...base, detail: `git reset --hard failed: ${String((e as Error)?.message || '').slice(0, 200)}` };
    }
    const after = await unmergedPaths(cwd);
    if (after.length > 0) {
      return { ...base, detail: `reset ran but ${after.length} path(s) are still unmerged` };
    }
    // Report what survived: the stash entries (the user's backed-up
    // changes) and the untracked files (reset --hard never touches them).
    const stashAfter = parseStashList(await git(cwd, ['stash', 'list'], 15_000).catch(() => ''));
    say(`stash entries intact: ${stashAfter.length}`);
    return {
      ...base,
      ok: true,
      resolved: diag.unmerged.length,
      stashRemaining: stashAfter.map((s) => s.label),
      detail: `working tree reset to ${diag.head || 'HEAD'}${stashAfter.length ? ` — ${stashAfter.length} stash entr(y/ies) preserved (your backed-up changes are still recoverable)` : ''}; untracked files were left alone`,
    };
  }

  return { ...base, detail: `unknown mode: ${mode}` };
}

/** Re-exported for the route's convenience: exact label lookup the pull
 * agent uses (end-anchored, regex-escaped). */
export { findStashIndexByLabel };

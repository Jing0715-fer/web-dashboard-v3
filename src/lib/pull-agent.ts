import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { execGitNetwork, gitErrorText, gitNetworkErrorText, isGitKilledError, isTransientGitNetworkError } from '@/lib/git-retry';
import { getGitNetConfig, gitProxyArgs } from '@/lib/git-net-config';
import { parsePullConflict } from '@/lib/pull-conflict';

// execFile with windowsHide ON by default: git.exe / git-remote-https.exe
// are console-subsystem programs — from a console-less dashboard server
// (supervisor/scheduled start) every git call allocates a WINDOW on the
// user's desktop. CREATE_NO_WINDOW on Windows, no-op elsewhere.
const execFileRawAsync = promisify(execFile);
const execFileAsync = (file: string, args: string[], opts: any = {}): Promise<{ stdout: string; stderr: string }> =>
  execFileRawAsync(file, args, { windowsHide: true, ...opts }) as unknown as Promise<{ stdout: string; stderr: string }>;

/**
 * Pull-conflict AGENT (dashboard v1.20).
 *
 * v1.17 turned git's blocked-by-local-changes stderr into a 409 + dialog and
 * v1.19 let an LLM recommend one of the two manual strategies. What neither
 * could do is FINISH the job: a stash pop that conflicts, a diverged history,
 * an untracked file the remote started tracking, a second wave of blockers
 * after the first was cleared — every one of those still landed back on the
 * user's desk. This module is the next layer: a deterministic state machine
 * that runs the WHOLE pull + conflict-resolution loop to completion, with a
 * backup-first safety model:
 *
 *   preflight → backup → fetch → analyze → [switch] → sync → restore → verify
 *
 * Invariants (the whole design hangs off these):
 *   1. NOTHING IS EVER LOST — before any destructive command runs, the
 *      affected state is backed up (dirty tree → a labelled stash entry;
 *      diverged local commits → a `dashboard-backup/<branch>/<ts>` branch;
 *      conflicted local edits on restore → extracted as `<file>.local.bak`
 *      copies next to the file, while the stash entry is kept as well).
 *   2. NO SHELL — every git call is direct argv through execFile; file lists
 *      that came from the client go through the v1.17 path sanitizer.
 *   3. ALWAYS TERMINATES — every step either advances the state machine or
 *      fails the whole run with an actionable report; the sync loop is
 *      bounded (max 3 blocker-clearing iterations).
 *   4. HONEST REPORTING — the final result lists every artifact it created
 *      (stash refs, backup branch, .bak files) so the user knows exactly
 *      where their local changes live.
 *
 * The engine never talks to an LLM — it is a fixed, auditable algorithm.
 * Progress is reported through `onProgress(stepChanges)` so the SSE route can
 * stream a live timeline to the PullAgentDialog.
 */

export type AgentStepStatus = 'pending' | 'running' | 'ok' | 'warn' | 'fail' | 'skipped';

/** One line of the agent timeline. `note` is an i18n key + params bundle the
 *  frontend renders; `info` is raw git output (English, mono font, detail view). */
export interface AgentStep {
  key: 'preflight' | 'backup' | 'fetch' | 'analyze' | 'switch' | 'sync' | 'restore' | 'verify';
  status: AgentStepStatus;
  note?: { key: string; params?: Record<string, string | number> };
  info?: string;
}

export interface PullAgentArtifacts {
  /** A stash entry was created as the safety net (label in stashLabel). */
  stash: boolean;
  stashLabel?: string;
  /** A backup branch holding the diverged local commits. */
  branch?: string;
  /** Local copies extracted next to conflicted files (`<file>.local.bak`). */
  backupFiles: string[];
}

export interface PullAgentResult {
  ok: boolean;
  upToDate: boolean;
  before: string;
  after: string;
  switchedTo?: string;
  /** v1.25: the run synced the CHECKED-OUT branch's upstream and found nothing
   *  to do — but the repository's DEFAULT branch is ahead of HEAD. Pulling
   *  again will never help (same branch); switching branches will. Present
   *  whenever the checkout sits on a non-default branch that is strictly
   *  behind the default branch (mirror of the plain pull route's field). */
  newerOnDefault?: { branch: string; behind: number; remoteSha: string };
  /** v1.26: a FAILED run aborted after the backup stash was created but
   *  before the restore phase ever ran, and the safety rollback tried to
   *  pop the stash back into the working tree:
   *    'restored' — pop succeeded; the tree is exactly as it was pre-run
   *                (nothing lost, nothing left in the stash).
   *    'kept'     — pop failed (conflict); the changes remain SAFE inside
   *                the labelled stash entry for a manual `git stash pop`.
   *  Absent when no rollback was needed (failure after restore, or ok). */
  rolledBack?: 'restored' | 'kept';
  /** v1.27: every fetch strategy failed (network path to the remote is
   *  down) but the repo had CACHED remote-tracking refs for the target —
   *  the run continued and synced against that last known state instead
   *  of aborting. `ref` is the cached ref used, `error` the final fetch
   *  error (for the report). The UI must surface this: "synced against
   *  the last known remote state" — never a silent claim of freshness. */
  fetchDegraded?: { ref: string; error: string };
  /** Local changes re-applied cleanly on top of the pulled code. */
  restored: boolean;
  /** Files whose stash-pop conflict was auto-resolved (pulled version in the
   *  tree, local version extracted as .local.bak AND kept in the stash entry). */
  autoResolved: string[];
  artifacts: PullAgentArtifacts;
  steps: AgentStep[];
  /** One-liner for the toast / activity feed. */
  summary: string;
  /** Human-readable transcript (joined step notes) for the detail view. */
  output: string;
  error?: string;
  detail?: string;
}

/** Bounded blocker-clearing iterations — git reveals untracked blockers in
 *  waves sometimes (a directory that contains several); three passes is more
 *  than any real repo has ever needed. */
const MAX_SYNC_ITERATIONS = 3;

const nowStamp = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function shortSha(s: string): string {
  return (s || '').trim().slice(0, 7);
}

/** Run git, capture output; returns trimmed stdout. Throws with git's own text. */
async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024,
  });
  return String(stdout || '').trim();
}

/** git status --porcelain parsed into {modified, untracked} path lists. */
async function readDirty(cwd: string): Promise<{ modified: string[]; untracked: string[] }> {
  const out = await git(cwd, ['status', '--porcelain'], 20_000);
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    const x = line[0];
    const y = line[1];
    let f = line.slice(3).trim();
    // Renames arrive as "R  old -> new" — the NEW path is what blocks.
    const arrow = f.indexOf(' -> ');
    if (arrow !== -1) f = f.slice(arrow + 4);
    if (f.startsWith('"') && f.endsWith('"') && f.length >= 2) f = f.slice(1, -1).replace(/\\"/g, '"');
    if (x === '?' && y === '?') untracked.push(f);
    else modified.push(f);
  }
  return { modified, untracked };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// v1.39 — backup-step hardening (big trees, stale locks, killed stashes).
//
// The backup stash push carries a hard execFile timeout. On repos with
// large untracked trees (hundreds of MB) `git stash push` has to hash
// EVERY dirty byte before the entry exists, blows past the old fixed 60s,
// and is SIGTERM'd with NO stderr — the surfaced error was the raw Node
// "Command failed: git stash push --include-untracked -m dashboard-agent
// <ts>". Worse: git updates refs/stash BEFORE it resets the worktree, so
// the kill can leave an ORPHAN stash entry plus a half-reset tree, and the
// old stashCreated=false meant the safety rollback never ran — violating
// this module's NOTHING IS EVER LOST invariant. The helpers below precheck
// what can be prechecked, size the budget to the actual tree, detect
// kills, and recover (or honestly report) the orphans they leave behind.
// ---------------------------------------------------------------------------

/** Stash budget floor — even a tiny tree gets a full minute. */
const STASH_MIN_TIMEOUT_MS = 60_000;
/** Stash budget ceiling — even an unmeasurable tree gets at most 10 min. */
const STASH_MAX_TIMEOUT_MS = 600_000;
/** Extra time granted per gigabyte of measured dirty bytes. */
const STASH_MS_PER_GB = 30_000;
/** A retried (killed) stash gets double the budget, capped at 20 min. */
const STASH_RETRY_MAX_TIMEOUT_MS = 20 * 60_000;
/** A .git/index.lock older than this is a crash leftover, not a live op. */
const INDEX_LOCK_STALE_MS = 3 * 60_000;
/** How long a FRESH lock gets to disappear before it is reported held. */
const INDEX_LOCK_WAIT_MS = 8_000;
/** estimateDirtyBytes gives up past either bound (returns Infinity). */
const ESTIMATE_MAX_MS = 5_000;
const ESTIMATE_MAX_FILES = 200_000;

/** Unresolved-conflict paths (UU/AA/DD/AU/… index stages) — `git stash
 *  push` is structurally impossible on an unmerged index (git refuses
 *  with "needs merge"), so detect it BEFORE spending the timeout budget
 *  on a doomed stash and fail fast with the file list. */
export async function unmergedPaths(cwd: string): Promise<string[]> {
  try {
    const out = await git(cwd, ['ls-files', '--unmerged'], 20_000);
    const seen = new Set<string>();
    for (const line of out.split('\n')) {
      const path = line.split('\t')[1];
      if (path) seen.add(path);
    }
    return [...seen];
  } catch {
    return []; // not a repo / unborn HEAD — the later steps report that
  }
}

/** What clearStaleIndexLock found and did about .git/index.lock. */
export type IndexLockOutcome =
  | { status: 'absent' }                 // no lock file at all
  | { status: 'cleared'; ageMs: number } // stale (>3 min) — removed by us
  | { status: 'vanished' }               // fresh lock disappeared while we waited
  | { status: 'held'; ageMs: number };   // still there after 8s — a live op owns it

/** Resolve the repository's index.lock path (linked worktrees keep the
 *  git dir elsewhere — <cwd>/.git/index.lock is only the common case). */
async function indexLockPath(cwd: string): Promise<string> {
  try {
    const gd = await git(cwd, ['rev-parse', '--git-dir'], 15_000);
    if (gd) return isAbsolute(gd) ? join(gd, 'index.lock') : join(cwd, gd, 'index.lock');
  } catch { /* unreadable — the plain .git path is the best guess */ }
  return join(cwd, '.git', 'index.lock');
}

/** Remove a CRASHED git process's .git/index.lock (mtime older than 3
 *  minutes — no live git operation holds the write lock that long). A
 *  fresh lock belongs to a running operation: poll up to 8s for it to
 *  finish; if it does not, say so precisely instead of letting the stash
 *  die with git's "Another git process seems to be running in this
 *  repository, please make sure all processes are terminated". */
export async function clearStaleIndexLock(cwd: string): Promise<IndexLockOutcome> {
  const lockPath = await indexLockPath(cwd);
  const deadline = Date.now() + INDEX_LOCK_WAIT_MS;
  let seen = false;
  for (;;) {
    let ageMs = -1;
    try {
      ageMs = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      return seen ? { status: 'vanished' } : { status: 'absent' };
    }
    seen = true;
    if (ageMs >= INDEX_LOCK_STALE_MS) {
      try {
        rmSync(lockPath, { force: true });
        return { status: 'cleared', ageMs };
      } catch {
        return { status: 'held', ageMs }; // e.g. permissions — the report names it
      }
    }
    if (Date.now() >= deadline) return { status: 'held', ageMs };
    await sleep(200);
  }
}

/** Bounded byte-size estimate of the dirty paths (tracked edits plus the
 *  untracked tree the stash must archive — untracked entries arrive as
 *  directories (`?? dir/`) from porcelain and are walked recursively).
 *  The walk itself is BOUNDED: past ~5 seconds or 200,000 files it gives
 *  up and returns Infinity, so the caller budgets the stash at the
 *  maximum instead of a dangerous lowball. */
export function estimateDirtyBytes(cwd: string, dirtyPaths: string[]): number {
  const startedAt = Date.now();
  let files = 0;
  let total = 0;
  let aborted = false;
  const walk = (abs: string): void => {
    if (aborted) return;
    if (Date.now() - startedAt > ESTIMATE_MAX_MS) {
      aborted = true;
      return;
    }
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(abs);
    } catch {
      return; // vanished mid-walk / unreadable — counts as zero
    }
    if (st.isSymbolicLink()) {
      total += st.size; // never follow — a symlink cycle must not hang the walk
      return;
    }
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(abs);
      } catch {
        return;
      }
      for (const name of names) {
        if (name === '.git') continue; // a nested repo's history is not dirty bytes
        walk(join(abs, name));
        if (aborted) return;
      }
      return;
    }
    files++;
    if (files > ESTIMATE_MAX_FILES) {
      aborted = true;
      return;
    }
    total += st.size;
  };
  for (const p of dirtyPaths) {
    walk(join(cwd, p));
    if (aborted) break;
  }
  return aborted ? Number.POSITIVE_INFINITY : total;
}

/** Stash budget for a measured dirty size: 60s baseline + 30s per GB,
 *  clamped to [60s, 10min]. An unmeasurable tree (Infinity) gets the
 *  10-minute maximum — the stash must never be budgeted below what
 *  hashing the tree actually needs. */
export function stashTimeoutForBytes(bytes: number): number {
  if (!Number.isFinite(bytes)) return STASH_MAX_TIMEOUT_MS;
  const extraMs = (Math.max(0, bytes) / (1024 * 1024 * 1024)) * STASH_MS_PER_GB;
  return Math.min(STASH_MAX_TIMEOUT_MS, Math.max(STASH_MIN_TIMEOUT_MS, Math.round(STASH_MIN_TIMEOUT_MS + extraMs)));
}

/** Find the exact `git stash list` index of a labelled entry. The message
 *  match is anchored at END of line: two agent runs a second apart produce
 *  labels where one is a PREFIX of the other, and an unanchored substring
 *  match returns the wrong entry — the retry/rollback would then pop the
 *  wrong stash. (Lesson burned in during v1.39: regexes built from template
 *  literals need every backslash DOUBLED — `\d` reaches RegExp as \d while
 *  a single `\d` collapses to a literal 'd' and matching silently fails.
 *  The message pattern below deliberately contains no backslashes.) */
export function findStashIndexByLabel(stashList: string, label: string): number | null {
  if (!stashList || !label) return null;
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const msgRe = new RegExp(`: ${esc}$`);
  for (const raw of stashList.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || !msgRe.test(line)) continue;
    const m = line.match(/^stash@\{(\d+)\}/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/** What recoverOrphanedStash did with the entry a killed stash left behind. */
export type OrphanStashRecovery =
  | { kind: 'none' }      // no labelled entry — the kill landed before refs/stash was updated
  | { kind: 'recovered' } // entry popped back into the tree — consumed, no duplicates left
  | { kind: 'kept'; detail: string }; // entry kept (worktree dirty / pop failed) — NEVER dropped silently

/** After a killed `git stash push`, locate the labelled entry it may have
 *  created. When the worktree reset completed (tree clean — everything
 *  lives in the entry), pop it back: the user's changes return to the tree
 *  and the entry is consumed, so a retry starts from the exact pre-run
 *  state and cannot stack a duplicate. When the tree is still dirty the
 *  kill landed mid-reset — popping would collide with the in-tree copies
 *  — so the entry is KEPT and reported with its label for a manual
 *  `git stash pop`. NEVER lose data silently. */
export async function recoverOrphanedStash(
  cwd: string,
  label: string,
  popTimeoutMs = 10 * 60_000,
): Promise<OrphanStashRecovery> {
  let list = '';
  try {
    list = await git(cwd, ['stash', 'list'], 15_000);
  } catch (e) {
    return { kind: 'kept', detail: `git stash list failed — the entry "${label}" was left untouched (${gitErrorText(e).slice(0, 200)})` };
  }
  const idx = findStashIndexByLabel(list, label);
  if (idx === null) return { kind: 'none' };
  let dirtyNow: { modified: string[]; untracked: string[] };
  try {
    dirtyNow = await readDirty(cwd);
  } catch (e) {
    return { kind: 'kept', detail: `git status failed — the entry "${label}" was left untouched (${gitErrorText(e).slice(0, 200)})` };
  }
  if (dirtyNow.modified.length > 0 || dirtyNow.untracked.length > 0) {
    return {
      kind: 'kept',
      detail: `the worktree still holds local changes, so the stash entry "${label}" was kept instead of being popped over them (git stash list / git stash pop stash@{${idx}})`,
    };
  }
  try {
    await execFileAsync('git', ['stash', 'pop', `stash@{${idx}}`], {
      cwd, timeout: popTimeoutMs, maxBuffer: 1024 * 1024,
    });
    return { kind: 'recovered' };
  } catch (e) {
    return {
      kind: 'kept',
      detail: `stash pop failed — the changes remain inside the stash entry "${label}" (${gitErrorText(e).slice(0, 300)})`,
    };
  }
}

/** Actionable text for a stash killed by its budget — a killed child has
 *  NO stderr, so without this the user sees Node's bare "Command failed:
 *  git stash push …". Explains the real cause (tree too large for the
 *  budget) and the way out (.gitignore the big paths). */
export function stashKilledText(cmd: string, budgetMs: number): string {
  const secs = Math.round(budgetMs / 1000);
  return `The backup (${cmd}) was killed after ${secs}s — the working tree is too large for that time budget, git never finished archiving it. The local changes were NOT lost. Add the large directories (build output, node_modules, datasets…) to .gitignore so the stash does not have to archive them, then pull again.`;
}

/** Pop the labelled stash entry (the rollback and the restore phase both
 *  use this). Pops by LABEL: after a killed-then-retried backup our entry
 *  may not be stash@{0}, and a blind pop could apply and DROP an entry we
 *  do not own. When the label cannot be found we refuse (ok:false) —
 *  popping an unidentified entry risks destroying someone else's backup. */
async function popStashByLabel(cwd: string, label: string | undefined, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  let ref = '';
  if (label) {
    const list = await git(cwd, ['stash', 'list'], 15_000).catch(() => '');
    const idx = findStashIndexByLabel(list, label);
    if (idx === null) {
      return { ok: false, detail: `stash entry "${label}" not found — refusing to pop an unidentified entry` };
    }
    ref = `stash@{${idx}}`;
  }
  try {
    const out = await execFileAsync('git', ['stash', 'pop', ...(ref ? [ref] : [])], {
      cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024,
    });
    return { ok: true, detail: String(out.stdout || out.stderr || '').trim() };
  } catch (e: any) {
    return { ok: false, detail: String(e?.stderr || e?.stdout || e?.message || '').trim().slice(0, 600) };
  }
}

/** current branch; '' on detached HEAD, null when HEAD doesn't resolve. */
async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 15_000);
    if (!out || out === 'HEAD') return out === 'HEAD' ? '' : null;
    return out;
  } catch {
    return null; // unborn HEAD on a fresh repo
  }
}

interface UpstreamInfo {
  ref: string;         // e.g. 'origin/main' — what we sync TO
  ahead: number;
  behind: number;
}

/** Resolve the tracking ref for `branch` (configured upstream, else
 *  origin/<branch> when it exists) and its ahead/behind counts. Returns null
 *  when the remote doesn't have the branch at all. */
async function upstreamInfo(cwd: string, branch: string): Promise<UpstreamInfo | null> {
  let ref = '';
  if (branch) {
    try {
      ref = await git(cwd, ['rev-parse', '--abbrev-ref', `--symbolic-full-name`, `${branch}@{u}`], 15_000);
    } catch { /* no upstream configured */ }
    if (!ref || ref.includes(' ')) {
      // fall back to origin/<branch> when it exists
      try {
        await git(cwd, ['rev-parse', '--verify', '--quiet', `origin/${branch}`], 15_000);
        ref = `origin/${branch}`;
      } catch { return null; }
    }
  } else {
    // detached HEAD — nothing to sync against (verify step will report it)
    return null;
  }
  try {
    const counts = await git(cwd, ['rev-list', '--left-right', '--count', `${branch}...${ref}`], 15_000);
    const [ahead, behind] = counts.split(/\s+/).map((n) => parseInt(n, 10) || 0);
    return { ref, ahead, behind };
  } catch {
    return { ref, ahead: 0, behind: 0 };
  }
}

/** Extract the LOCAL (stashed) version of a conflicted path from the index
 *  stages a conflicted `git stash pop` leaves behind (stage 3 = "theirs" =
 *  the stashed edit) and write it next to the file as `<path>.local.bak`.
 *  Fail-soft: returns false when the stage blob is unavailable. */
async function extractLocalCopy(cwd: string, path: string): Promise<boolean> {
  try {
    const content = await git(cwd, ['show', `:3:${path}`], 20_000);
    if (!content) return false;
    const target = join(cwd, `${path}.local.bak`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`);
    return true;
  } catch {
    return false;
  }
}

export interface PullAgentOptions {
  projectPath: string;
  /** Configured repo URL — used to self-heal a missing 'origin' remote. */
  repoUrl?: string;
  /** Optional branch to switch to before syncing. */
  branch?: string;
  /** Progress callback — receives the step that just changed. */
  onProgress?: (step: AgentStep) => void;
}

/**
 * Run the agent. Resolves with the full result (ok:false = failed run —
 * the caller reports it; the engine itself never throws, every failure is
 * converted into a step + result so the timeline always tells the truth).
 */
export async function runPullAgent(opts: PullAgentOptions): Promise<PullAgentResult> {
  const { projectPath, repoUrl, branch } = opts;
  const steps: AgentStep[] = [
    { key: 'preflight', status: 'pending' },
    { key: 'backup', status: 'pending' },
    { key: 'fetch', status: 'pending' },
    { key: 'analyze', status: 'pending' },
    { key: 'switch', status: 'pending' },
    { key: 'sync', status: 'pending' },
    { key: 'restore', status: 'pending' },
    { key: 'verify', status: 'pending' },
  ];
  const artifacts: PullAgentArtifacts = { stash: false, backupFiles: [] };
  const autoResolved: string[] = [];
  const transcript: string[] = [];
  let restored = false;
  let stashCreated = false;
  /** v1.39: the size-aware budget the backup stash ran with — the rollback
   *  and restore pops re-apply the same tree and need the same headroom. */
  let stashBudgetMs = STASH_MIN_TIMEOUT_MS;
  let restoreStarted = false;
  let switchedTo = '';
  let upToDate = false;
  let newerOnDefault: PullAgentResult['newerOnDefault'];
  let fetchDegraded: PullAgentResult['fetchDegraded'];

  const setStep = (key: AgentStep['key'], patch: Partial<AgentStep>) => {
    const s = steps.find((x) => x.key === key);
    if (!s) return;
    Object.assign(s, patch);
    if (patch.note) {
      const bits = [patch.note.key];
      if (patch.note.params) bits.push(Object.entries(patch.note.params).map(([k, v]) => `${k}=${v}`).join(' '));
      transcript.push(`[${key}] ${bits.join(' · ')}`);
    }
    if (patch.info) transcript.push(`[${key}:info] ${patch.info.split('\n').slice(0, 4).join(' | ').slice(0, 300)}`);
    opts.onProgress?.({ ...s });
  };

  const finish = async (ok: boolean, summary: string, error?: string, detail?: string): Promise<PullAgentResult> => {
    // Failure-path invariant: if the run dies AFTER the safety stash was
    // created but BEFORE the restore phase ever ran, pop the stash back so
    // the working tree returns to its pre-run state (the v1.17 pull route's
    // contract — the user should never have to know a stash exists). When
    // even that pop fails, the changes stay safe IN the stash and the report
    // says so explicitly.
    let rolledBack: PullAgentResult['rolledBack'];
    if (!ok && stashCreated && !restoreStarted) {
      restoreStarted = true; // prevent double-pop on later finish() calls
      // v1.39: pop by LABEL with the same budget the push got — after a
      // killed-then-retried backup our entry may not be stash@{0}, and a
      // blind pop could apply and DROP an entry we do not own. When the
      // label cannot be found we report 'kept' rather than touch an
      // unidentified entry (NOTHING IS EVER LOST — including stashes
      // that are not ours).
      const pop = await popStashByLabel(projectPath, artifacts.stashLabel, stashBudgetMs);
      if (pop.ok) {
        stashCreated = false;
        artifacts.stash = false;
        restored = true;
        rolledBack = 'restored';
        transcript.push('[rollback] aborted before sync — local changes restored to the working tree');
      } else {
        rolledBack = 'kept';
        transcript.push(`[rollback] aborted before sync — local changes remain in the git stash entry (label: ${artifacts.stashLabel || 'unknown'}; git stash list)`);
      }
    }
    return {
      ok,
    upToDate,
    before: beforeSha,
    after: afterSha,
    ...(switchedTo ? { switchedTo } : {}),
    ...(newerOnDefault ? { newerOnDefault } : {}),
    ...(rolledBack ? { rolledBack } : {}),
    ...(fetchDegraded ? { fetchDegraded } : {}),
    restored,
    autoResolved,
    artifacts,
    steps: steps.map((s) => ({ ...s })),
    summary,
    output: transcript.join('\n').slice(0, 6000),
    ...(error ? { error } : {}),
    ...(detail ? { detail: detail.slice(0, 800) } : {}),
    };
  };

  let beforeSha = '';
  let afterSha = '';

  // ---------------- preflight ----------------
  setStep('preflight', { status: 'running' });
  try {
    if (!existsSync(projectPath) || !existsSync(join(projectPath, '.git'))) {
      setStep('preflight', { status: 'fail', note: { key: 'dlg.pullAgent.note.noRepo' } });
      return finish(false, 'not a git repository', 'Not a git repository', projectPath);
    }
    const branchNow = await currentBranch(projectPath);
    const dirty = await readDirty(projectPath);
    try { beforeSha = shortSha(await git(projectPath, ['rev-parse', '--short', 'HEAD'], 15_000)); } catch { /* unborn */ }
    setStep('preflight', {
      status: 'ok',
      note: {
        key: 'dlg.pullAgent.note.preflight',
        params: {
          branch: branchNow || '(detached)',
          modified: dirty.modified.length,
          untracked: dirty.untracked.length,
        },
      },
    });
  } catch (e) {
    setStep('preflight', { status: 'fail', note: { key: 'dlg.pullAgent.note.preflightFail' }, info: gitErrorText(e) });
    return finish(false, 'preflight failed', 'Reading the repository state failed', gitErrorText(e));
  }

  // ---------------- backup ----------------
  setStep('backup', { status: 'running' });
  let dirtyBefore: { modified: string[]; untracked: string[] } = { modified: [], untracked: [] };
  try {
    dirtyBefore = await readDirty(projectPath);

    // v1.39 precheck 1 — unmerged index. `git stash push` is structurally
    // impossible while conflict stages (UU/AA/DD/…) are registered — git
    // refuses with "needs merge" — so fail fast with the file list instead
    // of burning the whole timeout budget on a doomed stash.
    const unmerged = await unmergedPaths(projectPath);
    if (unmerged.length > 0) {
      const shown = unmerged.slice(0, 5).join(', ') + (unmerged.length > 5 ? ` … (+${unmerged.length - 5} more)` : '');
      setStep('backup', {
        status: 'fail',
        note: { key: 'dlg.pullAgent.note.backupUnmerged', params: { count: unmerged.length, files: shown } },
        info: unmerged.join('\n').slice(0, 400),
      });
      return finish(false, 'backup blocked by unresolved conflicts', 'Unresolved merge conflicts block the backup stash — resolve or commit them first', unmerged.join('\n').slice(0, 800));
    }

    // v1.39 precheck 2 — .git/index.lock. A crashed git process leaves the
    // lock behind and every later write fails with "Another git process
    // seems to be running in this repository". Stale locks (>3 min) are
    // removed; a FRESH one gets 8s to finish before we name the blocker.
    const lock = await clearStaleIndexLock(projectPath);
    if (lock.status === 'cleared') {
      setStep('backup', {
        note: { key: 'dlg.pullAgent.note.backupLockCleared' },
        info: `removed stale .git/index.lock (age ${Math.round(lock.ageMs / 1000)}s)`,
      });
    } else if (lock.status === 'held') {
      const lockSecs = Math.round(lock.ageMs / 1000);
      setStep('backup', { status: 'fail', note: { key: 'dlg.pullAgent.note.backupFail' }, info: `.git/index.lock has been held for ${lockSecs}s` });
      return finish(false, 'index.lock held', 'Another git operation is currently holding .git/index.lock — wait for it to finish (or remove the lock file if no git process is running) and pull again', `.git/index.lock has been held for ${lockSecs}s — a live git operation (editor / IDE / another pull) owns it.`);
    }

    const label = `dashboard-agent ${nowStamp()}`;
    if (dirtyBefore.modified.length === 0 && dirtyBefore.untracked.length === 0) {
      setStep('backup', { status: 'ok', note: { key: 'dlg.pullAgent.note.backupNone' } });
    } else {
      // v1.39 — size-aware stash budget. `git stash push` has to hash every
      // dirty byte (the untracked tree included) before the entry exists;
      // the old fixed 60s reaped it on large trees with a SIGTERM that
      // carries NO stderr, surfacing as the raw "Command failed: git stash
      // push --include-untracked -m dashboard-agent <ts>". Budget from the
      // measured size: 60s baseline + 30s/GB, clamped to [60s, 10min].
      const dirtyBytes = estimateDirtyBytes(projectPath, [...dirtyBefore.modified, ...dirtyBefore.untracked]);
      stashBudgetMs = stashTimeoutForBytes(dirtyBytes);
      const stashArgs = ['stash', 'push', '--include-untracked', '-m', label];
      const cmdText = `git ${stashArgs.join(' ')}`;
      const runStashPush = async (budgetMs: number): Promise<{ ok: boolean; stdout: string }> => {
        try {
          const r = await execFileAsync('git', stashArgs, {
            cwd: projectPath, timeout: budgetMs, maxBuffer: 1024 * 1024,
          });
          return { ok: true, stdout: r.stdout || '' };
        } catch (e) {
          if (!isGitKilledError(e)) throw e; // git's own failure — its stderr says why
          return { ok: false, stdout: '' };  // killed by the budget (no stderr at all)
        }
      };
      let attempt = await runStashPush(stashBudgetMs);
      // The killed child may have died holding .git/index.lock. The precheck
      // established the lock was ABSENT before this attempt and our child
      // was the only git write since — any lock that exists now is our
      // corpse's, safe to remove (the retry would otherwise die with git's
      // "Another git process seems to be running…").
      const clearKilledLock = async (): Promise<void> => {
        try {
          const leftoverLock = await indexLockPath(projectPath);
          if (existsSync(leftoverLock)) {
            rmSync(leftoverLock, { force: true });
            setStep('backup', { info: 'removed .git/index.lock left behind by the killed stash attempt' });
          }
        } catch { /* best effort — a real lock holder surfaces in the retry */ }
      };
      if (!attempt.ok) {
        // Killed by the budget. git updates refs/stash BEFORE it resets the
        // worktree, so the kill can leave an ORPHAN entry plus a half-reset
        // tree. Recover the orphan FIRST — popped back when the reset had
        // completed — so the retry runs on a consistent tree and cannot
        // stack a duplicate entry on the first attempt's leftovers.
        await clearKilledLock();
        const rec = await recoverOrphanedStash(projectPath, label);
        if (rec.kind === 'recovered') {
          setStep('backup', { note: { key: 'dlg.pullAgent.note.backupRecovered' } });
        } else if (rec.kind === 'kept') {
          // The orphan could not be re-applied — its content stays SAFE in
          // the labelled entry. No retry: a second push would stack a
          // duplicate entry. Report honestly where the data lives.
          artifacts.stash = true;
          artifacts.stashLabel = label;
          setStep('backup', { status: 'fail', note: { key: 'dlg.pullAgent.note.backupOrphanKept', params: { label } }, info: rec.detail });
          return finish(false, 'backup interrupted', 'The backup stash was interrupted — the local changes remain safe inside the stash entry (see the label in the report)', rec.detail);
        }
        // 'none' (killed before the ref was updated — tree untouched) or
        // 'recovered' (orphan popped back — tree dirty again): retry ONCE
        // with a doubled budget.
        stashBudgetMs = Math.min(stashBudgetMs * 2, STASH_RETRY_MAX_TIMEOUT_MS);
        setStep('backup', { note: { key: 'dlg.pullAgent.note.backupRetrySlow', params: { seconds: Math.round(stashBudgetMs / 1000) } } });
        attempt = await runStashPush(stashBudgetMs);
        if (!attempt.ok) {
          // Second kill — salvage whatever this attempt left behind (the
          // same recovery contract), then report with the actionable
          // killed-text instead of the raw Node message.
          await clearKilledLock();
          const rec2 = await recoverOrphanedStash(projectPath, label);
          if (rec2.kind === 'kept') {
            artifacts.stash = true;
            artifacts.stashLabel = label;
            setStep('backup', { status: 'fail', note: { key: 'dlg.pullAgent.note.backupOrphanKept', params: { label } }, info: rec2.detail });
            return finish(false, 'backup interrupted twice', 'The backup stash was interrupted twice — the local changes remain safe inside the stash entry (see the label in the report)', rec2.detail);
          }
          if (rec2.kind === 'recovered') {
            setStep('backup', { note: { key: 'dlg.pullAgent.note.backupRecovered' } });
          }
          setStep('backup', { status: 'fail', note: { key: 'dlg.pullAgent.note.backupFail' }, info: stashKilledText(cmdText, stashBudgetMs) });
          // 'none' → tree untouched, 'recovered' → changes popped back: in
          // BOTH cases the worktree again holds every local change — the
          // run aborts with the user's tree exactly as it was.
          return finish(false, 'backup timed out', 'Backing up the local changes timed out — nothing was lost', stashKilledText(cmdText, stashBudgetMs));
        }
      }
      if (/No local changes/i.test(attempt.stdout)) {
        setStep('backup', { status: 'ok', note: { key: 'dlg.pullAgent.note.backupNone' } });
      } else {
        stashCreated = true;
        artifacts.stash = true;
        artifacts.stashLabel = label;
        setStep('backup', {
          status: 'ok',
          note: {
            key: 'dlg.pullAgent.note.backupStash',
            params: { count: dirtyBefore.modified.length + dirtyBefore.untracked.length },
          },
        });
      }
    }
  } catch (e) {
    setStep('backup', { status: 'fail', note: { key: 'dlg.pullAgent.note.backupFail' }, info: gitErrorText(e) });
    return finish(false, 'backup failed', 'Backing up the local changes failed', gitErrorText(e));
  }

  // ---------------- fetch (v1.27 strategy ladder) ----------------
  // Direct HTTP/2 fetches to github.com die on throttled links in two ways:
  // mid-TLS resets ("Recv failure: Connection was reset") and stalled
  // transfers reaped at the timeout (NO stderr at all — the bare "Command
  // failed" the user saw). Both are network pathologies, not repository
  // problems, so the fetch escalates through strategies before giving up:
  //   1. plain fetch (HTTP/2, transient-retried inside)
  //   2. HTTP/1.1 — the classic workaround for resets through flaky boxes
  //   3. configured proxy (Settings → Git Network), if any
  // When every strategy fails but the repo has CACHED remote-tracking refs
  // for the target, the run DEGRADES to syncing against the last known
  // remote state instead of aborting — a branch switch + sync still
  // completes offline, and the result carries fetchDegraded so the report
  // names the stale data honestly (never a silent "up to date").
  setStep('fetch', { status: 'running' });
  try {
    // Self-heal a missing 'origin' from the configured repo URL (v1.9 logic).
    let originUrl = '';
    try {
      originUrl = await git(projectPath, ['remote', 'get-url', 'origin'], 15_000);
    } catch { /* no origin */ }
    if (!originUrl) {
      const want = (repoUrl || '').trim();
      if (!want || !/^https?:\/\//.test(want)) {
        setStep('fetch', { status: 'fail', note: { key: 'dlg.pullAgent.note.noOrigin' } });
        return finish(false, 'no origin remote', "No 'origin' remote is configured and the project has no repository URL");
      }
      await git(projectPath, ['remote', 'add', 'origin', want], 15_000);
      setStep('fetch', { note: { key: 'dlg.pullAgent.note.originWired' }, info: `git remote add origin <configured-url>` });
    }

    const netCfg = await getGitNetConfig();
    const strategies: { id: 'plain' | 'http11' | 'proxy'; timeoutMs: number; args: string[] }[] = [
      { id: 'plain', timeoutMs: 3 * 60_000, args: ['fetch', 'origin', '--prune'] },
      { id: 'http11', timeoutMs: 5 * 60_000, args: ['-c', 'http.version=HTTP/1.1', 'fetch', 'origin', '--prune'] },
    ];
    if (netCfg.proxy) {
      strategies.push({
        id: 'proxy', timeoutMs: 5 * 60_000,
        args: [...gitProxyArgs(netCfg.proxy), '-c', 'http.version=HTTP/1.1', 'fetch', 'origin', '--prune'],
      });
    }
    let fetchErr: unknown = null;
    let fetchErrTimeout = 0;
    let totalRetried = 0;
    let fetched = false;
    for (let i = 0; i < strategies.length; i++) {
      const st = strategies[i];
      if (i > 0) {
        setStep('fetch', { note: { key: st.id === 'http11' ? 'dlg.pullAgent.note.fetchHttp11' : 'dlg.pullAgent.note.fetchViaProxy' } });
      }
      try {
        const fr = await execGitNetwork(st.args, {
          cwd: projectPath, timeout: st.timeoutMs, maxBuffer: 4 * 1024 * 1024,
        });
        totalRetried += fr.retried;
        fetched = true;
        break;
      } catch (e) {
        fetchErr = e;
        fetchErrTimeout = st.timeoutMs;
        // Hard failures (auth, repo missing, bad refspec…) gain nothing from
        // the fallbacks — escalate ONLY on network-class failures.
        if (!isTransientGitNetworkError(e)) break;
      }
    }
    if (fetched) {
      if (totalRetried > 0) {
        setStep('fetch', { note: { key: 'dlg.pullAgent.note.fetchRetried', params: { n: totalRetried } } });
      }
      setStep('fetch', { status: 'ok', note: { key: 'dlg.pullAgent.note.fetched' } });
    } else {
      const errText = gitNetworkErrorText(fetchErr, fetchErrTimeout);
      // Degraded continue: cached origin refs let switch + sync still run
      // against the last known remote state.
      const targetRef = branch || (await currentBranch(projectPath)) || '';
      let cachedRef = '';
      if (targetRef) {
        try {
          await git(projectPath, ['rev-parse', '--verify', '--quiet', `origin/${targetRef}`], 15_000);
          cachedRef = `origin/${targetRef}`;
        } catch { /* no cached ref for the target branch */ }
      }
      if (cachedRef) {
        fetchDegraded = { ref: cachedRef, error: errText.slice(0, 400) };
        setStep('fetch', { status: 'warn', note: { key: 'dlg.pullAgent.note.fetchDegraded', params: { ref: cachedRef } }, info: errText });
      } else {
        setStep('fetch', { status: 'fail', note: { key: 'dlg.pullAgent.note.fetchFail' }, info: errText });
        // Nothing destructive has happened yet — the tree is as it was (plus
        // the safety stash, which finish() rolls back for us).
        return finish(false, 'fetch failed', 'Fetching the remote failed', errText);
      }
    }
  } catch (e) {
    setStep('fetch', { status: 'fail', note: { key: 'dlg.pullAgent.note.fetchFail' }, info: gitErrorText(e) });
    // Nothing destructive has happened yet — the tree is as it was (plus the
    // safety stash, which we KEEP: it is the user's backup).
    return finish(false, 'fetch failed', 'Fetching the remote failed', gitErrorText(e));
  }

  // ---------------- analyze ----------------
  setStep('analyze', { status: 'running' });
  let targetBranch = '';
  let up: UpstreamInfo | null = null;
  try {
    targetBranch = (await currentBranch(projectPath)) ?? '';
    if (branch && branch !== targetBranch) {
      // switching later — analyze against the TARGET branch's remote
      try {
        await git(projectPath, ['rev-parse', '--verify', '--quiet', `origin/${branch}`], 15_000);
        up = { ref: `origin/${branch}`, ahead: 0, behind: 1 }; // unknown yet; sync step computes precisely
      } catch {
        setStep('analyze', { status: 'fail', note: { key: 'dlg.pullAgent.note.noSuchBranch', params: { branch } } });
        return finish(false, 'branch not found', `Remote branch not found: ${branch}`);
      }
      setStep('analyze', { status: 'ok', note: { key: 'dlg.pullAgent.note.analyzeSwitch', params: { from: targetBranch || '(detached)', to: branch } } });
    } else if (!targetBranch) {
      setStep('analyze', { status: 'warn', note: { key: 'dlg.pullAgent.note.detached' } });
    } else {
      up = await upstreamInfo(projectPath, targetBranch);
      if (!up) {
        setStep('analyze', { status: 'fail', note: { key: 'dlg.pullAgent.note.noUpstream', params: { branch: targetBranch } } });
        return finish(false, 'no upstream', `The remote has no branch '${targetBranch}'`);
      }
      setStep('analyze', {
        status: 'ok',
        note: { key: 'dlg.pullAgent.note.analyze', params: { ahead: up.ahead, behind: up.behind, ref: up.ref } },
      });
    }
  } catch (e) {
    setStep('analyze', { status: 'fail', note: { key: 'dlg.pullAgent.note.analyzeFail' }, info: gitErrorText(e) });
    return finish(false, 'analyze failed', 'Analyzing the branch state failed', gitErrorText(e));
  }

  // ---------------- switch (optional) ----------------
  if (branch && branch !== targetBranch) {
    setStep('switch', { status: 'running' });
    try {
      // A clean tree (guaranteed by the backup step) makes checkout safe.
      // Local branch that already exists → plain checkout keeps its commits.
      try {
        await git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], 15_000);
        await git(projectPath, ['checkout', branch], 60_000);
      } catch {
        await git(projectPath, ['checkout', '-b', branch, '--track', `origin/${branch}`], 60_000);
      }
      switchedTo = branch;
      targetBranch = branch;
      up = await upstreamInfo(projectPath, branch);
      setStep('switch', { status: 'ok', note: { key: 'dlg.pullAgent.note.switched', params: { branch } } });
    } catch (e) {
      setStep('switch', { status: 'fail', note: { key: 'dlg.pullAgent.note.switchFail', params: { branch } }, info: gitErrorText(e) });
      return finish(false, 'branch switch failed', `git checkout ${branch} failed`, gitErrorText(e));
    }
  } else {
    setStep('switch', { status: 'skipped' });
  }

  // ---------------- sync ----------------
  setStep('sync', { status: 'running' });
  try {
    if (!up) {
      // detached HEAD with nothing to sync — nothing to do but say so.
      setStep('sync', { status: 'warn', note: { key: 'dlg.pullAgent.note.syncDetached' } });
      upToDate = true;
    } else {
      // Re-compute after the (possible) switch.
      const info = await upstreamInfo(projectPath, targetBranch);
      const ref = info?.ref || up.ref;
      const ahead = info?.ahead ?? up.ahead;
      const behind = info?.behind ?? up.behind;

      if (behind === 0 && ahead === 0) {
        upToDate = true;
        setStep('sync', { status: 'ok', note: { key: 'dlg.pullAgent.note.uptodate', params: { ref } } });
      } else if (ahead > 0) {
        // Diverged / local-only commits — back them up on a branch FIRST,
        // then take the remote tip. The commits stay fully recoverable.
        const backupBranch = `dashboard-backup/${targetBranch || 'HEAD'}/${nowStamp()}`;
        await git(projectPath, ['branch', backupBranch], 15_000);
        artifacts.branch = backupBranch;
        await git(projectPath, ['reset', '--hard', ref], 60_000);
        upToDate = false;
        setStep('sync', {
          status: 'ok',
          note: { key: 'dlg.pullAgent.note.syncReset', params: { ref, ahead, backup: backupBranch } },
        });
      } else {
        // Fast-forward path — with loop-guard for surprise blockers.
        let pulled = false;
        for (let attempt = 0; attempt < MAX_SYNC_ITERATIONS && !pulled; attempt++) {
          try {
            const args = ['pull', '--ff-only'];
            try {
              await git(projectPath, ['rev-parse', '--abbrev-ref', '@{u}'], 15_000);
            } catch {
              args.push(ref); // no upstream configured → pull <ref> directly
            }
            await git(projectPath, args, 5 * 60_000);
            pulled = true;
          } catch (e) {
            const errText = gitErrorText(e);
            const cf = parsePullConflict(errText);
            if (cf) {
              // Everything is already backed up in the safety stash — the
              // blockers reappearing here can only be files the FETCH or a
              // hook recreated. Remove exactly them and retry (bounded).
              if (cf.untracked.length > 0) {
                await execFileAsync('git', ['clean', '-fd', '--', ...cf.untracked.map((f) => `./${f}`)], {
                  cwd: projectPath, timeout: 30_000, maxBuffer: 1024 * 1024,
                }).catch(() => { /* retried below / surfaced if pull still fails */ });
              }
              if (cf.modified.length > 0) {
                await execFileAsync('git', ['checkout', 'HEAD', '--', ...cf.modified.map((f) => `./${f}`)], {
                  cwd: projectPath, timeout: 30_000, maxBuffer: 1024 * 1024,
                }).catch(() => { /* ditto */ });
              }
              continue;
            }
            throw e;
          }
        }
        if (!pulled) throw new Error('pull did not complete after clearing blockers');
        setStep('sync', { status: 'ok', note: { key: 'dlg.pullAgent.note.syncFF' } });
      }
    }
  } catch (e) {
    setStep('sync', { status: 'fail', note: { key: 'dlg.pullAgent.note.syncFail' }, info: gitErrorText(e) });
    return finish(false, 'sync failed', 'Syncing to the remote failed', gitErrorText(e));
  }

  try { afterSha = shortSha(await git(projectPath, ['rev-parse', '--short', 'HEAD'], 15_000)); } catch { /* unborn */ }

  // ---------------- restore ----------------
  if (!stashCreated) {
    setStep('restore', { status: 'skipped', note: { key: 'dlg.pullAgent.note.restoreSkipped' } });
  } else {
    restoreStarted = true;
    setStep('restore', { status: 'running' });
    try {
      // v1.39: pop by LABEL with the same size-aware budget the push got —
      // re-applying a hundreds-of-MB stash dies at a fixed 60s exactly like
      // the push did, and a blind stash@{0} pop could apply and DROP an
      // entry we do not own.
      const pop = await popStashByLabel(projectPath, artifacts.stashLabel, stashBudgetMs);
      if (pop.ok) {
        restored = true;
        setStep('restore', { status: 'ok', note: { key: 'dlg.pullAgent.note.restored' } });
      } else {
        const popText = pop.detail;
        const unmergedOut = await git(projectPath, ['diff', '--name-only', '--diff-filter=U'], 20_000).catch(() => '');
        const unmerged = unmergedOut.split('\n').map((s) => s.trim()).filter(Boolean);

        // Extract any stashed UNTRACKED copies that failed to restore (the
        // remote now tracks those paths) as .local.bak files — shared by the
        // partial class and the combined conflict+untracked class. Untracked
        // blobs live in the stash's third parent.
        const extractUntrackedCopies = async (): Promise<number> => {
          let extracted = 0;
          if (!/could not restore untracked files from stash/i.test(popText)) return extracted;
          const stashList = await git(projectPath, ['stash', 'list'], 15_000).catch(() => '');
          if (!/^stash@\{/.test(stashList)) return extracted;
          // v1.39: read OUR entry (by label) — after a killed-then-retried
          // backup it is not guaranteed to be stash@{0}.
          const ourIdx = findStashIndexByLabel(stashList, artifacts.stashLabel || '');
          const stashRef = ourIdx === null ? 'stash@{0}' : `stash@{${ourIdx}}`;
          for (const f of dirtyBefore.untracked) {
            try {
              const content = await git(projectPath, ['show', `${stashRef}^3:${f}`], 20_000);
              if (!content) continue;
              const target = join(projectPath, `${f}.local.bak`);
              mkdirSync(dirname(target), { recursive: true });
              writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`);
              artifacts.backupFiles.push(`${f}.local.bak`);
              extracted++;
            } catch { /* file not in the untracked commit */ }
          }
          return extracted;
        };

        if (/could not restore untracked files from stash/i.test(popText) && unmerged.length === 0) {
          // Partial class: tracked changes applied; the former untracked
          // blockers are now tracked files — their local copies stay in the
          // stash entry AND are extracted as .local.bak so the user can see
          // them without knowing git stash.
          const extracted = await extractUntrackedCopies();
          restored = true;
          setStep('restore', {
            status: 'warn',
            note: { key: extracted > 0 ? 'dlg.pullAgent.note.restoreUntrackedBak' : 'dlg.pullAgent.note.restorePartial', params: { count: extracted } },
          });
        } else if (unmerged.length > 0) {
          // Conflict class: resolve DETERMINISTICALLY — pulled version stays
          // in the tree (clean, buildable), local version extracted as
          // .local.bak + kept in the stash entry (git never drops a stash
          // that conflicted).
          const okExtracts: string[] = [];
          for (const f of unmerged) {
            const ok = await extractLocalCopy(projectPath, f);
            if (ok) {
              artifacts.backupFiles.push(`${f}.local.bak`);
              okExtracts.push(f);
            }
            autoResolved.push(f);
          }
          // Combined class (conflict + untracked collision): also surface the
          // stashed untracked copies that could not be restored.
          const extractedUntracked = await extractUntrackedCopies();
          void extractedUntracked;
          // Take "ours" (the just-pulled version) for every unmerged path and
          // mark the conflict resolved, then unstage so the user's other
          // re-applied edits land as ordinary working-tree changes.
          await execFileAsync('git', ['checkout', '--ours', '--', ...unmerged], {
            cwd: projectPath, timeout: 30_000, maxBuffer: 1024 * 1024,
          }).catch(() => { /* markers already gone via .ours when available */ });
          await execFileAsync('git', ['add', '--', ...unmerged], {
            cwd: projectPath, timeout: 30_000, maxBuffer: 1024 * 1024,
          }).catch(() => { /* */ });
          await execFileAsync('git', ['reset', '--', ...unmerged], {
            cwd: projectPath, timeout: 30_000, maxBuffer: 1024 * 1024,
          }).catch(() => { /* */ });
          await execFileAsync('git', ['reset'], {
            cwd: projectPath, timeout: 30_000, maxBuffer: 1024 * 1024,
          }).catch(() => { /* */ });
          setStep('restore', {
            status: 'warn',
            note: { key: 'dlg.pullAgent.note.restoreConflict', params: { count: unmerged.length } },
            info: unmerged.join('\n').slice(0, 400),
          });
        } else {
          setStep('restore', {
            status: 'warn',
            note: { key: 'dlg.pullAgent.note.restoreKept' },
            info: popText.slice(0, 400),
          });
        }
      }
    } catch (e) {
      setStep('restore', { status: 'fail', note: { key: 'dlg.pullAgent.note.restoreFail' }, info: gitErrorText(e) });
      // The pull DID complete — this is a warn-class failure in spirit, but
      // we keep the strict reporting: stash is kept, nothing is lost.
      return finish(false, 'restore failed', 'Re-applying the local changes failed (they remain safe in the git stash)', gitErrorText(e));
    }
  }

  // ---------------- verify ----------------
  setStep('verify', { status: 'running' });
  try {
    const finalBranch = await currentBranch(projectPath);
    let syncNote = '';
    if (finalBranch) {
      const info = await upstreamInfo(projectPath, finalBranch);
      if (info) {
        const remoteSha = shortSha(await git(projectPath, ['rev-parse', '--short', info.ref], 15_000).catch(() => ''));
        syncNote = `HEAD ${afterSha || '?'} / ${info.ref} ${remoteSha || '?'} · ${info.ahead} ahead / ${info.behind} behind`;
      }
    }
    const dirtyAfter = await readDirty(projectPath);
    setStep('verify', {
      status: 'ok',
      note: {
        key: 'dlg.pullAgent.note.verify',
        params: {
          branch: finalBranch || '(detached)',
          head: afterSha || '?',
          modified: dirtyAfter.modified.length,
          untracked: dirtyAfter.untracked.length,
        },
      },
      info: syncNote,
    });

    // v1.25: "up to date" on the CHECKED-OUT branch can still mean the
    // repository moved on — the sync step targeted this branch's upstream,
    // not the remote's default branch. A checkout parked on a stale side
    // branch (classic: 'v3-base', 100+ commits behind 'main') reports
    // "already up to date" on every run while the default branch runs away.
    // Detect the contradiction so the result/dialog can offer the switch.
    try {
      if (finalBranch) {
        let defaultBranch = '';
        try {
          // Cheapest source: the local remote-tracking HEAD symref (set at
          // clone time; often unset on copied/zipped checkouts).
          defaultBranch = (await git(projectPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 15_000))
            .replace(/^origin\//, '');
        } catch { /* origin/HEAD unset — ask the remote directly */ }
        if (!defaultBranch) {
          try {
            const sym = await git(projectPath, ['ls-remote', '--symref', 'origin', 'HEAD'], 30_000);
            const m = sym.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
            if (m) defaultBranch = m[1];
          } catch { /* offline — skip the check entirely */ }
        }
        if (defaultBranch && defaultBranch !== finalBranch) {
          const behind =
            parseInt(await git(projectPath, ['rev-list', '--count', `HEAD..origin/${defaultBranch}`], 15_000), 10) || 0;
          if (behind > 0) {
            const remoteSha = shortSha(
              await git(projectPath, ['rev-parse', '--short', `origin/${defaultBranch}`], 15_000).catch(() => ''),
            );
            newerOnDefault = { branch: defaultBranch, behind, remoteSha };
            setStep('verify', {
              status: 'warn',
              note: {
                key: 'dlg.pullAgent.note.newerOnDefault',
                params: { current: finalBranch, branch: defaultBranch, behind },
              },
            });
          }
        }
      }
    } catch { /* best-effort — the verify step already succeeded above */ }
  } catch (e) {
    setStep('verify', { status: 'warn', note: { key: 'dlg.pullAgent.note.verifyWarn' }, info: gitErrorText(e) });
  }

  // ---------------- summary ----------------
  const bits: string[] = [];
  if (switchedTo) bits.push(`switched to ${switchedTo}`);
  bits.push(upToDate ? 'already up to date' : (beforeSha && afterSha && beforeSha !== afterSha ? `${beforeSha} → ${afterSha}` : 'synced'));
  if (fetchDegraded) bits.push(`fetch failed — synced against cached ${fetchDegraded.ref}`);
  if (artifacts.stash && restored) bits.push('local changes restored');
  if (autoResolved.length > 0) bits.push(`${autoResolved.length} conflict(s) auto-resolved`);
  if (artifacts.branch) bits.push(`local commits saved to ${artifacts.branch}`);
  return finish(true, bits.join(' · '));
}

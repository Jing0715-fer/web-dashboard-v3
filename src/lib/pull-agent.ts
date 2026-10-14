import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { execGitNetwork, gitErrorText } from '@/lib/git-retry';
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
  let restoreStarted = false;
  let switchedTo = '';
  let upToDate = false;
  let newerOnDefault: PullAgentResult['newerOnDefault'];

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
    if (!ok && stashCreated && !restoreStarted) {
      restoreStarted = true; // prevent double-pop on later finish() calls
      try {
        await execFileAsync('git', ['stash', 'pop'], {
          cwd: projectPath, timeout: 60_000, maxBuffer: 1024 * 1024,
        });
        stashCreated = false;
        artifacts.stash = false;
        restored = true;
        transcript.push('[rollback] aborted before sync — local changes restored to the working tree');
      } catch {
        transcript.push('[rollback] aborted before sync — local changes remain in the git stash entry (git stash list)');
      }
    }
    return {
      ok,
    upToDate,
    before: beforeSha,
    after: afterSha,
    ...(switchedTo ? { switchedTo } : {}),
    ...(newerOnDefault ? { newerOnDefault } : {}),
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
    const label = `dashboard-agent ${nowStamp()}`;
    if (dirtyBefore.modified.length === 0 && dirtyBefore.untracked.length === 0) {
      setStep('backup', { status: 'ok', note: { key: 'dlg.pullAgent.note.backupNone' } });
    } else {
      const out = await execFileAsync('git', ['stash', 'push', '--include-untracked', '-m', label], {
        cwd: projectPath, timeout: 60_000, maxBuffer: 1024 * 1024,
      });
      if (/No local changes/i.test(out.stdout || '')) {
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

  // ---------------- fetch ----------------
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
    const fr = await execGitNetwork(['fetch', 'origin', '--prune'], {
      cwd: projectPath, timeout: 3 * 60_000, maxBuffer: 1024 * 1024,
    });
    if (fr.retried > 0) {
      setStep('fetch', { note: { key: 'dlg.pullAgent.note.fetchRetried', params: { n: fr.retried } } });
    }
    setStep('fetch', { status: 'ok', note: { key: 'dlg.pullAgent.note.fetched' } });
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
      try {
        await execFileAsync('git', ['stash', 'pop'], {
          cwd: projectPath, timeout: 60_000, maxBuffer: 1024 * 1024,
        });
        restored = true;
        setStep('restore', { status: 'ok', note: { key: 'dlg.pullAgent.note.restored' } });
      } catch (popErr: any) {
        const popText = String(popErr?.stderr || popErr?.stdout || popErr?.message || '');
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
          for (const f of dirtyBefore.untracked) {
            try {
              const content = await git(projectPath, ['show', `stash@{0}^3:${f}`], 20_000);
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
  if (artifacts.stash && restored) bits.push('local changes restored');
  if (autoResolved.length > 0) bits.push(`${autoResolved.length} conflict(s) auto-resolved`);
  if (artifacts.branch) bits.push(`local commits saved to ${artifacts.branch}`);
  return finish(true, bits.join(' · '));
}

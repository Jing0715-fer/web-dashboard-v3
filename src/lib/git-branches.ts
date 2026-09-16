import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';

// execFile with windowsHide ON by default: git.exe / git-remote-https.exe
// are console-subsystem programs — from a console-less dashboard server
// (supervisor/scheduled start) every git call allocates a WINDOW on the
// user's desktop. CREATE_NO_WINDOW on Windows, no-op elsewhere.
const execFileRawAsync = promisify(execFile);
const execFileAsync = (file: string, args: string[], opts: any = {}): Promise<{ stdout: string; stderr: string }> =>
  execFileRawAsync(file, args, { windowsHide: true, ...opts }) as unknown as Promise<{ stdout: string; stderr: string }>;

/** One entry of the branch list shown in the switch-branch picker. */
export interface GitBranchInfo {
  /** Branch name (no origin/ prefix — local and remote refs are merged). */
  name: string;
  /** True when the checkout is currently on this branch. */
  current: boolean;
  /** True when this branch only exists on the remote (origin/name), i.e. it
   *  would be created locally by `git checkout -b name origin/name`. */
  remote: boolean;
}

/** Result of listGitBranches — `current` is duplicated per-entry for easy
 *  rendering; null current = detached HEAD / unreadable repo. */
export interface GitBranchList {
  current: string | null;
  branches: GitBranchInfo[];
  error?: string;
}

/** Result of switchGitBranch — used by the pull route to chain checkout+pull. */
export interface GitSwitchResult {
  ok: boolean;
  /** What happened — surfaced in the pull output / activity log. */
  note: string;
  error?: string;
}

const GIT_TIMEOUT = 15000;
const FETCH_TIMEOUT = 60_000;

/**
 * Branch-name guard for user-supplied values (API body → git argv). Git
 * refnames may contain almost anything, but we only accept a conservative
 * subset: letters, digits, `. _ / -`, not starting with `-` or `.`, no `..`,
 * no trailing `.lock`, max 200 chars. This is about argv safety and clarity,
 * not full refname validation — invalid names simply fail the checkout with
 * git's own error.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (name.startsWith('-') || name.startsWith('.')) return false;
  if (name.includes('..') || name.includes(' ') || name.includes('~') || name.includes('^') || name.includes(':')
    || name.includes('?') || name.includes('*') || name.includes('[') || name.includes('\\')) return false;
  if (name.endsWith('.lock') || name.endsWith('/')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

/**
 * List the branches of a checkout: local branches + remote-tracking refs
 * (origin/*), deduped into one entry per name with `remote` marking
 * remote-only branches. With `fetch=true`, run `git fetch --prune` first so
 * newly pushed / deleted branches show up (network, up to 60s).
 *
 * Never throws — an unreadable repo returns { current: null, branches: [],
 * error } so the picker can render the reason.
 */
export async function listGitBranches(path: string, fetch = false): Promise<GitBranchList> {
  if (!path || !existsSync(path) || !existsSync(join(path, '.git'))) {
    return { current: null, branches: [], error: 'not a git repository' };
  }
  try {
    if (fetch) {
      await execFileAsync('git', ['fetch', 'origin', '--prune'], {
        cwd: path, timeout: FETCH_TIMEOUT, maxBuffer: 512 * 1024,
      }).catch(() => { /* offline / no origin — list cached refs below */ });
    }

    // %(HEAD) marks the current branch with '*'. The FULL refname is needed
    // for the HEAD check: `%(refname:short)` of refs/remotes/origin/HEAD
    // resolves to just "origin" (tested on git 2.39+), which would leak a
    // phantom "origin" branch into the picker. One call covers local and
    // remote-tracking refs; porcelain lines are stable across git versions.
    const { stdout } = await execFileAsync(
      'git',
      ['for-each-ref', '--format=%(HEAD)%00%(refname)%00%(refname:short)', 'refs/heads', 'refs/remotes'],
      { cwd: path, timeout: GIT_TIMEOUT, maxBuffer: 1024 * 1024 },
    );

    const current = stdout
      .split('\n')
      .find((l) => l.startsWith('*'))
      ?.split('\0')[2]
      ?.trim() ?? null;

    const byName = new Map<string, GitBranchInfo>();
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [mark, fullRef, shortRef] = line.split('\0');
      if (!fullRef || !shortRef) continue;
      // Skip symbolic refs like refs/remotes/origin/HEAD (→ origin/main) —
      // its SHORT name resolves to just "origin", which would leak a
      // phantom branch into the picker.
      if (fullRef.endsWith('/HEAD')) continue;
      const name = shortRef.trim();
      // origin/foo → foo (remote-tracking); local names pass through.
      const isRemote = name.includes('/');
      const short = isRemote && name.startsWith('origin/') ? name.slice('origin/'.length) : null;
      // Remote-tracking refs from OTHER remotes (upstream/foo) would collide
      // with local dir names — only origin/* is merged into the picker list.
      if (isRemote && !short) continue;
      const display = short ?? name;
      if (!display || !isValidBranchName(display)) continue;
      const existing = byName.get(display);
      const isCurrent = mark.trim() === '*';
      if (existing) {
        // Local entry wins over its origin/* twin; keep `current` from HEAD.
        if (!isRemote) {
          existing.remote = false;
          existing.current = existing.current || isCurrent;
        } else {
          existing.current = existing.current || isCurrent;
        }
      } else {
        byName.set(display, { name: display, current: isCurrent, remote: isRemote });
      }
    }
    if (current && !byName.has(current) && isValidBranchName(current)) {
      byName.set(current, { name: current, current: true, remote: false });
    }

    // Current first, then alphabetical.
    const branches = [...byName.values()].sort((a, b) =>
      Number(b.current) - Number(a.current) || a.name.localeCompare(b.name),
    );
    return { current, branches };
  } catch (e: any) {
    return { current: null, branches: [], error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Switch a checkout to `branch` (NO pull — the pull route chains this before
 * its own pull). Tries `git checkout <branch>` first; when the branch only
 * exists on the remote, `git checkout -b <branch> origin/<branch>` creates a
 * local tracking branch. Local uncommitted changes are NEVER touched — git
 * itself refuses a checkout that would clobber them, and that error is
 * surfaced verbatim.
 */
export async function switchGitBranch(path: string, branch: string): Promise<GitSwitchResult> {
  if (!isValidBranchName(branch)) {
    return { ok: false, note: '', error: `invalid branch name: ${branch}` };
  }
  // Does a local branch of this name exist?
  let localExists = false;
  try {
    await execFileAsync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
      cwd: path, timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024,
    });
    localExists = true;
  } catch { /* not a local branch */ }

  // Does a remote-tracking ref exist (after a fetch the picker already did)?
  let remoteExists = false;
  try {
    await execFileAsync('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
      cwd: path, timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024,
    });
    remoteExists = true;
  } catch { /* not on origin either */ }

  try {
    if (localExists) {
      await execFileAsync('git', ['checkout', branch], {
        cwd: path, timeout: GIT_TIMEOUT, maxBuffer: 512 * 1024,
      });
      return { ok: true, note: `switched to branch '${branch}'` };
    }
    if (remoteExists) {
      await execFileAsync('git', ['checkout', '-b', branch, `origin/${branch}`], {
        cwd: path, timeout: GIT_TIMEOUT, maxBuffer: 512 * 1024,
      });
      return { ok: true, note: `created local branch '${branch}' tracking origin/${branch}` };
    }
    return { ok: false, note: '', error: `branch '${branch}' not found locally or on origin` };
  } catch (e: any) {
    // e.g. "Your local changes would be overwritten by checkout" — pass the
    // real git text through; it already tells the user what to do.
    const errText = String(e?.stderr || e?.stdout || e?.message || '').trim();
    return { ok: false, note: '', error: errText.slice(0, 400) || `git checkout ${branch} failed` };
  }
}

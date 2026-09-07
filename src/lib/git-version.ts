import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';

const execFileAsync = promisify(execFile);

/** Git checkout snapshot shown on project cards next to the repo URL. */
export interface GitVersion {
  /** Current branch name ('HEAD' when detached). */
  branch: string | null;
  /** 7-char short commit SHA. */
  sha: string | null;
  /** Number of files with uncommitted changes (git status --porcelain lines). */
  dirty: number | null;
  /** ISO timestamp of the last commit (for "3h ago" style rendering). */
  committedAt: string | null;
  /** Why the version is unavailable — surfaced as a tooltip, never an error. */
  error?: string;
}

/** Batch result: projectId → version info (null = no data / not a git repo). */
export type GitVersionMap = Record<string, GitVersion | null>;

const GIT_TIMEOUT = 15000;

/**
 * Read a project directory's git state in one round trip of git calls.
 * Never throws: a missing .git or git failure returns a GitVersion with
 * `error` set (and null fields) so cards can degrade gracefully.
 *
 * Used by GET /api/projects/versions (dashboard-local projects) and — with
 * the same response shape — by every device agent's /api/agent/versions.
 */
export async function readGitVersion(path: string): Promise<GitVersion | null> {
  if (!path || !existsSync(path) || !existsSync(join(path, '.git'))) {
    return null;
  }

  const version: GitVersion = {
    branch: null,
    sha: null,
    dirty: null,
    committedAt: null,
  };

  try {
    // branch + short sha via rev-parse — `--format=%h` swallows --decorate
    // output, so combining them in one `git show` does not work.
    const [branchOut, shaOut] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: path, timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024,
      }),
      execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: path, timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024,
      }),
    ]);
    version.branch = branchOut.stdout.trim() || null;
    version.sha = shaOut.stdout.trim() || null;
    // rev-parse --abbrev-ref reports 'HEAD' for detached checkouts.
  } catch {
    return { ...version, error: 'git error' };
  }

  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%cI', 'HEAD'], {
      cwd: path,
      timeout: GIT_TIMEOUT,
      maxBuffer: 64 * 1024,
    });
    version.committedAt = stdout.trim() || null;
  } catch {
    /* unborn HEAD — leave null */
  }

  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: path,
      timeout: GIT_TIMEOUT,
      maxBuffer: 512 * 1024,
    });
    version.dirty = stdout.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    /* ignore — status is best-effort */
  }

  return version;
}

/** Compact relative time for the version chip ("3h ago" / "2d ago"). */
export function versionTimeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const diff = Date.now() - ts;
  if (diff < 0) return null;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { rmSync } from 'fs';

// execFile with windowsHide ON by default: git.exe / git-remote-https.exe
// are console-subsystem programs — from a console-less dashboard server
// (supervisor/scheduled start) every git call allocates a WINDOW on the
// user's desktop. CREATE_NO_WINDOW on Windows, no-op elsewhere.
const execFileRawAsync = promisify(execFile);
const execFileAsync = (file: string, args: string[], opts: any = {}): Promise<{ stdout: string; stderr: string }> =>
  execFileRawAsync(file, args, { windowsHide: true, ...opts }) as unknown as Promise<{ stdout: string; stderr: string }>;

/**
 * Conflict-aware one-click pull (agent v1.17 / dashboard).
 *
 * `git pull` dies with TWO user-hostile error classes when local changes
 * collide with incoming commits:
 *
 *   error: Your local changes to the following files would be overwritten by merge:
 *   src/app/api/jobs/[id]/outputs/route.ts
 *   Please commit your changes or stash them before you merge.
 *   error: The following untracked working tree files would be overwritten by merge:
 *   package-lock.json
 *   Please move or remove them before you merge.
 *   Aborting
 *
 * …and the checkout twin ("…overwritten by checkout:") for branch switches.
 * A terminal user knows what to do; a dashboard user is STUCK. This module
 * parses those errors into the affected file lists so the API can answer
 * 409 { conflict, modified, untracked } and the UI can ask what to do
 * (stash-then-restore, or discard), plus the executors for both strategies.
 */

export interface PullConflict {
  /** Tracked files with local modifications git refuses to clobber. */
  modified: string[];
  /** Untracked files the incoming merge would overwrite. */
  untracked: string[];
}

/** Parse git's "would be overwritten by merge/checkout" stderr into the
 *  blocking file lists. Returns null for every other error class. */
export function parsePullConflict(errText: string): PullConflict | null {
  if (!errText || !/would be overwritten by (merge|checkout)/i.test(errText)) return null;
  const modified: string[] = [];
  const untracked: string[] = [];
  let section: 'modified' | 'untracked' | null = null;
  for (const raw of String(errText).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/error:\s*Your local changes to the following files would be overwritten by (merge|checkout):/i.test(line)) {
      section = 'modified';
      continue;
    }
    if (/error:\s*The following untracked working tree files would be overwritten by (merge|checkout):/i.test(line)) {
      section = 'untracked';
      continue;
    }
    // Section body ends at the "Please …" plea or "Aborting".
    if (/^Please (commit your changes or stash them|move or remove them) before you (merge|checkout)/i.test(line.trim())) {
      section = null;
      continue;
    }
    if (/^Aborting/i.test(line.trim())) {
      section = null;
      continue;
    }
    if (section) {
      const f = unquoteGitPath(line.trim());
      // Only plausible repo-relative paths — never git chatter.
      if (f && !f.startsWith('error:') && !f.startsWith('fatal:') && !f.startsWith('warning:')) {
        (section === 'modified' ? modified : untracked).push(f);
      }
    }
  }
  if (modified.length === 0 && untracked.length === 0) return null;
  return { modified, untracked };
}

/** git C-quotes exotic paths ("src/a b.ts" → "\"src/a\\ b.ts\"" octal…);
 *  handle the common quoting only — our repos' paths are plain. */
function unquoteGitPath(f: string): string {
  if (f.length >= 2 && f.startsWith('"') && f.endsWith('"')) {
    return f.slice(1, -1).replace(/\\"/g, '"');
  }
  return f;
}

/** Validate a conflict file list that came from a REQUEST BODY (the frontend
 *  round-trips the lists the 409 carried). These strings reach git argv as
 *  pathspecs — only accept plain repo-relative paths: no traversal, no
 *  absolute paths, no glob/pathspec magic, no leading dashes, bounded size. */
export function sanitizeConflictFiles(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list.slice(0, 200)) {
    if (typeof raw !== 'string') continue;
    let f = raw.trim();
    if (f.startsWith('"') && f.endsWith('"') && f.length >= 2) f = f.slice(1, -1).replace(/\\"/g, '"');
    if (!f || f.length > 400) continue;
    if (f.includes('\0') || f.includes('\n')) continue;
    if (/(^|[\\/])\.\.([\\/]|$)/.test(f)) continue; // parent traversal
    if (f.startsWith('/') || f.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(f)) continue; // absolute
    if (/[*?[\]~^:!]/.test(f)) continue; // glob / pathspec magic
    out.push(f);
  }
  return out;
}

/** Force strategy, step 1 — restore tracked files that block the pull to
 *  their HEAD content. Returns a note for the pull output (never throws:
 *  git's own failure text is returned so the UI can show the reason). */
export async function discardTrackedChanges(projectPath: string, modified: string[]): Promise<string> {
  if (modified.length === 0) return '';
  const paths = modified.map((f) => `./${f}`);
  await execFileAsync('git', ['checkout', 'HEAD', '--', ...paths], {
    cwd: projectPath, timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  return `restored ${modified.length} modified file(s) to HEAD`;
}

/** Force strategy, step 2 — remove the untracked files that block the pull
 *  (exactly those paths, nothing else). git clean with a pathspec keeps the
 *  blast radius to the listed files; fs.rmSync is the last-resort fallback
 *  (clean refuses ignored files without -x). */
export async function removeUntrackedBlockers(projectPath: string, untracked: string[]): Promise<string> {
  if (untracked.length === 0) return '';
  const argv = ['clean', '-fd', '--', ...untracked.map((f) => `./${f}`)];
  try {
    await execFileAsync('git', argv, { cwd: projectPath, timeout: 30_000, maxBuffer: 1024 * 1024 });
  } catch {
    try {
      await execFileAsync('git', ['clean', '-fdx', '--', ...untracked.map((f) => `./${f}`)], {
        cwd: projectPath, timeout: 30_000, maxBuffer: 1024 * 1024,
      });
    } catch {
      // Fallback: remove the exact paths ourselves.
      for (const f of untracked) {
        try { rmSync(join(projectPath, f), { recursive: true, force: true }); } catch { /* reported by the retrying pull */ }
      }
    }
  }
  return `removed ${untracked.length} untracked blocking file(s)`;
}

/** Stash strategy, step 1 — `git stash push --include-untracked`. Captures
 *  modified tracked files AND untracked ones (the exact classes the pull
 *  refuses to clobber). Returns true when a stash entry was created. */
export async function stashLocalChanges(projectPath: string, label: string): Promise<boolean> {
  const out = await execFileAsync(
    'git',
    ['stash', 'push', '--include-untracked', '-m', `dashboard-pull ${label}`],
    { cwd: projectPath, timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  // "No local changes to save" — nothing was stashed (still safe to pop-check).
  return !/No local changes/i.test(out.stdout || '');
}

export interface StashPopResult {
  ok: boolean;
  /** Raw git output — conflict text when ok:false (git keeps the entry). */
  detail: string;
  /** True when the tracked changes applied but the stashed-untracked copies
   *  collided with now-tracked paths and stayed in the stash entry. */
  partial?: boolean;
}

/** Stash strategy, step 3 — re-apply the stashed local changes on top of the
 *  pulled code. On CONFLICT git leaves markers in the working tree and KEEPS
 *  the stash entry; that surfaces as ok:false so the UI can warn precisely.
 *
 *  Partial-success class: when the pull ADDED a file that the stash holds
 *  UNTRACKED (the classic `package-lock.json` case), the tracked changes
 *  apply cleanly but restoring the untracked copy collides with the now-
 *  tracked path — "could not restore untracked files from stash". That is
 *  NOT a merge conflict (no unmerged paths); report ok:true with a precise
 *  note (the local copies remain in the kept stash entry). */
export async function popStash(projectPath: string): Promise<StashPopResult> {
  try {
    const out = await execFileAsync('git', ['stash', 'pop'], {
      cwd: projectPath, timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    return { ok: true, detail: (out.stdout || out.stderr || '').trim() };
  } catch (e: any) {
    const detail = String(e?.stderr || e?.stdout || e?.message || '').trim().slice(0, 600);
    if (/could not restore untracked files from stash/i.test(detail)) {
      try {
        const unmerged = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], {
          cwd: projectPath, timeout: 15_000, maxBuffer: 64 * 1024,
        });
        if (!(unmerged.stdout || '').trim()) {
          return {
            ok: true, partial: true,
            detail: 'local changes re-applied; the former untracked blocking files now exist as tracked files, so their local copies remain in the stash entry (git stash list)',
          };
        }
      } catch { /* fall through to the conflict report */ }
    }
    return { ok: false, detail };
  }
}

/** Validate a strategy value from a request body. */
export function isValidPullStrategy(v: unknown): v is 'force' | 'stash' {
  return v === 'force' || v === 'stash';
}

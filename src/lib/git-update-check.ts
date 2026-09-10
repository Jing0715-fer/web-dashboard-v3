import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT = 20000;
/** Cached check results — the UI polls every 10 min, so a 5 min TTL keeps
 *  github.com / gitlab.com request volume at one ls-remote+fetch per repo
 *  per 5 minutes even with several dashboards tabs open. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Remote-repository freshness for one project.
 *
 *  - 'current'  — local HEAD matches the remote's HEAD
 *  - 'behind'   — remote has commits local doesn't (PULL recommended)
 *  - 'ahead'    — local has unpushed commits (nothing to pull)
 *  - 'diverged' — both sides moved (pull would merge)
 *  - 'differs'  — remote project (on a device): the agent-reported checkout
 *                 SHA differs from the remote HEAD; direction is unknowable
 *                 without the repo, so the hint is worded neutrally
 *  - 'unknown'  — check failed (no repoUrl, offline remote, private repo,
 *                 legacy agent …). Never surfaced as an error — the card
 *                 simply hides the hint.
 */
export interface RepoUpdateStatus {
  state: 'current' | 'behind' | 'ahead' | 'diverged' | 'differs' | 'unknown';
  /** Commits the remote is ahead (local projects, rev-list). */
  behind: number | null;
  /** Commits local is ahead (local projects, rev-list). */
  ahead: number | null;
  /** Short remote HEAD sha (7 chars) for tooltips. */
  remoteSha: string | null;
  /** ISO timestamp of this check. */
  checkedAt: string;
  /** Why the check failed — tooltip/debug only, never an error toast. */
  error?: string;
}

/** Mask credentials embedded in git stderr before it reaches the client. */
function maskCreds(s: unknown): string {
  return String(s || '')
    .replace(/(https?:\/\/)[^@/\s]+@/gi, '$1')
    .slice(0, 160);
}

/** repoUrl values that may reach git: http(s) only. The API normalizes
 *  every WRITE to https, but legacy rows or agent-pushed values can carry
 *  anything — a local file:// path (or other exotic transport) combined
 *  with an option-shaped branch name from --symref output is an execution
 *  primitive, so refuse non-http(s) schemes before any git call. */
function isHttpRepoUrl(raw: string): boolean {
  const s = String(raw || '').trim();
  if (!/^https?:\/\/[^/\s]+(\/.*)?$/i.test(s)) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function unknown(error: string, remoteSha: string | null = null): RepoUpdateStatus {
  return {
    state: 'unknown',
    behind: null,
    ahead: null,
    remoteSha,
    checkedAt: new Date().toISOString(),
    error,
  };
}

/**
 * Resolve the remote's HEAD sha and default branch name in one round trip.
 * Works with https URLs, ssh remotes and plain local paths — anything
 * `git ls-remote` accepts (no clone, no auth prompt for public repos).
 */
async function lsRemoteHead(repoUrl: string): Promise<{ sha: string; branch: string | null }> {
  const { stdout } = await execFileAsync('git', ['ls-remote', '--symref', repoUrl, 'HEAD'], {
    timeout: GIT_TIMEOUT,
    maxBuffer: 64 * 1024,
  });
  // Output shape (tab-separated):
  //   ref: refs/heads/main\tHEAD
  //   <40-hex>\tHEAD
  let branch: string | null = null;
  let sha: string | null = null;
  for (const line of stdout.split('\n')) {
    const refMatch = line.match(/^ref: refs\/heads\/(\S+)\s+HEAD/);
    if (refMatch) {
      branch = refMatch[1];
      continue;
    }
    const shaMatch = line.match(/^([0-9a-f]{40})\s+HEAD$/i);
    if (shaMatch) sha = shaMatch[1];
  }
  if (!sha) throw new Error('remote reported no HEAD (empty repository?)');
  return { sha, branch };
}

/**
 * Precise behind/ahead counts for a LOCAL project:
 *
 *  1. ls-remote → default branch + remote HEAD
 *  2. `git fetch <repoUrl> <branch>` — updates FETCH_HEAD only; the working
 *     tree, index and local branches are never touched (this is the exact
 *     step `git pull` runs before merging, so it is safe by construction)
 *  3. rev-list --count HEAD..FETCH_HEAD (behind) / FETCH_HEAD..HEAD (ahead)
 *
 * Never throws — failures return state 'unknown' with a masked error.
 */
async function computeLocalStatus(path: string, repoUrl: string): Promise<RepoUpdateStatus> {
  if (!isHttpRepoUrl(repoUrl)) return unknown('repository URL is not http(s) — refused');
  let head: { sha: string; branch: string | null };
  try {
    head = await lsRemoteHead(repoUrl);
  } catch (e: any) {
    return unknown(maskCreds(`ls-remote failed: ${e?.message || e}`));
  }
  const remoteSha = head.sha.slice(0, 7);

  if (!path || !existsSync(path) || !existsSync(join(path, '.git'))) {
    return unknown('not a git repository', remoteSha);
  }

  // The branch name is fed back into `git fetch <url> <branch>` as a single
  // argv element — git would parse a leading '-' as an OPTION. A hostile
  // repo could advertise e.g. --upload-pack=<cmd> as its default branch.
  // (Space-free by the --symref regex, but refuse anything option-shaped.)
  if (head.branch && head.branch.startsWith('-')) {
    return unknown('remote reported an invalid branch name', remoteSha);
  }

  // Fetch the remote's default branch tip into FETCH_HEAD. Falling back to
  // the literal 'HEAD' ref covers servers that don't answer --symref.
  try {
    await execFileAsync(
      'git',
      ['-C', path, 'fetch', '--quiet', '--no-tags', repoUrl, head.branch || 'HEAD'],
      { timeout: GIT_TIMEOUT, maxBuffer: 1024 * 512 },
    );
  } catch (e: any) {
    return unknown(maskCreds(`fetch failed: ${e?.stderr || e?.message || e}`), remoteSha);
  }

  try {
    const [behindOut, aheadOut] = await Promise.all([
      execFileAsync('git', ['-C', path, 'rev-list', '--count', 'HEAD..FETCH_HEAD'], {
        timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024,
      }),
      execFileAsync('git', ['-C', path, 'rev-list', '--count', 'FETCH_HEAD..HEAD'], {
        timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024,
      }),
    ]);
    const behind = parseInt(behindOut.stdout.trim(), 10) || 0;
    const ahead = parseInt(aheadOut.stdout.trim(), 10) || 0;
    const state: RepoUpdateStatus['state'] =
      behind > 0 && ahead > 0 ? 'diverged' : behind > 0 ? 'behind' : ahead > 0 ? 'ahead' : 'current';
    return { state, behind, ahead, remoteSha, checkedAt: new Date().toISOString() };
  } catch (e: any) {
    // Unborn local HEAD (fresh repo without commits) or rev-list failure.
    return unknown(maskCreds(`rev-list failed: ${e?.message || e}`), remoteSha);
  }
}

/**
 * Best-effort freshness for a REMOTE (device) project: compares the
 * agent-reported checkout SHA with the remote HEAD from ls-remote. Without
 * the repo on this machine, behind/ahead direction is unknowable — the
 * mismatch is reported as 'differs' and worded neutrally in the UI.
 */
async function computeRemoteStatus(repoUrl: string, deviceSha: string): Promise<RepoUpdateStatus> {
  if (!isHttpRepoUrl(repoUrl)) return unknown('repository URL is not http(s) — refused');
  try {
    const { sha } = await lsRemoteHead(repoUrl);
    const needle = deviceSha.trim().toLowerCase();
    const inSync = needle.length >= 7 && sha.toLowerCase().startsWith(needle.slice(0, sha.length));
    return {
      state: inSync ? 'current' : 'differs',
      behind: null,
      ahead: null,
      remoteSha: sha.slice(0, 7),
      checkedAt: new Date().toISOString(),
    };
  } catch (e: any) {
    return unknown(maskCreds(`ls-remote failed: ${e?.message || e}`));
  }
}

// ---- Process-wide result cache (TTL + in-flight dedupe) ------------------
// The updates route and the pull route import this module; the refresh flag
// (?refresh=1 after a pull) bypasses TTL directly inside the same route's
// module instance, so stale 'behind' hints never survive a successful pull.
const cache = new Map<string, { value: RepoUpdateStatus; expires: number }>();
const inflight = new Map<string, { promise: Promise<RepoUpdateStatus>; gen: number }>();

// ---- invalidation generation ---------------------------------------------
// invalidateUpdateCache() drops the cache entry, but a check that STARTED
// before the invalidation may still be in flight — a ?refresh=1 caller
// joining it would await the PRE-pull result and re-cache it for 5 minutes
// (the pill the refresh was designed to drop survives the refresh). Each
// check records the generation it started under; refresh callers refuse to
// join an older-generation in-flight and chain a fresh check after it.
const generations = new Map<string, number>();
function generationOf(id: string): number {
  return generations.get(id) || 0;
}

async function cachedCheck(
  projectId: string,
  refresh: boolean,
  fn: () => Promise<RepoUpdateStatus>,
): Promise<RepoUpdateStatus> {
  const hit = cache.get(projectId);
  if (!refresh && hit && hit.expires > Date.now()) return hit.value;
  const myGen = generationOf(projectId);
  // Join an in-flight check ONLY when it started at (or after) the current
  // generation — otherwise let it settle first (git calls are timeout-
  // bounded at 20s) and compute a current-generation result.
  const pending = inflight.get(projectId);
  if (pending && pending.gen >= myGen) return pending.promise;
  if (pending) await pending.promise.catch(() => { /* stale one's error is irrelevant */ });
  const p = fn();
  inflight.set(projectId, { promise: p, gen: myGen });
  try {
    const value = await p;
    // Don't cache over a newer generation (invalidated while we ran).
    if (generationOf(projectId) === myGen) {
      cache.set(projectId, { value, expires: Date.now() + CACHE_TTL_MS });
    }
    return value;
  } finally {
    if (inflight.get(projectId)?.promise === p) inflight.delete(projectId);
  }
}

/** Drop cached results (all, or specific projects) — called after a pull. */
export function invalidateUpdateCache(ids?: string[]): void {
  const targets = ids ?? [...new Set([...cache.keys(), ...generations.keys()])];
  for (const id of targets) {
    cache.delete(id);
    generations.set(id, generationOf(id) + 1);
  }
}

/** Cached freshness check for a dashboard-local project. */
export async function checkLocalRepoUpdate(
  projectId: string,
  path: string,
  repoUrl: string,
  refresh = false,
): Promise<RepoUpdateStatus> {
  if (!repoUrl) return unknown('no repository URL configured');
  return cachedCheck(projectId, refresh, () => computeLocalStatus(path, repoUrl));
}

/** Cached freshness check for a device-hosted project. */
export async function checkRemoteRepoUpdate(
  projectId: string,
  repoUrl: string,
  deviceSha: string,
  refresh = false,
): Promise<RepoUpdateStatus> {
  if (!repoUrl) return unknown('no repository URL configured');
  if (!deviceSha) return unknown('agent reported no version');
  return cachedCheck(projectId, refresh, () => computeRemoteStatus(repoUrl, deviceSha));
}

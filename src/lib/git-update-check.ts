import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import { execGitNetwork, isGitKilledError } from '@/lib/git-retry';
import { getGitNetConfig, gitProxyArgs } from '@/lib/git-net-config';

// execFile with windowsHide ON by default: git.exe / git-remote-https.exe
// are console-subsystem programs — from a console-less dashboard server
// (supervisor/scheduled start) every git call allocates a WINDOW on the
// user's desktop. CREATE_NO_WINDOW on Windows, no-op elsewhere.
const execFileRawAsync = promisify(execFile);
const execFileAsync = (file: string, args: string[], opts: any = {}): Promise<{ stdout: string; stderr: string }> =>
  execFileRawAsync(file, args, { windowsHide: true, ...opts }) as unknown as Promise<{ stdout: string; stderr: string }>;

const GIT_TIMEOUT = 20000;
/** v1.41: budget for the OBJECT-DOWNLOAD step (`git fetch`). The verdict
 *  ladder below never blocks the verdict on this — fetch only refines the
 *  behind COUNT — so a slow link / large push gets 45s (was 20s) before the
 *  offline fallback (local objects) takes over. */
const FETCH_TIMEOUT = 45000;
/** Cached check results — the UI polls every 10 min, so a 5 min TTL keeps
 *  github.com / gitlab.com request volume at one ls-remote+fetch per repo
 *  per 5 minutes even with several dashboards tabs open. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** v1.41: FAILURE ('unknown') results are negative-cached for only 60s (was
 *  the full 5 min). The old TTL + the 10-min UI poll meant one network
 *  hiccup could hide the update notice for 10+ minutes — "no error, but no
 *  new version shown". With 60s the next poll cycle already retries. */
const UNKNOWN_CACHE_TTL_MS = 60 * 1000;

/** v1.27: the git network config (proxy) for this process — read once per
 *  check cycle, applied to every network call below via -c args so nothing
 *  is ever written into any repo's .git/config. */
let cachedNetArgs: { args: string[]; readAt: number } | null = null;
async function netArgs(): Promise<string[]> {
  if (cachedNetArgs && Date.now() - cachedNetArgs.readAt < 60_000) return cachedNetArgs.args;
  const cfg = await getGitNetConfig();
  cachedNetArgs = { args: gitProxyArgs(cfg.proxy), readAt: Date.now() };
  return cachedNetArgs.args;
}

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
 *                 legacy agent …). v1.41: no longer hidden silently — the
 *                 card surfaces a dashed amber "update check unavailable"
 *                 chip carrying the error and a click-to-retry affordance.
 */
export interface RepoUpdateStatus {
  state: 'current' | 'behind' | 'ahead' | 'diverged' | 'differs' | 'unknown';
  /** Commits the remote is ahead (local projects, rev-list). */
  behind: number | null;
  /** Commits local is ahead (local projects, rev-list). */
  ahead: number | null;
  /** Short remote HEAD sha (7 chars) for tooltips. */
  remoteSha: string | null;
  /** v1.25: the remote's DEFAULT branch name (from ls-remote --symref) — the
   *  branch this check compares against. Every pull syncs the CHECKED-OUT
   *  branch's upstream instead, so a checkout parked on a stale side branch
   *  (classic: 'v3-base', 100+ commits behind 'main') reports "Already up to
   *  date" while this check says 'behind'. Carrying the name lets the pull
   *  routes/UI name the branch to switch to. Null when the server didn't say. */
  branch: string | null;
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

function unknown(error: string, remoteSha: string | null = null, branch: string | null = null): RepoUpdateStatus {
  return {
    state: 'unknown',
    behind: null,
    ahead: null,
    remoteSha,
    branch,
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
  // ls-remote IS the network round trip — transient flakes (classic:
  // `OpenSSL SSL_connect: SSL_ERROR_SYSCALL`) are auto-retried inside, and
  // v1.27 routes it through the configured proxy when one is set.
  const { stdout } = await execGitNetwork([...await netArgs(), 'ls-remote', '--symref', repoUrl, 'HEAD'], {
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

/** Local HEAD sha of the checkout at `path` — null when unborn (fresh repo
 *  without commits) or unreadable. Purely local, no network. */
async function revParseHead(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', 'HEAD'], {
      timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024,
    });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** v1.41: is `sha` present in the local object store as a commit?
 *  (`cat-file -e <sha>^{commit}` — purely local, no network.) */
async function commitKnown(path: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', path, 'cat-file', '-e', `${sha}^{commit}`], {
      timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Precise freshness verdict for a LOCAL project — the v1.41 "verdict ladder".
 *
 * The version VERDICT (current / behind / ahead / diverged) must never depend
 * on downloading objects. The old flow ran `git fetch` BEFORE counting, so a
 * slow link or a large push killed the fetch (20s budget) and collapsed the
 * whole check to 'unknown' — the card silently hid the update pill and the
 * user just saw "no new version, no error". The ladder decides instead:
 *
 *  1. `git ls-remote --symref` → remote HEAD sha + default branch — ONE
 *     small request, no objects.
 *  2. local `rev-parse HEAD`; equal shas ⇒ 'current' with ZERO fetch.
 *  3. remote tip already in the local object store (`cat-file -e`) ⇒ exact
 *     ahead/behind via `rev-list` between the two SHAs — fully offline.
 *  4. otherwise `git fetch` (budget 45s) runs ONLY to refine the count; on
 *     failure the check still returns the best local verdict:
 *       - tip missing from the local store ⇒ NECESSARILY behind
 *         (behind = null count — never a fake 'current'/'ahead').
 *  5. rev-list always anchors on the sha ls-remote REPORTED — FETCH_HEAD is
 *     never read (a concurrent pull rewrites it mid-check) and origin/<branch>
 *     is never trusted (a possibly stale tracking ref).
 *
 * Never throws — failures return state 'unknown' with a masked error.
 */
async function computeLocalStatus(path: string, repoUrl: string): Promise<RepoUpdateStatus> {
  if (!isHttpRepoUrl(repoUrl)) return unknown('repository URL is not http(s) — refused');
  let head: { sha: string; branch: string | null };
  try {
    head = await lsRemoteHead(repoUrl);
  } catch (e: any) {
    // v1.27: a killed ls-remote (timeout) says nothing about the repo —
    // name the network path in the error so the UI tooltip is honest.
    const why = isGitKilledError(e)
      ? `ls-remote timed out after ${GIT_TIMEOUT / 1000}s (network path to the remote is too slow or blocked)`
      : `ls-remote failed: ${e?.message || e}`;
    return unknown(maskCreds(why));
  }
  const remoteSha = head.sha.slice(0, 7);

  if (!path || !existsSync(path) || !existsSync(join(path, '.git'))) {
    return unknown('not a git repository', remoteSha, head.branch);
  }

  // The branch name is fed back into `git fetch <url> <branch>` as a single
  // argv element — git would parse a leading '-' as an OPTION. A hostile
  // repo could advertise e.g. --upload-pack=<cmd> as its default branch.
  // (Space-free by the --symref regex, but refuse anything option-shaped.)
  if (head.branch && head.branch.startsWith('-')) {
    return unknown('remote reported an invalid branch name', remoteSha);
  }

  // ---- Ladder step 2: SHA-first comparison. Equal shas ⇒ 'current' with
  // ZERO fetch — the common steady state never pays for object downloads.
  const localSha = await revParseHead(path);
  if (localSha && localSha === head.sha) {
    return {
      state: 'current', behind: 0, ahead: 0, remoteSha, branch: head.branch,
      checkedAt: new Date().toISOString(),
    };
  }

  // ---- Ladder step 4: fetch ONLY refines the counts. The shas differ, so
  // the remote tip is newer from local's perspective — download its objects
  // under the raised 45s budget. Failure is NON-FATAL: the ladder below
  // still returns a verdict from local objects alone.
  try {
    await execGitNetwork(
      [...await netArgs(), '-C', path, 'fetch', '--quiet', '--no-tags', repoUrl, head.branch || 'HEAD'],
      { timeout: FETCH_TIMEOUT, maxBuffer: 1024 * 512 },
    );
  } catch { /* offline fallback below — the verdict never depended on this */ }

  // ---- Ladder steps 3+5: exact counts from local objects, anchored on the
  // sha ls-remote reported (never FETCH_HEAD, never origin/<branch>).
  if (localSha && (await commitKnown(path, head.sha))) {
    try {
      const [behindOut, aheadOut] = await Promise.all([
        execFileAsync('git', ['-C', path, 'rev-list', '--count', `${localSha}..${head.sha}`], {
          timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024,
        }),
        execFileAsync('git', ['-C', path, 'rev-list', '--count', `${head.sha}..${localSha}`], {
          timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024,
        }),
      ]);
      const behind = parseInt(behindOut.stdout.trim(), 10) || 0;
      const ahead = parseInt(aheadOut.stdout.trim(), 10) || 0;
      const state: RepoUpdateStatus['state'] =
        behind > 0 && ahead > 0 ? 'diverged' : behind > 0 ? 'behind' : ahead > 0 ? 'ahead' : 'current';
      return { state, behind, ahead, remoteSha, branch: head.branch, checkedAt: new Date().toISOString() };
    } catch (e: any) {
      // Objects present but rev-list failed (corrupt store, unborn HEAD…).
      return unknown(maskCreds(`rev-list failed: ${e?.message || e}`), remoteSha, head.branch);
    }
  }

  // Remote tip missing from the local object store even after the fetch
  // attempt: local HEAD is a commit, the remote HEAD is a DIFFERENT commit
  // we do not have ⇒ the remote is necessarily ahead. Report 'behind' with
  // an unknown count (behind = null) — never a fake 'current'/'ahead'.
  // (Also covers an unborn local HEAD: remote has a commit, local has none.)
  return {
    state: 'behind', behind: null, ahead: null, remoteSha, branch: head.branch,
    checkedAt: new Date().toISOString(),
  };
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
    const { sha, branch } = await lsRemoteHead(repoUrl);
    const needle = deviceSha.trim().toLowerCase();
    const inSync = needle.length >= 7 && sha.toLowerCase().startsWith(needle.slice(0, sha.length));
    return {
      state: inSync ? 'current' : 'differs',
      behind: null,
      ahead: null,
      remoteSha: sha.slice(0, 7),
      branch,
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
  // bounded at 45s) and compute a current-generation result.
  const pending = inflight.get(projectId);
  if (pending && pending.gen >= myGen) return pending.promise;
  if (pending) await pending.promise.catch(() => { /* stale one's error is irrelevant */ });
  const p = fn();
  inflight.set(projectId, { promise: p, gen: myGen });
  try {
    const value = await p;
    // Don't cache over a newer generation (invalidated while we ran).
    if (generationOf(projectId) === myGen) {
      // v1.41: failure ('unknown') results negative-cache for only 60s so
      // the next UI poll cycle (10 min) always retries a dead check;
      // successful verdicts keep the 5-minute TTL.
      const ttl = value.state === 'unknown' ? UNKNOWN_CACHE_TTL_MS : CACHE_TTL_MS;
      cache.set(projectId, { value, expires: Date.now() + ttl });
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

/** v1.21: reserved cache key for the DASHBOARD'S OWN repo — /api/self-update
 *  checks it exactly like a project row, and /api/self-update/pull invalidates
 *  it after a one-click update. Real project ids are cuids, so the reserved
 *  name can never collide. */
export const SELF_UPDATE_CACHE_KEY = '__dashboard_self__';

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

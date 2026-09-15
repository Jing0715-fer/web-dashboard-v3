import { execFile } from 'child_process';
import { promisify } from 'util';
import { db } from '@/lib/db';
import { logActivity } from '@/lib/activity';

const execFileAsync = promisify(execFile);

/**
 * Dashboard + agent fleet AUTO-UPDATE layer.
 *
 * Goal (user request): zero manual maintenance — "the dashboard detects
 * updates, agents stay on the latest version, and restarts happen by
 * themselves". Three cooperating pieces:
 *
 *   L1 (this file, dashboard side)
 *     - probeSelfUpdate(): is THIS repo behind its origin? (ls-remote, no
 *       network-heavy fetch of objects, TTL-cached 5 min)
 *     - autoPullIfSafe(): when behind AND the working tree is clean AND the
 *       checkout sits on the remote's default branch AND the ops.autoUpdate
 *       setting is ON (default) → `git pull --ff-only`. In dev mode the
 *       pulled code is hot-reloaded by Turbopack for the routes; the
 *       co-located agent is respawned by the lifecycle supervisor (its
 *       running process predates the pull) — closing the loop with NO
 *       human step.
 *     - selfUpdateSignal(): the payload handed to remote agents on every
 *       heartbeat response: "the newest code I know of is <sha> at <repoUrl>".
 *
 *   L2 (agent side, v1.10+): the agent compares the signal's sha with its
 *   own repo HEAD and, when different, pulls ITS clone (same repo, its own
 *   machine) and respawns itself — see mini-services/agent(-win)/index.ts
 *   `scheduleSelfUpdate`.
 *
 *   L3 (metadata sync): project rows / repoUrl / notes already ride the
 *   PUT-proxy + heartbeat-push + pull-body channels — nothing new here.
 *
 * Safety rules for autoPullIfSafe (each independently sufficient to SKIP):
 *   - ops.autoUpdate setting === 'off' (admin toggle)
 *   - no 'origin' remote, or it is not http(s)
 *   - current branch ≠ the remote's advertised default branch (main)
 *   - working tree not clean (uncommitted changes — never touch them)
 *   - not behind (local == remote HEAD)
 *   - a pull is already in flight (in-process lock)
 * On any failure it just logs and retries on the next supervisor tick —
 * auto-update must never take the dashboard down.
 */

const GIT_TIMEOUT = 20_000;
/** How often the supervisor may actually hit the network for ls-remote. */
const PROBE_TTL_MS = 5 * 60 * 1000;
/** Minimum spacing between two REAL auto-pull attempts (failure backoff). */
const PULL_MIN_INTERVAL_MS = 5 * 60 * 1000;

export interface SelfUpdateStatus {
  /** Remote (origin) HEAD sha, full 40 hex — null when probe failed. */
  remoteSha: string | null;
  /** This repo's HEAD sha, full 40 hex — null when not a repo. */
  localSha: string | null;
  /** Commits origin is ahead of local HEAD. */
  behind: number | null;
  /** The origin URL (credentials masked). */
  repoUrl: string | null;
  /** The remote's default branch (from ls-remote --symref). */
  branch: string | null;
  /** When this snapshot was taken. */
  checkedAt: string;
  /** Probe failure reason (never surfaced as an error). */
  error?: string;
}

/** Signal payload for remote agents (heartbeat response field). */
export interface SelfUpdateSignal {
  repoUrl: string;
  remoteSha: string;
  /** Dashboard's own HEAD — lets the agent tell "repo moved" from "I'm stale". */
  localSha: string;
}

let cached: { value: SelfUpdateStatus; expires: number } | null = null;
let probeInFlight: Promise<SelfUpdateStatus> | null = null;
let lastPullAttempt = 0;
let pullInFlight = false;

/** Admin toggle (AppSetting 'ops.autoUpdate', JSON string 'on'/'off').
 *  Defaults to ON — the whole point of this layer is unattended operation;
 *  an admin can still turn it off from the settings API. */
export async function autoUpdateEnabled(): Promise<boolean> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: 'ops.autoUpdate' } });
    if (!row) return true;
    const v = JSON.parse(row.value);
    return v !== 'off';
  } catch {
    return true; // unreadable setting → default on
  }
}

/** Read the repo's origin URL (masked) — null when absent or non-http(s). */
async function originUrl(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024,
    });
    const url = stdout.trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return null;
    return url.replace(/(https?:\/\/)[^@/\s]+@/i, '$1'); // mask credentials
  } catch {
    return null;
  }
}

async function localHead(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Remote default branch + HEAD sha in one ls-remote round trip. */
async function lsRemoteOrigin(
  url: string,
): Promise<{ sha: string; branch: string | null } | null> {
  try {
    const { stdout } = await execFileAsync(
      'git', ['ls-remote', '--symref', url, 'HEAD'],
      { timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024 },
    );
    let sha: string | null = null;
    let branch: string | null = null;
    for (const line of stdout.split('\n')) {
      const m1 = line.match(/^ref: refs\/heads\/(\S+)\s+HEAD/);
      if (m1) { branch = m1[1]; continue; }
      const m2 = line.match(/^([0-9a-f]{40})\s+HEAD$/i);
      if (m2) sha = m2[1];
    }
    return sha ? { sha, branch } : null;
  } catch {
    return null;
  }
}

/** TTL-cached freshness probe of THIS repo vs its origin. Never throws. */
export async function probeSelfUpdate(force = false): Promise<SelfUpdateStatus> {
  if (!force && cached && cached.expires > Date.now()) return cached.value;
  if (probeInFlight) return probeInFlight;

  probeInFlight = (async (): Promise<SelfUpdateStatus> => {
    const url = await originUrl();
    if (!url) {
      return {
        remoteSha: null, localSha: null, behind: null, repoUrl: null, branch: null,
        checkedAt: new Date().toISOString(), error: 'no http(s) origin remote',
      };
    }
    const remote = await lsRemoteOrigin(url);
    const localSha = await localHead();
    if (!remote) {
      return {
        remoteSha: null, localSha, behind: null, repoUrl: url, branch: null,
        checkedAt: new Date().toISOString(), error: 'ls-remote failed (offline?)',
      };
    }
    let behind: number | null = null;
    if (localSha) {
      try {
        // `git fetch origin <branch>` updates remote-tracking refs only (the
        // exact pre-step `git pull` runs — safe by construction), then
        // rev-list gives an exact behind count.
        await execFileAsync(
          'git', ['fetch', '--quiet', 'origin', remote.branch || 'HEAD'],
          { timeout: GIT_TIMEOUT, maxBuffer: 1024 * 512 },
        );
        const { stdout } = await execFileAsync(
          'git', ['rev-list', '--count', `HEAD..origin/${remote.branch}`],
          { timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024 },
        );
        behind = parseInt(stdout.trim(), 10) || 0;
      } catch {
        behind = null;
      }
    }
    return {
      remoteSha: remote.sha,
      localSha,
      behind,
      repoUrl: url,
      branch: remote.branch,
      checkedAt: new Date().toISOString(),
    };
  })();

  try {
    const value = await probeInFlight;
    cached = { value, expires: Date.now() + PROBE_TTL_MS };
    return value;
  } finally {
    probeInFlight = null;
  }
}

/** Working tree clean? (no uncommitted changes, staged or not) */
async function treeClean(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      timeout: GIT_TIMEOUT, maxBuffer: 1024 * 512,
    });
    return stdout.trim().length === 0;
  } catch {
    return false;
  }
}

/** Current checked-out branch name ('' on detached HEAD). */
async function currentBranch(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

export interface AutoPullResult {
  attempted: boolean;
  pulled: boolean;
  reason: string;
  fromSha?: string;
  toSha?: string;
}

/**
 * L1 auto-update: pull this repo when it is SAFE and BEHIND. Called from the
 * lifecycle supervisor every tick (internally rate-limited) — never throws.
 */
export async function autoPullIfSafe(): Promise<AutoPullResult> {
  const no = (reason: string): AutoPullResult => ({ attempted: false, pulled: false, reason });

  if (pullInFlight) return no('another auto-pull is in flight');
  if (Date.now() - lastPullAttempt < PULL_MIN_INTERVAL_MS) {
    return no('rate-limited (5 min floor between attempts)');
  }
  if (!(await autoUpdateEnabled())) return no('auto-update disabled (ops.autoUpdate=off)');

  pullInFlight = true;
  lastPullAttempt = Date.now();
  try {
    const status = await probeSelfUpdate(true);
    if (!status.repoUrl || !status.remoteSha) {
      return no(status.error || 'origin unreachable');
    }
    if (status.localSha === status.remoteSha) return no('already up to date');
    if (status.behind === null) return no('behind-count unknown (fetch failed)');

    // Branch guard: only fast-forward the DEFAULT branch. A user who checked
    // out a feature branch on this machine owns the checkout — no auto-pull.
    const branch = await currentBranch();
    if (!status.branch || !branch || branch !== status.branch) {
      return no(`checkout branch '${branch || 'DETACHED'}' ≠ default '${status.branch}'`);
    }
    if (!(await treeClean())) {
      return no('working tree not clean — skipping (uncommitted changes present)');
    }

    // Safe: default branch, clean tree, strictly behind → ff-only pull.
    const fromSha = status.localSha || undefined;
    try {
      await execFileAsync('git', ['pull', '--ff-only'], {
        timeout: 3 * 60 * 1000, maxBuffer: 1024 * 1024,
      });
    } catch (e: any) {
      const detail = String(e?.stderr || e?.message || '').slice(0, 200);
      logActivity({
        type: 'config_change',
        level: 'warn',
        message: 'Auto-update pull failed',
        detail: `git pull --ff-only: ${detail}`,
      });
      return { attempted: true, pulled: false, reason: `git pull failed: ${detail}` };
    }
    const toSha = await localHead() || undefined;
    logActivity({
      type: 'config_change',
      level: 'success',
      message: 'Dashboard auto-updated',
      detail: `${(fromSha || '???????').slice(0, 7)} → ${(toSha || '???????').slice(0, 7)} · dev routes hot-reload; the agent is respawned by the supervisor on its next tick`,
    });
    return { attempted: true, pulled: true, reason: 'pulled', fromSha, toSha };
  } finally {
    pullInFlight = false;
  }
}

/**
 * L2 signal for heartbeat responses: everything a remote agent needs to
 * decide "my clone is stale → pull + respawn". Returns null when the origin
 * is unknown/unreachable (signal omitted entirely — agents keep their
 * current behaviour). Reads the TTL cache: heartbeat handlers must NOT pay
 * a per-request ls-remote.
 */
export async function selfUpdateSignal(): Promise<SelfUpdateSignal | null> {
  const s = await probeSelfUpdate(); // cached in the steady state
  if (!s.repoUrl || !s.remoteSha) return null;
  return {
    repoUrl: s.repoUrl,
    remoteSha: s.remoteSha,
    localSha: s.localSha || '',
  };
}

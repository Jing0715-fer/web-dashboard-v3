import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { requireApprovedUser } from '@/lib/auth';
import {
  checkLocalRepoUpdate,
  SELF_UPDATE_CACHE_KEY,
  type RepoUpdateStatus,
} from '@/lib/git-update-check';
import {
  autoUpdateEnabled,
  dashboardOriginUrl,
  dashboardLocalHead,
} from '@/lib/dashboard-self-update';

// execFile with windowsHide ON by default (see git-update-check.ts).
const execFileRawAsync = promisify(execFile);
const execFileAsync = (file: string, args: string[], opts: any = {}): Promise<{ stdout: string; stderr: string }> =>
  execFileRawAsync(file, args, { windowsHide: true, ...opts }) as unknown as Promise<{ stdout: string; stderr: string }>;

/**
 * GET /api/self-update — GitHub version check for the DASHBOARD ITSELF (v1.21).
 *
 * The dashboard already shows an "update available" pill for every managed
 * project (/api/projects/updates); this endpoint gives the dashboard's OWN
 * repository the exact same treatment, so the header button can answer
 * "am I behind origin?" with the same states (current / behind / ahead /
 * diverged / unknown) and the same 5-minute server-side cache:
 *
 *   - the repo is the server's cwd — no project row needed
 *   - the origin URL comes from `git remote get-url origin` (masked), not
 *     from a configured field
 *   - `checkLocalRepoUpdate` runs the identical ls-remote + FETCH_HEAD fetch
 *     + rev-list pipeline used for every other project, under the reserved
 *     cache key (never collides with real project ids)
 *
 * `?refresh=1` bypasses the cache — sent right after a one-click self-update
 * so the pill flips to "current" immediately.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;

  const refresh = req.nextUrl.searchParams.get('refresh') === '1';

  try {
    const repoUrl = await dashboardOriginUrl();
    if (!repoUrl) {
      // No http(s) origin (zip download, file:// remote, not a repo at all…)
      // — same silent 'unknown' degradation the project cards use.
      return NextResponse.json({
        status: {
          state: 'unknown',
          behind: null,
          ahead: null,
          remoteSha: null,
          branch: null,
          checkedAt: new Date().toISOString(),
          error: 'no http(s) origin remote on this checkout',
        } satisfies RepoUpdateStatus,
        meta: { repoUrl: null, localSha: null, branch: null, autoUpdate: await autoUpdateEnabled() },
      });
    }

    // Identical freshness pipeline as every managed project, pointed at the
    // dashboard repo itself (server cwd). TTL cache + in-flight dedupe +
    // generation invalidation all come along for free.
    const status = await checkLocalRepoUpdate(
      SELF_UPDATE_CACHE_KEY,
      process.cwd(),
      repoUrl,
      refresh,
    );

    // Local colour for the dialog: HEAD sha + checked-out branch (best-effort,
    // null on a detached HEAD / exotic setups — the UI degrades silently).
    const [localShaFull, branch] = await Promise.all([
      dashboardLocalHead(),
      (async () => {
        try {
          const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            timeout: 15_000, maxBuffer: 64 * 1024,
          });
          const b = stdout.trim();
          return b === 'HEAD' ? null : b || null;
        } catch {
          return null;
        }
      })(),
    ]);

    return NextResponse.json({
      status,
      meta: {
        repoUrl,
        localSha: localShaFull ? localShaFull.slice(0, 7) : null,
        branch,
        autoUpdate: await autoUpdateEnabled(),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

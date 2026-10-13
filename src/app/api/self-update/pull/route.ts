import { NextRequest, NextResponse } from 'next/server';
import { logActivity } from '@/lib/activity';
import { requireApprovedUser } from '@/lib/auth';
import { invalidateUpdateCache, SELF_UPDATE_CACHE_KEY } from '@/lib/git-update-check';
import {
  dashboardOriginUrl,
  invalidateSelfProbeCache,
  suppressBackgroundAutoPull,
} from '@/lib/dashboard-self-update';
import { runPullAgent } from '@/lib/pull-agent';

/**
 * POST /api/self-update/pull — ONE-CLICK UPDATE FOR THE DASHBOARD ITSELF (v1.21).
 *
 * Same principle as every managed project's update button (user request):
 * the pull goes through the v1.20 pull-conflict AGENT — the deterministic
 * backup-first state machine (preflight → backup → fetch → analyze → switch
 * → sync → restore → verify) that fully auto-resolves every conflict class —
 * just pointed at the dashboard's own repository (the server's cwd) instead
 * of a project row:
 *
 *   - dirty working tree → stashed (label `dashboard-agent <ts>`), restored
 *     after the pull; stash-pop conflicts extract *.local.bak copies
 *   - diverged history → local commits preserved on dashboard-backup/<branch>/<ts>
 *     before the reset
 *   - nothing is ever lost — the stash entry is kept as a second safety net
 *
 * Progress streams live as SSE, byte-identical to /api/projects/:id/pull-agent:
 *
 *   data: {"type":"steps","step":{...}}   — one timeline step changed
 *   data: {"type":"done","result":{...}}  — terminal success
 *   data: {"type":"failed","error":...,"detail":...,"result":{...}}
 *   data: [DONE]
 *
 * Two self-specific guards:
 *   1. a module-level in-flight lock — two concurrent self-updates would race
 *      their stash/pull sequences against each other
 *   2. suppressBackgroundAutoPull() — the L1 supervisor's silent auto-pull is
 *      pushed back 5 minutes so it can never interleave with this run
 *
 * What happens to the RUNNING dashboard when files change under it:
 *   - dev (`next dev`): Turbopack hot-reloads the changed routes; the open
 *     SSE response stays alive (the stream is already in flight)
 *   - production build: the running process keeps serving the OLD code from
 *     memory until restarted — the result summary reminds the user
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** Module-level lock: at most ONE self-update agent run per server process. */
let selfPullInFlight = false;

export async function POST(req: NextRequest) {
  try {
    return await handleSelfUpdatePull(req);
  } catch (e: any) {
    return NextResponse.json(
      {
        error: 'Self-update request failed on the dashboard',
        detail: String(e?.message || e).slice(0, 400),
      },
      { status: 500 },
    );
  }
}

async function handleSelfUpdatePull(req: NextRequest) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;

  if (selfPullInFlight) {
    return NextResponse.json(
      { error: 'A self-update is already running — wait for it to finish before starting another' },
      { status: 409 },
    );
  }

  // The engine needs a repo it can pull; the origin remote of THIS checkout is
  // the source of truth (repoUrl is only used to self-heal a missing origin).
  const repoUrl = (await dashboardOriginUrl()) || '';

  const encoder = new TextEncoder();
  selfPullInFlight = true;
  suppressBackgroundAutoPull();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch { closed = true; }
      };
      const finish = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch { /* already closed */ }
        closed = true;
      };

      try {
        const result = await runPullAgent({
          projectPath: process.cwd(),
          repoUrl,
          onProgress: (step) => send({ type: 'steps', step }),
        });

        if (result.ok) {
          // Drop BOTH caches that would otherwise report the pre-pull state:
          // the projects-style update pill (SELF_UPDATE_CACHE_KEY) and the
          // L1 background probe (heartbeat signal / auto-pull decisions).
          invalidateUpdateCache([SELF_UPDATE_CACHE_KEY]);
          invalidateSelfProbeCache();
          await logActivity({
            type: 'pull',
            level: result.autoResolved.length > 0 || result.artifacts.branch ? 'warn' : 'success',
            message: `Dashboard self-updated${result.switchedTo ? ` → ${result.switchedTo}` : ''}${result.autoResolved.length > 0 ? ` (${result.autoResolved.length} conflict(s) auto-resolved)` : ''}`,
            projectName: 'Dashboard (self)',
            detail: `${result.before} → ${result.after} · ${result.summary}`.slice(0, 300),
          });
          send({ type: 'done', result });
        } else {
          await logActivity({
            type: 'pull',
            level: 'error',
            message: 'Dashboard self-update failed',
            projectName: 'Dashboard (self)',
            detail: String(result.error || '').slice(0, 300),
          });
          send({ type: 'failed', error: result.error || 'self-update failed', detail: result.detail || '', result });
        }
      } catch (e: any) {
        // Belt-and-braces: runPullAgent never throws, but a crash here must
        // still end the stream as a failure frame, not a hang.
        try {
          await logActivity({
            type: 'pull',
            level: 'error',
            message: 'Dashboard self-update crashed',
            projectName: 'Dashboard (self)',
            detail: String(e?.message || e).slice(0, 300),
          });
        } catch { /* logging is best-effort */ }
        send({ type: 'failed', error: 'Self-update crashed', detail: String(e?.message || e).slice(0, 400) });
      } finally {
        selfPullInFlight = false;
        finish();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

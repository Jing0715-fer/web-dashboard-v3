import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logActivity } from '@/lib/activity';
import { requireApprovedUser } from '@/lib/auth';
import { invalidateUpdateCache } from '@/lib/git-update-check';
import { isValidBranchName } from '@/lib/git-branches';
import { runPullAgent } from '@/lib/pull-agent';

/**
 * POST /api/projects/:id/pull-agent — the v1.20 pull-conflict AGENT.
 *
 * Unlike the v1.17 pull route (which ASKS stash/force on a 409) this runs the
 * WHOLE pull + conflict-resolution loop to completion, backup-first, and
 * streams its progress live as Server-Sent Events so the PullAgentDialog can
 * render the timeline while the agent works:
 *
 *   data: {"type":"steps","step":{...}}   — one step changed (status/note/info)
 *   data: {"type":"done","result":{...}}  — terminal success (full result)
 *   data: {"type":"failed","error":...,"detail":...,"result":{...}}
 *   data: [DONE]
 *
 * Local projects only: the git commands must run where the code lives. A
 * remote project gets a clear 400 pointing at the device (the device agent
 * can implement the same endpoint — see skills/git-pull-conflict-agent).
 *
 * The exported POST is a crash-proof wrapper like the pull route: every
 * failure mode must answer JSON/SSE, never Next's HTML 500 page.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    return await handleAgentPull(req, ctx);
  } catch (e: any) {
    return NextResponse.json(
      {
        error: 'Agent pull request failed on the dashboard',
        detail: String(e?.message || e).slice(0, 400),
      },
      { status: 500 },
    );
  }
}

async function handleAgentPull(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;

  const { id } = await params;

  let branch = '';
  try {
    const body = await req.json();
    if (body && typeof body.branch === 'string') branch = body.branch.trim();
  } catch { /* no body / not JSON */ }
  if (branch && !isValidBranchName(branch)) {
    return NextResponse.json(
      { error: `Invalid branch name: ${branch.slice(0, 80)}` },
      { status: 400 },
    );
  }

  const project = await db.project.findUnique({ where: { id } });
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  if (project.deviceId) {
    // git must run on the machine that holds the code — this dashboard
    // cannot reach into a paired device's working tree.
    return NextResponse.json(
      {
        error: 'The agent auto-resolve runs git locally — this project lives on a paired device. Update the agent on that machine (git pull + restart) and run the pull there, or move the project to this machine first',
      },
      { status: 400 },
    );
  }
  // NOTE: no hard repoUrl requirement here (unlike the v1.17 pull route): a
  // checkout whose 'origin' remote already works is perfectly pullable. The
  // ENGINE self-heals a MISSING origin from the configured URL and fails
  // with a precise, actionable message when neither exists.

  const encoder = new TextEncoder();

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
          projectPath: project.path,
          repoUrl: project.repoUrl || '',
          branch: branch || undefined,
          onProgress: (step) => send({ type: 'steps', step }),
        });

        if (result.ok) {
          invalidateUpdateCache([project.id]);
          await logActivity({
            type: 'pull',
            level: result.autoResolved.length > 0 || result.artifacts.branch ? 'warn' : 'success',
            message: `Agent pulled ${project.name}${result.switchedTo ? ` → ${result.switchedTo}` : ''}${result.autoResolved.length > 0 ? ` (${result.autoResolved.length} conflict(s) auto-resolved)` : ''}`,
            projectId: project.id,
            projectName: project.name,
            detail: result.summary.slice(0, 300),
          });
          send({ type: 'done', result });
        } else {
          await logActivity({
            type: 'pull',
            level: 'error',
            message: `Agent pull failed: ${project.name}`,
            projectId: project.id,
            projectName: project.name,
            detail: String(result.error || '').slice(0, 300),
          });
          send({ type: 'failed', error: result.error || 'agent pull failed', detail: result.detail || '', result });
        }
      } catch (e: any) {
        // Belt-and-braces: runPullAgent never throws, but a crash here must
        // still end the stream as a failure frame, not a hang.
        try {
          await logActivity({
            type: 'pull',
            level: 'error',
            message: `Agent pull crashed: ${project.name}`,
            projectId: project.id,
            projectName: project.name,
            detail: String(e?.message || e).slice(0, 300),
          });
        } catch { /* logging is best-effort */ }
        send({ type: 'failed', error: 'Agent pull crashed', detail: String(e?.message || e).slice(0, 400) });
      } finally {
        finish();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

import { NextRequest } from 'next/server';
import { requireApprovedUser } from '@/lib/auth';
import { ensureEngine, getSession } from '@/lib/harness/engine';

/**
 * GET /api/harness/sessions/:id/events — SSE progress stream.
 * Frames: data: {status, progress[], attempt, result, error} every 2s (when
 * there is something new), terminated by `data: [DONE]` once the session
 * reaches a terminal state. Same wire format as the former standalone
 * harness-agent.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  ensureEngine();
  const { id } = await params;
  const s = getSession(id);
  if (!s) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  let lastCount = 0;
  let timer: any = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = () => {
        try {
          const items = s.progress.slice(lastCount);
          lastCount = s.progress.length;
          if (items.length > 0 || s.status !== 'running') {
            const frame = `data: ${JSON.stringify({ status: s.status, progress: items, attempt: s.attempt, result: s.result, error: s.error })}\n\n`;
            controller.enqueue(encoder.encode(frame));
          }
          if (s.status !== 'running') {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            clearInterval(timer);
          }
        } catch { /* controller closed by the client */ }
      };
      // Start the interval BEFORE the initial flush: a terminal session
      // (e.g. one restored from disk) ends the stream inside send(), which
      // must be able to clear an already-initialized timer.
      timer = setInterval(send, 2000);
      send();
    },
    cancel() {
      clearInterval(timer);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

import { db } from '@/lib/db';

/**
 * In-process LLM gateway — the former mini-services/llm-gateway(:3021),
 * consolidated into the dashboard server itself (single port).
 *
 * deepseek-harness (dsh) speaks the OpenAI wire protocol through its
 * llm-pi-ai adapter. The routes in src/app/api/llm/v1/* expose
 * POST /api/llm/v1/chat/completions and GET /api/llm/v1/models and forward
 * requests to the z-ai-web-dev-sdk backend (GLM) or, in proxy mode, to the
 * provider configured in the dashboard's LLM settings (stored in the DB —
 * the gateway reads it live, so provider changes apply immediately).
 *
 * Conventions kept from the standalone service:
 *   - Any Bearer token is accepted (LAN dev tool, same exposure as before).
 *   - Requests are sanitized: unsupported params are stripped.
 *   - Streaming responses are piped through as SSE.
 *   - Upstream calls are serialized + retried with backoff (rate limits).
 */

export const MODEL_ID = 'glm-4-plus';

export interface GatewayConfig {
  mode?: 'zai' | 'proxy';
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** Live config from the dashboard's LLM settings (DB row 'default'). */
export async function readGatewayConfig(): Promise<GatewayConfig | null> {
  try {
    const row = await db.llmConfig.findUnique({ where: { id: 'default' } });
    if (!row) return null;
    const useProxy =
      row.provider !== 'zai' && row.provider !== '' && !!row.apiKey && !!row.baseUrl;
    return {
      mode: useProxy ? 'proxy' : 'zai',
      provider: row.provider || 'zai',
      apiKey: row.apiKey || '',
      baseUrl: row.baseUrl || '',
      model: row.model || '',
    };
  } catch {
    // DB unavailable → fall back to the built-in z-ai backend.
    return null;
  }
}

export function proxyTarget(cfg: GatewayConfig | null): {
  baseUrl: string;
  apiKey: string;
  model: string;
} | null {
  if (!cfg || cfg.mode !== 'proxy') return null;
  if (!cfg.baseUrl || !cfg.apiKey) return null;
  return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model || '' };
}

export function endpointCandidates(baseUrl: string, path: string): string[] {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/v\d+[a-z0-9.-]*$/i.test(base) || /\/openai$/i.test(base)) return [`${base}/${path}`];
  return [`${base}/v1/${path}`, `${base}/${path}`];
}

// ============================= z-ai client (HMR-safe singleton) =============================

const g = globalThis as any;

interface GatewayRuntime {
  zai: any;
  zaiInitPromise: Promise<any> | null;
  inflight: Promise<any> | null;
  lastCallAt: number;
}

function rt(): GatewayRuntime {
  if (!g.__llmGatewayRuntime) {
    g.__llmGatewayRuntime = { zai: null, zaiInitPromise: null, inflight: null, lastCallAt: 0 } satisfies GatewayRuntime;
  }
  return g.__llmGatewayRuntime;
}

async function getZai(): Promise<any> {
  const st = rt();
  if (st.zai) return st.zai;
  if (!st.zaiInitPromise) {
    st.zaiInitPromise = import('z-ai-web-dev-sdk')
      .then((mod: any) => {
        const ZAI = mod.default ?? mod;
        return ZAI.create();
      })
      .then((instance: any) => {
        st.zai = instance;
        return instance;
      })
      .catch((err: any) => {
        st.zaiInitPromise = null;
        throw err;
      });
  }
  return st.zaiInitPromise;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Serialize upstream calls + space them out to stay under rate limits. */
async function serializeUpstream(fn: () => Promise<any>): Promise<any> {
  const st = rt();
  while (st.inflight) {
    try { await st.inflight; } catch { /* proceed regardless */ }
  }
  const wait = 350 - (Date.now() - st.lastCallAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  const p = fn().finally(() => { st.lastCallAt = Date.now(); st.inflight = null; });
  st.inflight = p;
  return p;
}

/** Call the backend with exponential backoff on 429/5xx. */
async function createWithRetry(client: any, payload: any, retries = 6): Promise<any> {
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    try {
      return await serializeUpstream(() => client.chat.completions.create(payload));
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || err);
      const ratey = /429|too many|rate limit/i.test(msg) || err?.status === 429;
      const transienty = /5\d\d|timeout|econn|socket hang up/i.test(msg);
      if ((ratey || transienty) && i < retries) {
        const delay = ratey ? 5000 + 4000 * i : 1500 * (i + 1);
        console.log(`[llm-gateway] retry ${i + 1}/${retries} after ${delay}ms: ${msg.slice(0, 120)}`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Strip params the z-ai backend rejects; keep messages/tools essentials. */
export function sanitize(body: any) {
  const out: any = {
    messages: body.messages,
    stream: !!body.stream,
    thinking: { type: 'disabled' },
  };
  // Forward tool-calling fields verbatim — backend supports them natively.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools;
    if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
  }
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  return out;
}

// ============================= chat completions =============================

export interface CompletionOutcome {
  kind: 'json' | 'sse-stream';
  /** kind=json → chat.completion object; kind=sse-stream → ReadableStream<string chunks> */
  data: any;
}

/**
 * Run a chat completion against the effective provider (proxy or z-ai).
 * For streaming requests returns an SSE-encoded ReadableStream (without the
 * trailing [DONE] — the route appends it so it is always present exactly once).
 */
export async function runChatCompletion(body: any): Promise<CompletionOutcome> {
  const wantsStream = !!body.stream;
  const target = proxyTarget(await readGatewayConfig());

  if (target) {
    // ---- proxy mode: forward to the user-configured provider ----
    const outBody: any = { ...body, stream: wantsStream };
    if (target.model) outBody.model = target.model;
    let lastErr = '';
    for (const url of endpointCandidates(target.baseUrl, 'chat/completions')) {
      let upstream: Response;
      try {
        upstream = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${target.apiKey}`,
          },
          body: JSON.stringify(outBody),
          signal: AbortSignal.timeout(600_000),
        });
      } catch (err: any) {
        lastErr = String(err?.message || err);
        continue;
      }
      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => upstream.statusText);
        lastErr = `Upstream ${upstream.status}: ${String(errText).slice(0, 300)}`;
        if (upstream.status === 404 || upstream.status === 405) continue;
        throw new Error(lastErr);
      }
      if (wantsStream && upstream.body) {
        // Re-encode through a string stream so the route can append [DONE].
        return { kind: 'sse-stream', data: bodyThroughText(upstream.body) };
      }
      return { kind: 'json', data: await upstream.json() };
    }
    throw new Error(`Proxy upstream error: ${lastErr.slice(0, 300)}`);
  }

  // ---- z-ai mode ----
  const client = await getZai();
  const completion = await createWithRetry(client, sanitize(body));

  if (!wantsStream) {
    const data = completion instanceof ReadableStream ? await aggregateStream(completion) : completion;
    return { kind: 'json', data };
  }

  if (completion instanceof ReadableStream) {
    return { kind: 'sse-stream', data: completionThroughText(completion) };
  }
  // Non-stream fallback shaped as a single SSE burst.
  return { kind: 'sse-stream', data: singleBurst(JSON.stringify(completion)) };
}

/** Wrap a byte stream as a text ReadableStream (SSE passthrough). */
function bodyThroughText(body: ReadableStream<Uint8Array>): ReadableStream<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  return new ReadableStream<string>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      const text = decoder.decode(value, { stream: true });
      if (text) controller.enqueue(text);
    },
    cancel(reason) { try { reader.cancel(reason); } catch { /* already closed */ } },
  });
}

/** Decode + re-enqueue the z-ai SSE stream, with keepalive comments. */
function completionThroughText(stream: ReadableStream<any>): ReadableStream<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let keepAlive: any = null;
  const armKeepalive = (enqueue: (s: string) => void) => {
    clearInterval(keepAlive);
    keepAlive = setInterval(() => enqueue(': keepalive\n\n'), 15000);
  };
  return new ReadableStream<string>({
    async pull(controller) {
      const enqueue = controller.enqueue.bind(controller);
      const { done, value } = await reader.read();
      if (done) {
        clearInterval(keepAlive);
        controller.close();
        return;
      }
      const text = decoder.decode(value, { stream: true });
      if (text) {
        enqueue(text);
        // Heartbeat comments keep intermediate proxies from closing the pipe.
        armKeepalive(enqueue);
      }
    },
    cancel() {
      clearInterval(keepAlive);
      try { reader.cancel(); } catch { /* already closed */ }
    },
  });
}

/** One-shot SSE stream carrying a single data frame. */
function singleBurst(payload: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(`data: ${payload}\n\n`);
      controller.close();
    },
  });
}

// ============================= route-handler layer =============================

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/**
 * GET handler body for /models (OpenAI-compatible model list).
 * Shared by /api/llm/v1/models and the root /models fallback — dsh (the
 * deepseek-harness agent) drops the path portion of baseURL and calls
 * <origin>/models and <origin>/chat/completions directly.
 */
export async function modelsResponse(): Promise<Response> {
  try {
    const target = proxyTarget(await readGatewayConfig());
    if (target) {
      // Proxy mode: forward the live model list from the configured provider.
      for (const url of endpointCandidates(target.baseUrl, 'models')) {
        try {
          const upstream = await fetch(url, {
            headers: { Authorization: `Bearer ${target.apiKey}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (upstream.ok) {
            const raw = await upstream.text();
            if (!raw.trimStart().startsWith('<')) {
              return new Response(raw, {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
            }
          }
        } catch { /* try next candidate */ }
      }
      return jsonGatewayResponse({
        object: 'list',
        data: [{ id: target.model || MODEL_ID, object: 'model', created: 1700000000, owned_by: 'proxy' }],
      });
    }
    return jsonGatewayResponse({
      object: 'list',
      data: [{ id: MODEL_ID, object: 'model', created: 1700000000, owned_by: 'zai' }],
    });
  } catch (e: any) {
    return jsonGatewayError(500, String(e?.message || e));
  }
}

/**
 * POST handler body for /chat/completions.
 * Shared by /api/llm/v1/chat/completions and the root /chat/completions
 * fallback (see modelsResponse for why the fallback exists).
 */
export async function chatCompletionsResponse(body: any): Promise<Response> {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return jsonGatewayError(400, 'messages[] is required');
  }
  try {
    const outcome = await runChatCompletion(body);
    if (outcome.kind === 'json') {
      return jsonGatewayResponse(outcome.data);
    }
    // SSE stream: pipe the provider frames and append the terminating
    // [DONE] exactly once.
    const source = outcome.data as ReadableStream<string>;
    const reader = source.getReader();
    const stream = new ReadableStream<string>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.enqueue('data: [DONE]\n\n');
            controller.close();
            return;
          }
          if (value) controller.enqueue(value);
        } catch (err: any) {
          // Surface mid-stream errors as an SSE error frame, then terminate.
          try {
            controller.enqueue(`data: ${JSON.stringify({ error: { message: String(err?.message || err) } })}\n\n`);
            controller.enqueue('data: [DONE]\n\n');
            controller.close();
          } catch { /* controller gone */ }
        }
      },
      cancel(reason) {
        try { reader.cancel(reason); } catch { /* already closed */ }
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  } catch (err: any) {
    console.error('[llm-gateway] completion error:', err?.message || err);
    return jsonGatewayError(502, `Upstream LLM error: ${String(err?.message || err).slice(0, 300)}`);
  }
}

function jsonGatewayResponse(data: any): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonGatewayError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: 'gateway_error', code: status } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Merge an SSE ReadableStream into one chat.completion object. */
async function aggregateStream(stream: ReadableStream<any>): Promise<any> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deltas: any[] = [];
  let usage: any = undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.usage) usage = parsed.usage;
        if (Array.isArray(parsed.choices)) deltas.push(...parsed.choices);
      } catch { /* tolerate partial frames */ }
    }
  }
  // Merge deltas into one choice with accumulated content / tool_calls.
  let content = '';
  let role = 'assistant';
  let finish_reason: string | null = null;
  const toolCalls: any[] = [];
  for (const d of deltas) {
    const delta = d?.delta || {};
    if (delta.role) role = delta.role;
    if (typeof delta.content === 'string') content += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        toolCalls[i] = toolCalls[i] || { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
        if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
      }
    }
    if (d?.finish_reason) finish_reason = d.finish_reason;
  }
  const message: any = { role, content };
  const cleanToolCalls = toolCalls.filter(Boolean);
  if (cleanToolCalls.length > 0) {
    message.tool_calls = cleanToolCalls;
    if (!finish_reason) finish_reason = 'tool_calls';
  }
  return {
    id: `gw-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [{ index: 0, message, finish_reason: finish_reason || 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

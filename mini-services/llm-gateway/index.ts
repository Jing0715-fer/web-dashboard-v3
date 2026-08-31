/**
 * LLM Gateway — OpenAI-compatible bridge over z-ai-web-dev-sdk
 *
 * Purpose: deepseek-harness (dsh) speaks the OpenAI wire protocol through its
 * llm-pi-ai adapter. This gateway exposes POST /v1/chat/completions and
 * GET /v1/models on 127.0.0.1:3021 and forwards requests to the local
 * z-ai-web-dev-sdk backend (GLM), which natively supports OpenAI-style
 * messages, tools / tool_calls and SSE streaming.
 *
 * Proxy mode: when mini-services/llm-gateway/config.json contains
 * { mode: "proxy", apiKey, baseUrl, model } (written by the dashboard's
 * LLM settings dialog), requests are forwarded to that provider instead,
 * with the model name mapped to the configured one. The config is re-read
 * per request, so provider changes apply immediately.
 *
 * Conventions:
 *   - Any Bearer token is accepted (loopback-only service).
 *   - Requests are sanitized: unsupported params are stripped.
 *   - Streaming responses are piped through as SSE.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import ZAI from 'z-ai-web-dev-sdk';

const PORT = 3021;
const MODEL_ID = 'glm-4-plus';
const CONFIG_PATH = join(import.meta.dir, 'config.json');

interface GatewayConfig {
  mode?: 'zai' | 'proxy';
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

function readConfig(): GatewayConfig | null {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function proxyTarget(cfg: GatewayConfig | null): { baseUrl: string; apiKey: string; model: string } | null {
  if (!cfg || cfg.mode !== 'proxy') return null;
  if (!cfg.baseUrl || !cfg.apiKey) return null;
  return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model || '' };
}

function endpointCandidates(baseUrl: string, path: string): string[] {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/v\d+[a-z0-9.-]*$/i.test(base) || /\/openai$/i.test(base)) return [`${base}/${path}`];
  return [`${base}/v1/${path}`, `${base}/${path}`];
}

let zai: any = null;
let zaiInitPromise: Promise<any> | null = null;
let inflight: Promise<any> | null = null;
let lastCallAt = 0;

/** Serialize upstream calls + space them out to stay under rate limits. */
async function serializeUpstream(fn: () => Promise<any>): Promise<any> {
  while (inflight) {
    try { await inflight; } catch { /* proceed regardless */ }
  }
  const wait = 350 - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  const p = fn().finally(() => { lastCallAt = Date.now(); inflight = null; });
  inflight = p;
  return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

async function getZai(): Promise<any> {
  if (zai) return zai;
  if (!zaiInitPromise) {
    zaiInitPromise = ZAI.create()
      .then((instance: any) => {
        zai = instance;
        return instance;
      })
      .catch((err: any) => {
        zaiInitPromise = null;
        throw err;
      });
  }
  return zaiInitPromise;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/** Strip params the z-ai backend rejects; keep messages/tools essentials. */
function sanitize(body: any) {
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

function jsonError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'gateway_error', code: status } }));
}

async function handleChatCompletions(req: IncomingRequest, res: ServerResponse) {
  const raw = await readBody(req);
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError(res, 400, 'Invalid JSON body');
  }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return jsonError(res, 400, 'messages[] is required');
  }

  const wantsStream = !!body.stream;

  // ---- proxy mode: forward to the user-configured provider ----
  const target = proxyTarget(readConfig());
  if (target) {
    return handleProxyChat(req, res, body, target, wantsStream);
  }

  const payload = sanitize(body);

  let completion: any;
  try {
    const client = await getZai();
    completion = await createWithRetry(client, payload);
  } catch (err: any) {
    console.error('[llm-gateway] completion error:', err?.message || err);
    return jsonError(res, 502, `Upstream LLM error: ${String(err?.message || err).slice(0, 300)}`);
  }

  if (!wantsStream) {
    const data = completion instanceof ReadableStream ? await aggregateStream(completion) : completion;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // Streaming: completion is a ReadableStream of SSE-encoded chunks.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  try {
    if (completion instanceof ReadableStream) {
      const reader = completion.getReader();
      const decoder = new TextDecoder();
      let keepAlive: any = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text) res.write(text);
        // Heartbeat comments keep intermediate proxies from closing the pipe.
        clearInterval(keepAlive);
        keepAlive = setInterval(() => res.write(': keepalive\n\n'), 15000);
      }
      clearInterval(keepAlive);
    } else {
      // Non-stream fallback shaped as a single SSE burst.
      res.write(`data: ${JSON.stringify(completion)}\n\n`);
    }
  } catch (err: any) {
    console.error('[llm-gateway] stream pipe error:', err?.message || err);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/** Forward a chat completion to the configured remote provider. */
async function handleProxyChat(
  _req: IncomingRequest,
  res: ServerResponse,
  body: any,
  target: { baseUrl: string; apiKey: string; model: string },
  wantsStream: boolean,
) {
  // Pass the body through mostly verbatim (tools etc.), but force the
  // configured model and strip params the z-ai sanitizer would drop —
  // remote providers accept the full OpenAI surface natively.
  const outBody: any = { ...body, stream: wantsStream };
  if (target.model) outBody.model = target.model;

  let lastErr = '';
  for (const url of endpointCandidates(target.baseUrl, 'chat/completions')) {
    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${target.apiKey}`,
        },
        body: JSON.stringify(outBody),
        signal: AbortSignal.timeout(600_000),
      });

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => upstream.statusText);
        lastErr = `Upstream ${upstream.status}: ${String(errText).slice(0, 300)}`;
        if (upstream.status === 404 || upstream.status === 405) continue;
        return jsonError(res, 502, lastErr);
      }

      if (wantsStream && upstream.body) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) res.write(value);
          }
        } catch (err: any) {
          console.error('[llm-gateway] proxy stream error:', err?.message || err);
        }
        res.end();
        return;
      }

      const data = await upstream.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    } catch (err: any) {
      lastErr = String(err?.message || err);
    }
  }
  return jsonError(res, 502, `Proxy upstream error: ${lastErr.slice(0, 300)}`);
}

/** Aggregate an SSE ReadableStream into a chat.completion object. */
async function aggregateStream(stream: ReadableStream): Promise<any> {
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

type IncomingRequest = IncomingMessage;

const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const url = (req.url || '').split('?')[0];

  try {
    if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
      // Proxy mode: forward the live model list from the configured provider.
      const target = proxyTarget(readConfig());
      if (target) {
        for (const url2 of endpointCandidates(target.baseUrl, 'models')) {
          try {
            const upstream = await fetch(url2, {
              headers: { Authorization: `Bearer ${target.apiKey}` },
              signal: AbortSignal.timeout(10_000),
            });
            if (upstream.ok) {
              const raw = await upstream.text();
              if (!raw.trimStart().startsWith('<')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(raw);
              }
            }
          } catch { /* try next candidate */ }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          object: 'list',
          data: [{ id: target.model || MODEL_ID, object: 'model', created: 1700000000, owned_by: 'proxy' }],
        }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        object: 'list',
        data: [{ id: MODEL_ID, object: 'model', created: 1700000000, owned_by: 'zai' }],
      }));
    }
    if (req.method === 'GET' && (url === '/health' || url === '/')) {
      const cfg = readConfig();
      const target = proxyTarget(cfg);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        mode: target ? 'proxy' : 'zai',
        model: target?.model || MODEL_ID,
        uptime: process.uptime(),
      }));
    }
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
      return await handleChatCompletions(req as IncomingRequest, res);
    }
    jsonError(res, 404, `No route: ${req.method} ${url}`);
  } catch (err: any) {
    console.error('[llm-gateway] unhandled error:', err);
    if (!res.headersSent) jsonError(res, 500, String(err?.message || err));
    else res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[llm-gateway] listening on http://0.0.0.0:${PORT} (OpenAI-compatible, model=${MODEL_ID})`);
});

/**
 * LLM provider catalog + shared chat client.
 *
 * The catalog is modeled after pdb-tracker-web-v5's provider catalog: a
 * built-in list of OpenAI-compatible providers with default baseURLs, auth
 * header formats, default models and known model lists. The frontend LLM
 * settings dialog renders the selector from this catalog; after the user
 * enters an API key, /api/llm-config/models live-fetches the model list from
 * the provider's /models endpoint.
 *
 * callLLM() is the single shared client used by project analysis, the
 * auto-repair engine and any other backend feature that needs a chat
 * completion. It reads the persisted llmConfig row (provider/apiKey/baseUrl/
 * model) and falls back to the built-in z-ai SDK when no key is configured.
 */

import { db } from '@/lib/db';

// z-ai-web-dev-sdk is optional — only used when provider is 'zai'
// Handle both direct CJS and bundler-wrapped { default: ... } interop shapes.
let ZAI: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod: any = require('z-ai-web-dev-sdk');
  ZAI = typeof mod?.create === 'function' ? mod : (mod?.default ?? mod);
} catch {
  // package not installed — zai provider will be unavailable
}

export interface ProviderModel {
  id: string;
  name: string;
  contextWindow?: number;
}

export interface ProviderProfile {
  id: string;
  displayName: string;
  /** Short text label (1-3 chars) for compact UI display. */
  label: string;
  /** Default base URL for the API (includes the version path). */
  baseURL: string;
  /** The env var that typically holds the API key. */
  apiKeyEnv: string;
  /** Auth header name (default: 'Authorization'). */
  authHeader?: string;
  /** Auth header value prefix (default: 'Bearer '). */
  authPrefix?: string;
  /** Default model id (used when settings don't specify one). */
  defaultModel: string;
  /** Known models for this provider. */
  models: ProviderModel[];
  /** Optional: extra headers to send. */
  extraHeaders?: Record<string, string>;
  /** Whether an API key is required (zai uses the built-in SDK, ollama is local). */
  requiresKey: boolean;
  /** Documentation URL for getting an API key. */
  docsUrl: string;
}

/** The built-in provider catalog (ported from pdb-tracker-web-v5). */
export const PROVIDER_CATALOG: ProviderProfile[] = [
  {
    id: 'zai',
    displayName: 'Z.ai (GLM) — 内置',
    label: 'ZAI',
    baseURL: '',
    apiKeyEnv: 'ZAI_API_KEY',
    defaultModel: 'glm-4-plus',
    models: [
      { id: 'glm-4-plus', name: 'GLM-4 Plus', contextWindow: 128000 },
      { id: 'glm-4-flash', name: 'GLM-4 Flash', contextWindow: 128000 },
      { id: 'glm-4-air', name: 'GLM-4 Air', contextWindow: 128000 },
    ],
    requiresKey: false,
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    label: 'DS',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3 (Chat)', contextWindow: 64000 },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1 (Reasoner)', contextWindow: 64000 },
    ],
    requiresKey: true,
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    label: 'AI',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
    models: [
      { id: 'gpt-4.1', name: 'GPT-4.1', contextWindow: 1047576 },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', contextWindow: 1047576 },
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', contextWindow: 128000 },
      { id: 'o4-mini', name: 'o4-mini', contextWindow: 200000 },
    ],
    requiresKey: true,
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic (Claude)',
    label: 'AN',
    baseURL: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    authHeader: 'x-api-key',
    authPrefix: '',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
    defaultModel: 'claude-sonnet-4-20250514',
    models: [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', contextWindow: 200000 },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', contextWindow: 200000 },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', contextWindow: 200000 },
    ],
    requiresKey: true,
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'google',
    displayName: 'Google (Gemini)',
    label: 'GG',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GOOGLE_API_KEY',
    defaultModel: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1048576 },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576 },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', contextWindow: 1048576 },
    ],
    requiresKey: true,
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'qwen',
    displayName: 'Qwen (Alibaba)',
    label: 'QW',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-plus',
    models: [
      { id: 'qwen3-max', name: 'Qwen3 Max', contextWindow: 262144 },
      { id: 'qwen3-plus', name: 'Qwen3 Plus', contextWindow: 131072 },
      { id: 'qwen-plus', name: 'Qwen Plus (v2)', contextWindow: 131072 },
      { id: 'qwen-max', name: 'Qwen Max (v2)', contextWindow: 32768 },
    ],
    requiresKey: true,
    docsUrl: 'https://dashscope.console.aliyun.com/apiKey',
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot (Kimi)',
    label: 'MS',
    baseURL: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    defaultModel: 'moonshot-v1-8k',
    models: [
      { id: 'moonshot-v1-8k', name: 'Moonshot v1 (8k)', contextWindow: 8000 },
      { id: 'moonshot-v1-32k', name: 'Moonshot v1 (32k)', contextWindow: 32000 },
      { id: 'moonshot-v1-128k', name: 'Moonshot v1 (128k)', contextWindow: 128000 },
      { id: 'kimi-k2-0905-preview', name: 'Kimi K2', contextWindow: 131072 },
    ],
    requiresKey: true,
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'zhipu',
    displayName: 'Zhipu AI',
    label: 'ZP',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'ZHIPU_API_KEY',
    defaultModel: 'glm-4-plus',
    models: [
      { id: 'glm-4-plus', name: 'GLM-4 Plus', contextWindow: 128000 },
      { id: 'glm-4-air', name: 'GLM-4 Air', contextWindow: 128000 },
      { id: 'glm-4-flash', name: 'GLM-4 Flash', contextWindow: 128000 },
    ],
    requiresKey: true,
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    label: 'MM',
    baseURL: 'https://api.minimaxi.com/v1',
    apiKeyEnv: 'MINIMAX_API_KEY',
    defaultModel: 'MiniMax-Text-01',
    models: [
      { id: 'MiniMax-Text-01', name: 'MiniMax Text 01', contextWindow: 1000000 },
      { id: 'abab6.5s-chat', name: 'abab6.5s', contextWindow: 245760 },
    ],
    requiresKey: true,
    docsUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  {
    id: 'xai',
    displayName: 'xAI (Grok)',
    label: 'xA',
    baseURL: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    defaultModel: 'grok-3',
    models: [
      { id: 'grok-3', name: 'Grok 3', contextWindow: 131072 },
      { id: 'grok-3-mini', name: 'Grok 3 Mini', contextWindow: 131072 },
    ],
    requiresKey: true,
    docsUrl: 'https://console.x.ai',
  },
  {
    id: 'mistral',
    displayName: 'Mistral',
    label: 'MI',
    baseURL: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    defaultModel: 'mistral-large-latest',
    models: [
      { id: 'mistral-large-latest', name: 'Mistral Large', contextWindow: 128000 },
      { id: 'mistral-small-latest', name: 'Mistral Small', contextWindow: 32000 },
      { id: 'codestral-latest', name: 'Codestral', contextWindow: 256000 },
    ],
    requiresKey: true,
    docsUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'groq',
    displayName: 'Groq',
    label: 'GQ',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', contextWindow: 131072 },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', contextWindow: 131072 },
      { id: 'deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 Distill', contextWindow: 131072 },
    ],
    requiresKey: true,
    docsUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    label: 'OR',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    defaultModel: 'deepseek/deepseek-chat',
    models: [
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3', contextWindow: 64000 },
      { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200000 },
      { id: 'openai/gpt-4.1', name: 'GPT-4.1', contextWindow: 1047576 },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576 },
    ],
    requiresKey: true,
    docsUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'siliconflow',
    displayName: 'SiliconFlow',
    label: 'SF',
    baseURL: 'https://api.siliconflow.cn/v1',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', contextWindow: 64000 },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1', contextWindow: 64000 },
      { id: 'Qwen/Qwen3-235B-A22B-Instruct', name: 'Qwen3 235B', contextWindow: 32768 },
    ],
    requiresKey: true,
    docsUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'together',
    displayName: 'Together AI',
    label: 'TG',
    baseURL: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B', contextWindow: 131072 },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1', contextWindow: 131072 },
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', contextWindow: 131072 },
    ],
    requiresKey: true,
    docsUrl: 'https://api.together.xyz/settings/api-keys',
  },
  {
    id: 'fireworks',
    displayName: 'Fireworks AI',
    label: 'FW',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    models: [
      { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', name: 'Llama 3.3 70B', contextWindow: 131072 },
      { id: 'accounts/fireworks/models/deepseek-v3', name: 'DeepSeek V3', contextWindow: 64000 },
    ],
    requiresKey: true,
    docsUrl: 'https://fireworks.ai/account/api-keys',
  },
  {
    id: 'ollama',
    displayName: 'Ollama (Local)',
    label: 'OL',
    baseURL: 'http://localhost:11434/v1',
    apiKeyEnv: 'OLLAMA_API_KEY',
    defaultModel: 'llama3.2',
    models: [
      { id: 'llama3.2', name: 'Llama 3.2', contextWindow: 128000 },
      { id: 'qwen2.5', name: 'Qwen 2.5', contextWindow: 32768 },
      { id: 'deepseek-r1', name: 'DeepSeek R1', contextWindow: 128000 },
    ],
    requiresKey: false,
    docsUrl: 'https://ollama.com',
  },
];

/** Get a provider profile by id. */
export function getProviderProfile(id: string): ProviderProfile | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

/** The catalog as consumed by the frontend settings dialog (no secrets). */
export function publicCatalog() {
  return PROVIDER_CATALOG.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    label: p.label,
    baseURL: p.baseURL,
    apiKeyEnv: p.apiKeyEnv,
    defaultModel: p.defaultModel,
    models: p.models.map((m) => ({ id: m.id, name: m.name })),
    requiresKey: p.requiresKey,
    docsUrl: p.docsUrl,
  }));
}

/**
 * Resolve endpoint URL candidates for a base URL.
 * Handles bases that already include the version path (e.g.
 * https://api.openai.com/v1) and legacy bases without one.
 */
export function endpointCandidates(baseUrl: string, path: string): string[] {
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return [];
  if (/\/v\d+[a-z0-9.-]*$/i.test(base) || /\/openai$/i.test(base)) {
    return [`${base}/${path}`];
  }
  return [`${base}/v1/${path}`, `${base}/${path}`];
}

/** Build the auth headers for a provider profile + key. */
export function providerAuthHeaders(profile: ProviderProfile | undefined, apiKey: string): Record<string, string> {
  const header = profile?.authHeader || 'Authorization';
  const prefix = profile?.authPrefix ?? 'Bearer ';
  const headers: Record<string, string> = { [header]: `${prefix}${apiKey}` };
  if (profile?.extraHeaders) Object.assign(headers, profile.extraHeaders);
  return headers;
}

// ============================= shared chat client =============================

let zaiClient: any = null;
let zaiInitPromise: Promise<any> | null = null;

async function getZaiClient(): Promise<any> {
  if (zaiClient) return zaiClient;
  if (!ZAI) throw new Error('z-ai-web-dev-sdk is not installed');
  if (!zaiInitPromise) {
    zaiInitPromise = ZAI.create()
      .then((instance: any) => {
        zaiClient = instance;
        return instance;
      })
      .catch((err: any) => {
        zaiInitPromise = null;
        throw err;
      });
  }
  return zaiInitPromise;
}

export interface CallLlmOptions {
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface CallLlmResult {
  text: string;
  provider: string;
  model: string;
}

/**
 * Single shared chat-completion client. Reads the persisted llmConfig and
 * routes to the configured provider; falls back to the built-in z-ai SDK
 * when no API key is available.
 */
export async function callLLM(opts: CallLlmOptions): Promise<CallLlmResult> {
  const llmConfig = await db.llmConfig.findUnique({ where: { id: 'default' } });
  const provider = llmConfig?.provider || 'zai';

  // ---- zai (built-in SDK, no key needed) ----
  if (provider === 'zai' || (!llmConfig?.apiKey && provider !== 'claude-code')) {
    const zai = await getZaiClient();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.prompt },
      ],
      thinking: { type: 'disabled' },
      ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
    });
    return {
      text: completion.choices[0]?.message?.content || '',
      provider: 'zai',
      model: 'glm-4-plus',
    };
  }

  // ---- anthropic / claude-code (Messages API) ----
  if (provider === 'anthropic' || provider === 'claude-code') {
    let effectiveApiKey = llmConfig!.apiKey;
    let effectiveBaseUrl = llmConfig!.baseUrl;
    let effectiveModel = llmConfig!.model || 'claude-sonnet-4-20250514';

    if (provider === 'claude-code' && !effectiveApiKey) {
      effectiveApiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
      effectiveBaseUrl = process.env.ANTHROPIC_BASE_URL || process.env.CLAUDE_BASE_URL || effectiveBaseUrl;
      effectiveModel = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || effectiveModel;
    }

    if (!effectiveApiKey) {
      throw new Error('No Anthropic API key available. Please configure LLM settings.');
    }

    const candidates = effectiveBaseUrl
      ? endpointCandidates(effectiveBaseUrl, 'messages')
      : ['https://api.anthropic.com/v1/messages'];

    let lastErr = '';
    for (const apiUrl of candidates) {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': effectiveApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: effectiveModel,
          max_tokens: opts.maxTokens ?? 4096,
          system: opts.system,
          messages: [{ role: 'user', content: opts.prompt }],
          temperature: opts.temperature ?? 0.3,
        }),
        // Hard timeout — without it a hung provider connection stalls repair
        // jobs in 'running' forever (running jobs are never pruned).
        signal: AbortSignal.timeout(120_000),
      });
      if (res.ok) {
        const data = await res.json();
        return { text: data.content?.[0]?.text || '', provider, model: effectiveModel };
      }
      lastErr = `Anthropic API error (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`;
      // 404/405 → wrong path candidate, try the next one; other errors are real
      if (res.status !== 404 && res.status !== 405) break;
    }
    throw new Error(lastErr || 'Anthropic API request failed');
  }

  // ---- OpenAI-compatible providers ----
  const profile = getProviderProfile(provider);
  const baseUrl = llmConfig!.baseUrl || profile?.baseURL || 'https://api.openai.com/v1';
  const model = llmConfig!.model || profile?.defaultModel || 'gpt-4o-mini';
  const candidates = endpointCandidates(baseUrl, 'chat/completions');

  let lastErr = '';
  for (const apiUrl of candidates) {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llmConfig!.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.prompt },
        ],
        temperature: opts.temperature ?? 0.3,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      }),
      // Hard timeout — without it a hung provider connection stalls repair
      // jobs in 'running' forever (running jobs are never pruned).
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) {
      const data = await res.json();
      return { text: data.choices?.[0]?.message?.content || '', provider, model };
    }
    lastErr = `LLM API error (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`;
    if (res.status !== 404 && res.status !== 405) break;
  }
  throw new Error(lastErr || 'LLM API request failed');
}

/** Extract the first JSON object from an LLM response (handles code fences). */
export function extractJson(text: string): any | null {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

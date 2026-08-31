/**
 * GET /api/llm-config/models?provider=X&apiKey=Y&baseUrl=Z
 *
 * Live-fetches the model list for a provider (pdb-tracker-web-v5 pattern).
 * Most providers support the OpenAI-compatible GET /models endpoint. Falls
 * back to the built-in catalog models when no key is provided or the API
 * call fails, attaching a warning/error message.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  getProviderProfile,
  endpointCandidates,
  providerAuthHeaders,
  PROVIDER_CATALOG,
} from '@/lib/llm-providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const providerId = searchParams.get('provider') || '';
  const queryApiKey = searchParams.get('apiKey') || '';
  const queryBaseUrl = searchParams.get('baseUrl') || '';
  // useSavedKey=1 → live-fetch with the key stored server-side. Lets the
  // dialog refresh the model list without the secret ever reaching the
  // browser (the key is masked in GET /api/llm-config now).
  const useSavedKey = searchParams.get('useSavedKey') === '1';

  // zai uses the built-in z-ai SDK — return the catalog list directly.
  if (providerId === 'zai' || providerId === '') {
    const zai = getProviderProfile('zai');
    return NextResponse.json({
      models: zai!.models.map((m) => ({ id: m.id, name: m.name })),
      live: false,
      note: 'Z.ai 使用内置 SDK，无需 API Key（以下为可用模型）',
    });
  }

  const profile = getProviderProfile(providerId);
  const catalogModels = (profile?.models ?? []).map((m) => ({ id: m.id, name: m.name }));

  if (!profile && !queryBaseUrl) {
    return NextResponse.json(
      { error: `Unknown provider: ${providerId} (set a Base URL for custom providers)` },
      { status: 404 },
    );
  }

  // Custom provider: require a baseUrl
  const baseUrl = queryBaseUrl || profile!.baseURL;
  if (!baseUrl) {
    return NextResponse.json({ models: [], error: 'Base URL is required for this provider' });
  }

  // Resolve the key: explicit query key (newly typed) > saved key from DB
  // (useSavedKey) > keyless providers. Masked round-trips are ignored.
  let apiKey = queryApiKey;
  if (!apiKey && useSavedKey) {
    try {
      const saved = await db.llmConfig.findUnique({ where: { id: 'default' } });
      if (saved?.apiKey && !saved.apiKey.includes('•')) apiKey = saved.apiKey;
    } catch { /* best-effort — fall through to catalog */ }
  }
  if (!apiKey && profile?.requiresKey === false) apiKey = 'ollama';
  if (!apiKey) {
    return NextResponse.json({
      models: catalogModels,
      live: false,
      warning: '尚未填写 API Key — 以下为内置目录模型，填入 Key 后可实时获取完整列表',
    });
  }

  const headers: Record<string, string> = {
    ...providerAuthHeaders(profile, apiKey),
  };

  const candidates = endpointCandidates(baseUrl, 'models');
  let lastErr = '';

  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        lastErr = `API returned ${resp.status}: ${(await resp.text().catch(() => resp.statusText)).slice(0, 200)}`;
        if (resp.status === 404 || resp.status === 405) continue; // wrong path candidate
        break;
      }

      const raw = await resp.text();

      // Check for HTML (wrong URL)
      if (raw.trimStart().startsWith('<')) {
        lastErr = 'API 返回了 HTML 而非 JSON — 请检查 Base URL 是否正确';
        continue;
      }

      const data = JSON.parse(raw);

      // OpenAI-compatible: { data: [{ id, ... }] }
      const models = Array.isArray(data?.data)
        ? data.data
            .map((m: any) => ({ id: m.id as string, name: (m.name as string) || m.id, owned_by: m.owned_by }))
            .filter((m: any) => typeof m.id === 'string' && m.id)
        : Array.isArray(data?.models)
          ? data.models.map((m: any) => ({
              id: typeof m === 'string' ? m : m.id,
              name: typeof m === 'string' ? m : (m.name ?? m.id),
            }))
          : [];

      if (models.length === 0) {
        lastErr = 'API 返回了空模型列表';
        continue;
      }

      // Merge: live models first, keep any catalog models missing from the live list
      const liveIds = new Set(models.map((m: any) => m.id));
      const extra = catalogModels.filter((m) => !liveIds.has(m.id));

      return NextResponse.json({
        models: [...models, ...extra],
        live: true,
        count: models.length,
      });
    } catch (err: any) {
      lastErr = `Failed to fetch models: ${err?.message || String(err)}`;
    }
  }

  return NextResponse.json({
    models: catalogModels,
    live: false,
    error: lastErr || 'Failed to fetch models',
  });
}

/** Convenience: expose the full provider catalog ids. */
export async function POST() {
  return NextResponse.json({ providers: PROVIDER_CATALOG.map((p) => p.id) });
}

import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { publicCatalog } from '@/lib/llm-providers'
import { requireAdmin, requireApprovedUser } from '@/lib/auth';

/**
 * Mask an API key for display: keep only the last 4 characters.
 * The full key NEVER leaves the server once stored.
 */
function maskApiKey(key: string | null | undefined): string {
  if (!key) return ''
  if (key.length <= 4) return '••••'
  return `••••${key.slice(-4)}`
}

/**
 * Detect whether a PUT body carries a masked (unchanged) key rather than a
 * freshly typed one. Masked values round-tripped from the GET response must
 * not overwrite the stored secret.
 */
function isMaskedKey(key: string): boolean {
  return key.includes('•') || /^\*{4}/.test(key)
}

/** Validate the repair-engine preference. Accepted:
 *   ''            → auto-detect (first installed CLI by priority)
 *   'claude' | 'codex' | 'gemini' | 'opencode' | 'hermes'
 *   'custom:<template containing {promptFile} or {promptFileAbs}>'
 * Invalid values collapse to '' (auto) — never reject a whole save for it. */
const KNOWN_CLI_IDS = ['claude', 'codex', 'gemini', 'opencode', 'hermes'];

function normalizeRepairCli(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim().slice(0, 600);
  if (!s) return '';
  if (KNOWN_CLI_IDS.includes(s)) return s;
  if (s.startsWith('custom:')) {
    const template = s.slice('custom:'.length).trim();
    const hasPlaceholder = template.includes('{promptFile}') || template.includes('{promptFileAbs}');
    if (template.length >= 4 && template.length <= 500 && hasPlaceholder) return `custom:${template}`;
  }
  return '';
}

export async function GET(req: Request) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    let config = await db.llmConfig.findUnique({ where: { id: 'default' } })

    if (!config) {
      // Create default config if it doesn't exist
      config = await db.llmConfig.create({ data: { id: 'default' } })
    }

    // Include the provider catalog so the settings dialog can render the
    // selector without a second round-trip. The API key is masked — the
    // browser only ever sees the last 4 characters.
    return NextResponse.json({
      id: config.id,
      provider: config.provider,
      apiKey: maskApiKey(config.apiKey),
      hasApiKey: !!config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      repairMode: config.repairMode || 'legacy',
      repairCli: config.repairCli || '',
      updatedAt: config.updatedAt,
      catalog: publicCatalog(),
    })
  } catch (error) {
    console.error('Failed to fetch LLM config:', error)
    return NextResponse.json({ error: 'Failed to fetch LLM config' }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  // Auth guard (Task 11-a)
  const adminGuard = await requireAdmin(request);
  if (adminGuard.error) return adminGuard.error;
  try {
    const body = await request.json()
    const { provider, apiKey, baseUrl, model, repairMode, repairCli } = body

    // Resolve the effective key: masked / unchanged values keep the stored
    // secret instead of clobbering it.
    let effectiveApiKey: string | undefined
    if (apiKey === undefined) {
      // field absent → leave as-is
    } else if (typeof apiKey === 'string' && isMaskedKey(apiKey)) {
      effectiveApiKey = undefined // keep stored
    } else {
      effectiveApiKey = typeof apiKey === 'string' ? apiKey : ''
    }

    const config = await db.llmConfig.upsert({
      where: { id: 'default' },
      update: {
        ...(provider !== undefined && { provider }),
        ...(effectiveApiKey !== undefined && { apiKey: effectiveApiKey }),
        ...(baseUrl !== undefined && { baseUrl }),
        ...(model !== undefined && { model }),
        ...(repairMode !== undefined && { repairMode: repairMode === 'cli' ? 'cli' : 'legacy' }),
        ...(repairCli !== undefined && { repairCli: normalizeRepairCli(repairCli) }),
      },
      create: {
        id: 'default',
        provider: provider || '',
        apiKey: effectiveApiKey ?? '',
        baseUrl: baseUrl || '',
        model: model || '',
        repairMode: repairMode === 'cli' ? 'cli' : 'legacy',
        repairCli: normalizeRepairCli(repairCli),
      },
    })

    // The in-process LLM gateway (/api/llm/v1) reads this same DB row live on
    // every request, so a provider change here applies to dsh analysis
    // immediately — no config file sync needed anymore.

    // Respond with the same masked shape as GET so a save→reopen cycle
    // never leaks the full key either.
    return NextResponse.json({
      id: config.id,
      provider: config.provider,
      apiKey: maskApiKey(config.apiKey),
      hasApiKey: !!config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      repairMode: config.repairMode || 'legacy',
      repairCli: config.repairCli || '',
      updatedAt: config.updatedAt,
    })
  } catch (error) {
    console.error('Failed to update LLM config:', error)
    return NextResponse.json({ error: 'Failed to update LLM config' }, { status: 500 })
  }
}

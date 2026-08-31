import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { publicCatalog } from '@/lib/llm-providers'

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

export async function GET() {
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
      updatedAt: config.updatedAt,
      catalog: publicCatalog(),
    })
  } catch (error) {
    console.error('Failed to fetch LLM config:', error)
    return NextResponse.json({ error: 'Failed to fetch LLM config' }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json()
    const { provider, apiKey, baseUrl, model } = body

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
      },
      create: {
        id: 'default',
        provider: provider || '',
        apiKey: effectiveApiKey ?? '',
        baseUrl: baseUrl || '',
        model: model || '',
      },
    })

    // Sync the llm-gateway (mini-services/llm-gateway/config.json) so the
    // deepseek-harness agent layer also uses the configured provider.
    // When a real provider+key is set the gateway proxies to it; otherwise
    // it keeps using the built-in z-ai SDK.
    try {
      const gatewayConfigPath = join(process.cwd(), 'mini-services', 'llm-gateway', 'config.json')
      const useProxy = config.provider !== 'zai' && !!config.apiKey && !!config.baseUrl && config.provider !== ''
      writeFileSync(
        gatewayConfigPath,
        JSON.stringify(
          {
            mode: useProxy ? 'proxy' : 'zai',
            provider: config.provider || 'zai',
            apiKey: config.apiKey || '',
            baseUrl: config.baseUrl || '',
            model: config.model || '',
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      )
    } catch (e) {
      // Gateway sync is best-effort — never fail the save because of it.
      console.error('Failed to sync llm-gateway config:', e)
    }

    // Respond with the same masked shape as GET so a save→reopen cycle
    // never leaks the full key either.
    return NextResponse.json({
      id: config.id,
      provider: config.provider,
      apiKey: maskApiKey(config.apiKey),
      hasApiKey: !!config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      updatedAt: config.updatedAt,
    })
  } catch (error) {
    console.error('Failed to update LLM config:', error)
    return NextResponse.json({ error: 'Failed to update LLM config' }, { status: 500 })
  }
}

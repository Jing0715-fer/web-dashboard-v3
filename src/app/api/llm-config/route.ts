import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { publicCatalog } from '@/lib/llm-providers'

export async function GET() {
  try {
    let config = await db.llmConfig.findUnique({ where: { id: 'default' } })

    if (!config) {
      // Create default config if it doesn't exist
      config = await db.llmConfig.create({ data: { id: 'default' } })
    }

    // Include the provider catalog so the settings dialog can render the
    // selector without a second round-trip.
    return NextResponse.json({ ...config, catalog: publicCatalog() })
  } catch (error) {
    console.error('Failed to fetch LLM config:', error)
    return NextResponse.json({ error: 'Failed to fetch LLM config' }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json()
    const { provider, apiKey, baseUrl, model } = body

    const config = await db.llmConfig.upsert({
      where: { id: 'default' },
      update: {
        ...(provider !== undefined && { provider }),
        ...(apiKey !== undefined && { apiKey }),
        ...(baseUrl !== undefined && { baseUrl }),
        ...(model !== undefined && { model }),
      },
      create: {
        id: 'default',
        provider: provider || '',
        apiKey: apiKey || '',
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

    return NextResponse.json(config)
  } catch (error) {
    console.error('Failed to update LLM config:', error)
    return NextResponse.json({ error: 'Failed to update LLM config' }, { status: 500 })
  }
}

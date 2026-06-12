import { db } from '@/lib/db'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const config = await db.llmConfig.findUnique({ where: { id: 'default' } })

    if (!config) {
      // Create default config if it doesn't exist
      const newConfig = await db.llmConfig.create({ data: { id: 'default' } })
      return NextResponse.json(newConfig)
    }

    return NextResponse.json(config)
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

    return NextResponse.json(config)
  } catch (error) {
    console.error('Failed to update LLM config:', error)
    return NextResponse.json({ error: 'Failed to update LLM config' }, { status: 500 })
  }
}

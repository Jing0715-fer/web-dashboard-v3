import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import crypto from 'crypto'

export async function GET() {
  try {
    const devices = await db.device.findMany({
      include: {
        _count: {
          select: { projects: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    const result = devices.map(({ _count, ...device }) => ({
      ...device,
      projectCount: _count.projects,
    }))

    return NextResponse.json(result)
  } catch (error) {
    console.error('Failed to list devices:', error)
    return NextResponse.json(
      { error: 'Failed to list devices' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { name, ip, port, apiKey } = body

    if (!name || !ip) {
      return NextResponse.json(
        { error: 'name and ip are required' },
        { status: 400 }
      )
    }

    const device = await db.device.create({
      data: {
        name,
        ip,
        port: port ?? 3100,
        apiKey: apiKey || crypto.randomBytes(32).toString('hex'),
      },
    })

    return NextResponse.json(device, { status: 201 })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return NextResponse.json(
        { error: 'A device with this API key already exists' },
        { status: 409 }
      )
    }
    console.error('Failed to create device:', error)
    return NextResponse.json(
      { error: 'Failed to create device' },
      { status: 500 }
    )
  }
}

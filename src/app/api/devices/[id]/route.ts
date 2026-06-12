import { db } from '@/lib/db'
import { NextResponse } from 'next/server'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const device = await db.device.findUnique({
      where: { id },
      include: { projects: true },
    })

    if (!device) {
      return NextResponse.json(
        { error: 'Device not found' },
        { status: 404 }
      )
    }

    return NextResponse.json(device)
  } catch (error) {
    console.error('Failed to get device:', error)
    return NextResponse.json(
      { error: 'Failed to get device' },
      { status: 500 }
    )
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()

    const existing = await db.device.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json(
        { error: 'Device not found' },
        { status: 404 }
      )
    }

    const data: Record<string, unknown> = {}
    if (body.name !== undefined) data.name = body.name
    if (body.ip !== undefined) data.ip = body.ip
    if (body.port !== undefined) data.port = body.port
    if (body.apiKey !== undefined) data.apiKey = body.apiKey
    if (body.status !== undefined) data.status = body.status

    const device = await db.device.update({
      where: { id },
      data,
    })

    return NextResponse.json(device)
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return NextResponse.json(
        { error: 'A device with this API key already exists' },
        { status: 409 }
      )
    }
    console.error('Failed to update device:', error)
    return NextResponse.json(
      { error: 'Failed to update device' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const existing = await db.device.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json(
        { error: 'Device not found' },
        { status: 404 }
      )
    }

    await db.device.delete({ where: { id } })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to delete device:', error)
    return NextResponse.json(
      { error: 'Failed to delete device' },
      { status: 500 }
    )
  }
}

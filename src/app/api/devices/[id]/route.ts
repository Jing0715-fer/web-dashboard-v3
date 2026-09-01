import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { invalidateRemoteProjectCache } from '@/lib/remote-sync'
import { requireApprovedUser } from '@/lib/auth';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(_request);
  if (authGuard.error) return authGuard.error;
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
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(request);
  if (authGuard.error) return authGuard.error;
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
    if (body.port !== undefined) {
      // Validate the agent port — reject strings/NaN/out-of-range before Prisma
      const portNum = Number(body.port)
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        return NextResponse.json(
          { error: `Invalid port: ${body.port} (must be an integer between 1 and 65535)` },
          { status: 400 }
        )
      }
      data.port = portNum
    }
    if (body.apiKey !== undefined) data.apiKey = body.apiKey
    if (body.status !== undefined) {
      // Only allow the two known statuses
      data.status = body.status === 'online' ? 'online' : 'offline'
    }

    const device = await db.device.update({
      where: { id },
      data,
    })

    // Connection details may have changed — force a real re-sync next time.
    invalidateRemoteProjectCache()

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
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(_request);
  if (authGuard.error) return authGuard.error;
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

    // The cache still holds this device's projects — drop it so the next
    // list GET doesn't serve projects of a device that no longer exists.
    invalidateRemoteProjectCache()

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to delete device:', error)
    return NextResponse.json(
      { error: 'Failed to delete device' },
      { status: 500 }
    )
  }
}

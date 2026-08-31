import { db } from '@/lib/db'
import { NextResponse } from 'next/server'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const device = await db.device.findUnique({ where: { id } })
    if (!device) {
      return NextResponse.json(
        { error: 'Device not found' },
        { status: 404 }
      )
    }

    const healthUrl = `http://${device.ip}:${device.port}/api/agent/health`
    let healthStatus: 'online' | 'offline' = 'offline'
    let healthData: Record<string, unknown> | null = null

    try {
      const response = await fetch(healthUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${device.apiKey}`,
        },
        signal: AbortSignal.timeout(5000),
      })

      if (response.ok) {
        healthStatus = 'online'
        try {
          healthData = await response.json()
        } catch {
          healthData = null
        }
      }
    } catch {
      healthStatus = 'offline'
    }

    const updatedDevice = await db.device.update({
      where: { id },
      data: {
        status: healthStatus,
        lastSeen: healthStatus === 'online' ? new Date() : undefined,
      },
    })

    return NextResponse.json({
      status: healthStatus,
      lastSeen: updatedDevice.lastSeen,
      health: healthData,
    })
  } catch (error) {
    console.error('Failed to check device health:', error)
    return NextResponse.json(
      { error: 'Failed to check device health' },
      { status: 500 }
    )
  }
}

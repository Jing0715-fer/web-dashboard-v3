import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { requireApprovedUser } from '@/lib/auth'
import { logActivity } from '@/lib/activity'

/**
 * Device health check — with self-healing.
 *
 * The DB row is the source of truth for WHERE the agent lives, but addresses
 * drift: the agent may have been restarted on a neighbouring port (started
 * manually with --port, start.sh picked the next free one) or its host
 * changed network. A dead row would show the device offline forever
 * (user report: dev-laptop-2 row said 192.168.253.1:3100 while the agent
 * actually listened on :3101).
 *
 * Strategy:
 *   1. probe the recorded ip:port — healthy → done (no extra work).
 *   2. dead → sweep the usual agent ports (device's own + 3100-3105) in
 *      parallel. A live port is only adopted after a Bearer-authenticated
 *      call succeeds with the device's stored key (so we never adopt
 *      someone else's agent), and the DB row is corrected in place.
 *   3. still dead → offline.
 */
const PORT_SWEEP = [3100, 3101, 3102, 3103, 3104, 3105]

async function probeAgentHealth(ip: string, port: number, timeoutMs = 2500): Promise<Record<string, unknown> | null> {
  try {
    // /api/agent/health is intentionally unauthenticated (liveness probe).
    const res = await fetch(`http://${ip}:${port}/api/agent/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

/** Adopting a discovered port requires proving it is OUR agent: a
 *  Bearer-authenticated endpoint must accept the device's stored key. */
async function verifyAgentKey(ip: string, port: number, apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${ip}:${port}/api/agent/projects`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(_request);
  if (authGuard.error) return authGuard.error;
  try {
    const { id } = await params

    const device = await db.device.findUnique({ where: { id } })
    if (!device) {
      return NextResponse.json(
        { error: 'Device not found' },
        { status: 404 }
      )
    }

    // 1. Recorded address first — the common healthy case costs ONE probe.
    let healthData = await probeAgentHealth(device.ip, device.port)
    let livePort = device.port
    let corrected = false

    // 2. Dead → sweep neighbouring ports on the same IP.
    if (!healthData) {
      const scanPorts = [...new Set([...PORT_SWEEP, device.port])].filter((p) => p !== device.port)
      const alive = await Promise.all(
        scanPorts.map(async (p) => ((await probeAgentHealth(device.ip, p)) ? p : null)),
      )
      const found = alive.find((p) => p != null) ?? null
      if (found != null && (await verifyAgentKey(device.ip, found, device.apiKey))) {
        livePort = found
        corrected = true
        healthData = await probeAgentHealth(device.ip, livePort)
      }
    }

    const healthStatus: 'online' | 'offline' = healthData ? 'online' : 'offline'

    const updatedDevice = await db.device.update({
      where: { id },
      data: {
        status: healthStatus,
        ...(corrected ? { port: livePort } : {}),
        lastSeen: healthStatus === 'online' ? new Date() : undefined,
      },
    })

    if (corrected) {
      logActivity({
        type: 'pair',
        level: 'success',
        message: `Device '${device.name}' port self-healed`,
        deviceId: device.id,
        deviceName: device.name,
        detail: `${device.ip}:${device.port} → ${device.ip}:${livePort}`,
      })
    }

    return NextResponse.json({
      status: healthStatus,
      lastSeen: updatedDevice.lastSeen,
      health: healthData,
      ...(corrected ? { correctedPort: livePort, previousPort: device.port } : {}),
    })
  } catch (error) {
    console.error('Failed to check device health:', error)
    return NextResponse.json(
      { error: 'Failed to check device health' },
      { status: 500 }
    )
  }
}

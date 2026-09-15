import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { requireApprovedUser } from '@/lib/auth'
import { logActivity } from '@/lib/activity'

/**
 * Restart the AGENT process on a remote device (dashboard button).
 *
 * Why this exists: a `git pull` on a machine hot-reloads the dashboard it
 * runs, but NOT the already-spawned agent process. The stale-agent class of
 * symptoms (pull "too old", one-way project visibility, missing repoUrl
 * sync) all require a manual restart on that machine — until now. The
 * v1.13 agent exposes POST /api/agent/restart which respawns itself with
 * the same argv/port; this route forwards the request with the device's
 * stored API key.
 *
 * Contract:
 *   200 → restart command accepted (agent exits ~1s later, replacement
 *         re-binds the same port ~2-3s after that)
 *   409 → agent is reachable but predates the restart endpoint (needs
 *         `git pull` + restart ON THAT MACHINE, one last time)
 *   502 → agent unreachable (offline / firewalled inbound)
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authGuard = await requireApprovedUser(_request);
  if (authGuard.error) return authGuard.error;
  try {
    const { id } = await params

    const device = await db.device.findUnique({ where: { id } })
    if (!device) {
      return NextResponse.json({ error: 'Device not found' }, { status: 404 })
    }

    let res: Response
    try {
      res = await fetch(`http://${device.ip}:${device.port}/api/agent/restart`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${device.apiKey}`,
          'Content-Type': 'application/json',
        },
        // The agent responds immediately, then exits ~800ms later. A short
        // timeout keeps the UI snappy when the host is half-dead.
        signal: AbortSignal.timeout(6000),
      })
    } catch {
      logActivity({
        type: 'pair',
        level: 'warning',
        message: `Agent restart failed — '${device.name}' unreachable`,
        deviceId: device.id,
        deviceName: device.name,
        detail: `${device.ip}:${device.port} did not answer`,
      })
      return NextResponse.json(
        { error: `Agent at ${device.ip}:${device.port} is unreachable (device offline or firewalled)` },
        { status: 502 }
      )
    }

    if (res.status === 404) {
      return NextResponse.json(
        {
          error:
            'This agent predates the restart endpoint (v1.13). Fix it ON THAT MACHINE once: git pull, then restart the agent — after that, restarts work remotely.',
        },
        { status: 409 }
      )
    }
    if (res.status === 401) {
      return NextResponse.json(
        { error: 'Agent rejected the stored API key — re-pair the device (delete + re-add) to fix credentials.' },
        { status: 409 }
      )
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return NextResponse.json(
        { error: `Agent restart failed (${res.status}): ${detail.slice(0, 200)}` },
        { status: 502 }
      )
    }

    logActivity({
      type: 'pair',
      level: 'success',
      message: `Agent restart triggered on '${device.name}'`,
      deviceId: device.id,
      deviceName: device.name,
      detail: 'Remote respawn requested from the device panel',
    })

    return NextResponse.json({ ok: true, action: 'restarting' })
  } catch (error) {
    console.error('Failed to restart agent:', error)
    return NextResponse.json({ error: 'Failed to restart agent' }, { status: 500 })
  }
}

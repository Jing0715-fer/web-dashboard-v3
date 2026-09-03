import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { localAgentApiKeys, isSelfDeviceRow, invalidateRemoteProjectCache, getDevicePush } from '@/lib/remote-sync'
import { requireApprovedUser } from '@/lib/auth';

export async function GET(req: Request) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const devices = await db.device.findMany({
      include: {
        _count: {
          select: { projects: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    // Hide SELF device rows (this machine's own agent registered as a
    // "device", typically from an early CLI self-pair). They can never carry
    // remote projects (the sync skips them by the same key set) so they only
    // produce a confusing "own machine / 0 projects / Unreachable" card —
    // the local agent's real status lives in the join dialog's Local Agent
    // panel instead. The row itself is kept in the DB: it still anchors the
    // self-mirror heal in remote-sync.
    // "Self" = key match AND a local address (isSelfDeviceRow) — a peer
    // whose key merely collides with ours (repo-committed shared identity)
    // must stay visible, otherwise paired machines vanish from each
    // other's lists.
    const localKeys = localAgentApiKeys()

    const result = devices
      .filter((d) => !isSelfDeviceRow(d, localKeys))
      .map(({ _count, ...device }) => ({
        ...device,
        projectCount: _count.projects,
        // Heartbeat-push state: a device whose direct agent connection is
        // firewalled off still pushes its project list every 60s — the UI
        // shows a "push mode" badge and contextual messages from this.
        pushedAt: getDevicePush(device.id)?.at ?? null,
        pushProjectCount: getDevicePush(device.id)?.projects?.length ?? 0,
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
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(request);
  if (authGuard.error) return authGuard.error;
  try {
    const body = await request.json()
    const { name, ip, port, apiKey } = body

    if (!name || !ip) {
      return NextResponse.json(
        { error: 'name and ip are required' },
        { status: 400 }
      )
    }

    // Validate the agent port — reject strings/NaN/out-of-range before Prisma
    const portNum = Number(port ?? 3100)
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return NextResponse.json(
        { error: `Invalid port: ${port} (must be an integer between 1 and 65535)` },
        { status: 400 }
      )
    }

    const device = await db.device.create({
      data: {
        name,
        ip,
        port: portNum,
        apiKey: apiKey || crypto.randomBytes(32).toString('hex'),
      },
    })

    // New device — drop the sync cache so its projects are fetched on the
    // next list GET instead of being served from the pre-add snapshot.
    invalidateRemoteProjectCache()

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

import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { localAgentApiKeys, isSelfDeviceRow, invalidateRemoteProjectCache, getDevicePush, getAgentMeta } from '@/lib/remote-sync'
import { probeRemoteAgentHealth } from '@/lib/agent-health'
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

    // Agent version + outdated evidence for every device (60s-cached health
    // probes, run in parallel). This is what makes a stale agent VISIBLE:
    // machines that pulled new code but never restarted their agent process
    // otherwise just show up as confusing symptoms (pull 'too old', one-way
    // project visibility, immediate exits).
    const visible = devices.filter((d) => !isSelfDeviceRow(d, localKeys))
    const healths = await Promise.all(
      visible.map((d) => probeRemoteAgentHealth({ id: d.id, ip: d.ip, port: d.port }))
    )
    const healthById = new Map(healths.map((h, i) => [visible[i].id, h]))

    const result = visible
      .map((device) => {
        const health = healthById.get(device.id)
        const { _count, ...rest } = device
        return {
          ...rest,
          projectCount: _count.projects,
          // Heartbeat-push state: a device whose direct agent connection is
          // firewalled off still pushes its project list every 60s — the UI
          // shows a "push mode" badge and contextual messages from this.
          pushedAt: getDevicePush(device.id)?.at ?? null,
          pushProjectCount: getDevicePush(device.id)?.projects?.length ?? 0,
          // Running agent version + outdated evidence (null when the probe
          // couldn't positively identify the agent, e.g. firewalled).
          agentVersion: health?.version || null,
          agentOutdated: health?.outdated ?? false,
          agentWhy: health?.why || '',
          // Co-located dashboard DB found by the agent (v1.12)? Two sources,
          // best one wins: the direct health probe (firewall permitting) or
          // the agent's own heartbeat report (works on one-way networks).
          // null = unknown (pre-1.12 agent / no data) — NEVER shown as false.
          agentDashboardDb:
            (typeof health?.dashboardDb === 'boolean'
              ? health.dashboardDb
              : undefined) ?? getAgentMeta(device.id)?.dashboardDbFound ?? null,
          agentDashboardDbPath:
            getAgentMeta(device.id)?.dashboardDbPath ?? null,
        }
      })

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

    // Duplicate-address guard: a Device row already exists at this ip:port.
    // Creating a twin would produce TWO rows for one machine — each stuck
    // with its own key, the agent's heartbeat only ever matching one of
    // them, the other drifting to "offline / 0 projects" forever (user
    // report: two same-address rows at 3101, both showing 0). When the
    // caller supplies the agent's REAL key this becomes the repair path
    // (heal a row whose stored key died with a reinstall); without a key
    // it's a hard 409 naming the existing device.
    const existing = await db.device.findFirst({
      where: { ip: String(ip), port: portNum },
    });
    if (existing) {
      if (apiKey) {
        const repaired = await db.device.update({
          where: { id: existing.id },
          data: { name: String(name), port: portNum, apiKey: String(apiKey) },
        });
        // The repaired row may now authenticate — drop the sync cache so the
        // next list GET re-pulls its projects instead of serving the stale
        // "0 projects" snapshot.
        invalidateRemoteProjectCache();
        return NextResponse.json(repaired, { status: 200 });
      }
      return NextResponse.json(
        {
          error: `该地址已存在设备「${existing.name}」(${existing.ip}:${existing.port}) — 请编辑该设备，或填入正确的 agent apiKey 以修复其连接`,
          deviceId: existing.id,
        },
        { status: 409 },
      );
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

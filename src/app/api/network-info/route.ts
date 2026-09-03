import { NextResponse } from 'next/server'
import os from 'os'
import { requireApprovedUser } from '@/lib/auth';
import { lanIpCandidatesDetailed } from '@/lib/agent-lifecycle';

export async function GET(req: Request) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const networkInterfaces = os.networkInterfaces()
    const ips: Array<{ interface: string; address: string; family: string }> = []

    for (const [name, interfaces] of Object.entries(networkInterfaces)) {
      if (!interfaces) continue
      for (const iface of interfaces) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ips.push({
            interface: name,
            address: iface.address,
            family: iface.family,
          })
        }
      }
    }

    // Also include internal/loopback for reference
    for (const [name, interfaces] of Object.entries(networkInterfaces)) {
      if (!interfaces) continue
      for (const iface of interfaces) {
        if (iface.family === 'IPv4' && iface.internal) {
          ips.push({
            interface: name,
            address: iface.address,
            family: iface.family,
          })
        }
      }
    }

    // Gateway-subnet-aware ranking (virtual adapters like VMware VMnet
    // 192.168.253.x demoted — user report: the pairing dialog advertised the
    // VMware address instead of the WLAN one, so peers could never connect).
    // `ip` in each entry marks whether it is the machine's best guess.
    const ranked = lanIpCandidatesDetailed()
    const best = ranked[0]?.address || ''

    const info = {
      hostname: os.hostname(),
      bestIp: best,
      ips,
      rankedIps: ranked.map((c) => ({ address: c.address, interface: c.interface })),
      platform: os.platform(),
      arch: os.arch(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      cpus: os.cpus().length,
      uptime: os.uptime(),
    }

    return NextResponse.json(info)
  } catch (error) {
    console.error('Failed to fetch network info:', error)
    return NextResponse.json({ error: 'Failed to fetch network info' }, { status: 500 })
  }
}

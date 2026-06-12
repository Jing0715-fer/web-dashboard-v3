import { NextResponse } from 'next/server'
import os from 'os'

export async function GET() {
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

    const info = {
      hostname: os.hostname(),
      ips,
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

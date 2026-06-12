import { NextResponse } from 'next/server'
import os from 'os'

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  parts.push(`${minutes}m`)

  return parts.join(' ')
}

export async function GET() {
  try {
    // Real system data
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = totalMem - freeMem
    const memPercentage = Math.round((usedMem / totalMem) * 100)

    const cpus = os.cpus()
    const cpuCount = cpus.length
    // Calculate average CPU usage from load averages (1-min)
    const loadAvg = os.loadavg()
    // loadAvg[0] is 1-min average; convert to percentage (per core)
    const cpuPercentage = Math.min(100, Math.round((loadAvg[0] / cpuCount) * 100))

    const uptimeSeconds = Math.floor(os.uptime())

    // Get process memory (this Next.js process)
    const procMem = process.memoryUsage()
    const procMemMB = Math.round(procMem.rss / 1024 / 1024)

    const status = {
      caddyRunning: true,
      caddyVersion: '2.8.4',
      gatewayPort: 3000,
      gatewayListening: true,
      configValid: true,
      uptime: formatUptime(uptimeSeconds),
      uptimeSeconds,
      systemUptime: formatUptime(uptimeSeconds),
      systemUptimeSeconds: uptimeSeconds,
      memoryUsage: {
        total: Math.round(totalMem / 1024 / 1024),       // MB
        used: Math.round(usedMem / 1024 / 1024),          // MB
        free: Math.round(freeMem / 1024 / 1024),          // MB
        percentage: memPercentage,
      },
      cpuUsage: {
        percentage: cpuPercentage,
        cores: cpuCount,
        loadAverage: loadAvg.map((v) => Math.round(v * 100) / 100),
      },
      processMemory: {
        rss: procMemMB,
        heapUsed: Math.round(procMem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(procMem.heapTotal / 1024 / 1024),
      },
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      lastChecked: new Date().toISOString(),
    }

    return NextResponse.json(status)
  } catch (error) {
    console.error('Failed to fetch gateway status:', error)
    return NextResponse.json({ error: 'Failed to fetch gateway status' }, { status: 500 })
  }
}

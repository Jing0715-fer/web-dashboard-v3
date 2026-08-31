import { NextRequest, NextResponse } from 'next/server'
import os from 'os'
import { execSync } from 'child_process'

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

function getDiskUsage(): { total: number; used: number; free: number; percentage: number } {
  try {
    let output: string
    if (process.platform === 'win32') {
      // Get the drive of the working directory
      const drive = process.cwd().slice(0, 2)
      output = execSync(
        `wmic logicaldisk where "DeviceID='${drive}'" get Size,FreeSpace /value 2>nul`,
        { encoding: 'utf-8', timeout: 5000 }
      )
      const freeMatch = output.match(/FreeSpace=(\d+)/)
      const sizeMatch = output.match(/Size=(\d+)/)
      const total = sizeMatch ? parseInt(sizeMatch[1], 10) : 0
      const free = freeMatch ? parseInt(freeMatch[1], 10) : 0
      const used = total - free
      return {
        total: Math.round(total / 1024 / 1024),
        used: Math.round(used / 1024 / 1024),
        free: Math.round(free / 1024 / 1024),
        percentage: total > 0 ? Math.round((used / total) * 100) : 0,
      }
    } else {
      // macOS / Linux: use df on the cwd
      output = execSync(`df -k "${process.cwd()}" | tail -1`, { encoding: 'utf-8', timeout: 5000 })
      const parts = output.trim().split(/\s+/)
      // Filesystem 1024-blocks Used Available Capacity Mounted
      const totalKB = parseInt(parts[1], 10) || 0
      const usedKB = parseInt(parts[2], 10) || 0
      const freeKB = parseInt(parts[3], 10) || 0
      return {
        total: Math.round(totalKB / 1024),
        used: Math.round(usedKB / 1024),
        free: Math.round(freeKB / 1024),
        percentage: totalKB > 0 ? Math.round((usedKB / totalKB) * 100) : 0,
      }
    }
  } catch {
    return { total: 0, used: 0, free: 0, percentage: 0 }
  }
}

export async function GET(_req: NextRequest) {
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

    const diskUsage = getDiskUsage()

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
      diskUsage,
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

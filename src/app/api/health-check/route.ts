import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const portsParam = searchParams.get('ports')

    if (!portsParam) {
      return NextResponse.json({ error: 'Ports query parameter is required' }, { status: 400 })
    }

    const ports = portsParam.split(',').map((p) => parseInt(p.trim(), 10)).filter((p) => !isNaN(p))

    if (ports.length === 0) {
      return NextResponse.json({ error: 'No valid ports provided' }, { status: 400 })
    }

    const results = ports.map((port) => {
      // Mock health check - simulate some ports as healthy and some as unhealthy
      const isCommonPort = [80, 443, 3000, 3001, 3002, 8080, 5432, 6379].includes(port)
      const isHealthy = isCommonPort ? Math.random() > 0.1 : Math.random() > 0.5

      return {
        port,
        status: isHealthy ? 'healthy' : 'unhealthy',
        responseTime: Math.floor(Math.random() * 200) + 1,
        lastChecked: new Date().toISOString(),
        details: isHealthy
          ? 'Service responding normally'
          : 'Connection refused or timeout',
      }
    })

    const overallStatus = results.every((r) => r.status === 'healthy')
      ? 'healthy'
      : results.some((r) => r.status === 'healthy')
        ? 'degraded'
        : 'unhealthy'

    return NextResponse.json({
      overallStatus,
      checkedAt: new Date().toISOString(),
      results,
    })
  } catch (error) {
    console.error('Failed to perform health check:', error)
    return NextResponse.json({ error: 'Failed to perform health check' }, { status: 500 })
  }
}

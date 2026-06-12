import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { isRemoteProject, proxyProjectAction } from '@/lib/route-decision'

const LOG_LEVELS = ['info', 'warn', 'error', 'debug'] as const
const LOG_SOURCES = ['server', 'build', 'runtime', 'network', 'database', 'auth', 'api'] as const

const LOG_MESSAGES: Record<string, string[]> = {
  server: [
    'Server started on port 3000',
    'Hot reload triggered',
    'Request processed in 45ms',
    'WebSocket connection established',
    'Graceful shutdown initiated',
    'Worker process spawned',
    'Memory usage: 128MB / 512MB',
    'Health check passed',
  ],
  build: [
    'Compiling /src/app/page.tsx',
    'Build completed in 2.3s',
    'Bundle size: 245KB (gzipped: 78KB)',
    'Generating static pages (5/5)',
    'TypeScript compilation successful',
    'Build optimization complete',
    'Asset optimization: 12 files processed',
  ],
  runtime: [
    'API route /api/projects executed in 23ms',
    'Cache hit for key: project-list',
    'Cache miss for key: user-session',
    'Database query completed in 5ms',
    'Rate limit reached for IP 192.168.1.100',
    'Session expired, refreshing token',
  ],
  network: [
    'DNS lookup: api.example.com → 104.21.32.1',
    'TLS handshake completed',
    'Connection timeout to upstream server',
    'Retry attempt 2/3 for failed request',
    'Load balancer health check: OK',
  ],
  database: [
    'Connection pool: 8/20 active connections',
    'Migration applied: add_tags_column',
    'Query optimization: index created on projects.path',
    'Backup completed: 2.4MB',
    'Slow query detected (450ms): SELECT * FROM projects',
  ],
  auth: [
    'User authenticated: admin@example.com',
    'Token refresh successful',
    'Failed login attempt from 10.0.0.5',
    'Session created for user_id: usr_123',
    'Permission denied: insufficient role',
  ],
  api: [
    'GET /api/projects → 200 (12ms)',
    'POST /api/projects → 201 (34ms)',
    'PUT /api/projects/abc → 200 (28ms)',
    'DELETE /api/projects/abc → 200 (15ms)',
    'Rate limit: 45/100 requests used',
  ],
}

function generateLogs(projectId: string) {
  const logs = []
  const now = Date.now()

  for (let i = 0; i < 30; i++) {
    const source = LOG_SOURCES[Math.floor(Math.random() * LOG_SOURCES.length)]
    const messages = LOG_MESSAGES[source]
    const message = messages[Math.floor(Math.random() * messages.length)]
    const level = LOG_LEVELS[Math.floor(Math.random() * LOG_LEVELS.length)]

    logs.push({
      id: `log_${projectId}_${i}`,
      timestamp: new Date(now - i * 15000 - Math.random() * 10000).toISOString(),
      level,
      source,
      message,
      projectId,
    })
  }

  return logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const project = await db.project.findUnique({
      where: { id },
      include: { device: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Remote project → proxy to agent
    if (isRemoteProject(project)) {
      const result = await proxyProjectAction(
        project.deviceId!,
        `/projects/${id}/logs`,
        'GET'
      );
      return NextResponse.json(result.data, { status: result.status });
    }

    const logs = generateLogs(id)
    return NextResponse.json(logs)
  } catch (error) {
    console.error('Failed to fetch logs:', error)
    return NextResponse.json({ error: 'Failed to fetch logs' }, { status: 500 })
  }
}

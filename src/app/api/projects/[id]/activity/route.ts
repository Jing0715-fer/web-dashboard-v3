import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { isRemoteProject, proxyProjectAction } from '@/lib/route-decision'

type ActivityType = 'deploy' | 'start' | 'stop' | 'restart' | 'rebuild' | 'config_change' | 'error' | 'create'

interface ActivityEvent {
  id: string
  type: ActivityType
  message: string
  timestamp: string
  projectId: string
  metadata?: Record<string, unknown>
}

const ACTIVITY_MESSAGES: Record<ActivityType, string[]> = {
  deploy: [
    'Deployed to production successfully',
    'Deployment v2.3.1 rolled out to all instances',
    'Blue-green deployment completed',
    'Canary deployment at 50% traffic',
  ],
  start: [
    'Environment development started',
    'Environment production started on port 3002',
    'Dev server started successfully',
    'Service started with PID 12345',
  ],
  stop: [
    'Environment development stopped',
    'Graceful shutdown completed',
    'Service stopped by user request',
    'Process terminated after timeout',
  ],
  restart: [
    'Environment development restarted',
    'Service restarted due to config change',
    'Rolling restart of production instances',
    'Hot reload triggered restart',
  ],
  rebuild: [
    'Environment production rebuilt from scratch',
    'Build cache cleared and rebuild initiated',
    'Full rebuild completed in 45s',
    'Incremental build completed in 12s',
  ],
  config_change: [
    'Environment variable PORT updated from 3000 to 8080',
    'New environment variable API_KEY added',
    'Port mapping changed: 3000 → 3001',
    'Configuration file .env updated',
    'Resource limits adjusted: memory 512MB → 1GB',
  ],
  error: [
    'Port 3000 already in use, environment failed to start',
    'Build failed: TypeScript compilation error',
    'Out of memory error during build',
    'Connection refused to database server',
    'Health check failed: endpoint returned 503',
  ],
  create: [
    'New environment staging created',
    'Project initialized with default configuration',
    'New service worker added',
    'Environment cloned from production',
  ],
}

const ACTIVITY_METADATA: Record<ActivityType, Record<string, unknown>> = {
  deploy: { version: '2.3.1', strategy: 'rolling' },
  start: { duration: '2.3s' },
  stop: { graceful: true },
  restart: { reason: 'config_change' },
  rebuild: { buildTime: '45s', cacheCleared: true },
  config_change: { field: 'PORT', oldValue: 3000, newValue: 8080 },
  error: { exitCode: 1, retryable: true },
  create: { template: 'default' },
}

function generateActivityEvents(projectId: string): ActivityEvent[] {
  const types: ActivityType[] = ['deploy', 'start', 'stop', 'restart', 'rebuild', 'config_change', 'error', 'create']
  const events: ActivityEvent[] = []
  const now = Date.now()

  // Generate 12-15 events
  const count = 12 + Math.floor(Math.random() * 4)

  for (let i = 0; i < count; i++) {
    const type = types[Math.floor(Math.random() * types.length)]
    const messages = ACTIVITY_MESSAGES[type]
    const message = messages[Math.floor(Math.random() * messages.length)]
    const metadata = { ...ACTIVITY_METADATA[type] }

    // Add some randomness to metadata
    if (type === 'deploy') {
      metadata.version = `2.${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 20)}`
    }

    events.push({
      id: `activity_${projectId}_${i}`,
      type,
      message,
      timestamp: new Date(now - i * 1800000 - Math.random() * 600000).toISOString(),
      projectId,
      metadata,
    })
  }

  return events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
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
        `/projects/${id}/activity`,
        'GET'
      );
      return NextResponse.json(result.data, { status: result.status });
    }

    const events = generateActivityEvents(id)
    return NextResponse.json(events)
  } catch (error) {
    console.error('Failed to fetch activity:', error)
    return NextResponse.json({ error: 'Failed to fetch activity' }, { status: 500 })
  }
}

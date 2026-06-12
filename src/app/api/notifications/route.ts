import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

type NotificationType = 'success' | 'warning' | 'error' | 'info'

interface Notification {
  id: string
  type: NotificationType
  title: string
  message: string
  timestamp: string
  read: boolean
  projectId?: string
  projectName?: string
}

function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function generateNotifications(
  projects: Awaited<ReturnType<typeof db.project.findMany>>
): Notification[] {
  const notifications: Notification[] = []
  let idCounter = 0

  const now = Date.now()

  // Track which projects already have notifications to avoid duplicates
  const usedProjectIds = new Set<string>()

  // Generate project-based notifications
  for (const project of projects) {
    const envs = project.environments
    const runningEnvs = envs.filter((e) => e.status === 'running')
    const stoppedEnvs = envs.filter((e) => e.status === 'stopped')
    const hasRunning = runningEnvs.length > 0
    const hasStopped = stoppedEnvs.length > 0

    // For running environments: add success notification
    if (hasRunning && notifications.length < 10) {
      const env = randomElement(runningEnvs)
      const templates = [
        {
          type: 'success' as NotificationType,
          title: 'Environment Running',
          message: `${env.name} environment for ${project.name} is running on port ${env.port}.${env.pid ? ` PID: ${env.pid}` : ''}`,
        },
        {
          type: 'success' as NotificationType,
          title: 'Deployment Successful',
          message: `${project.name} deployed to ${env.name} successfully. All health checks passing on port ${env.port}.`,
        },
        {
          type: 'info' as NotificationType,
          title: 'Service Healthy',
          message: `${env.name} environment for ${project.name} is responding normally. Uptime: ${Math.floor(Math.random() * 72 + 1)} hours.`,
        },
      ]
      const template = randomElement(templates)
      notifications.push({
        id: `notif_${++idCounter}`,
        type: template.type,
        title: template.title,
        message: template.message,
        timestamp: new Date(
          now - Math.floor(Math.random() * 3600000)
        ).toISOString(),
        read: Math.random() > 0.6,
        projectId: project.id,
        projectName: project.name,
      })
      usedProjectIds.add(project.id)
    }

    // For stopped environments: add warning/error notification
    if (hasStopped && notifications.length < 10) {
      const env = randomElement(stoppedEnvs)
      const isBuildFailure = Math.random() > 0.5
      if (isBuildFailure) {
        notifications.push({
          id: `notif_${++idCounter}`,
          type: 'error',
          title: 'Build Failed',
          message: `Build process for ${project.name} (${env.name}) failed. ${randomElement(['TypeScript compilation error in module imports.', 'Webpack bundling failed with exit code 1.', 'Dependency resolution error: package not found.', 'Syntax error in configuration file.'])}`,
          timestamp: new Date(
            now - Math.floor(Math.random() * 7200000 + 1800000)
          ).toISOString(),
          read: Math.random() > 0.5,
          projectId: project.id,
          projectName: project.name,
        })
      } else {
        const templates = [
          {
            type: 'warning' as NotificationType,
            title: 'Environment Stopped',
            message: `${env.name} environment for ${project.name} is currently stopped. Port ${env.port} is available.`,
          },
          {
            type: 'warning' as NotificationType,
            title: 'High Memory Usage',
            message: `${project.name} ${env.name} environment is using ${Math.floor(Math.random() * 30 + 70)}% of allocated memory. Consider scaling resources.`,
          },
        ]
        const template = randomElement(templates)
        notifications.push({
          id: `notif_${++idCounter}`,
          type: template.type,
          title: template.title,
          message: template.message,
          timestamp: new Date(
            now - Math.floor(Math.random() * 7200000 + 1800000)
          ).toISOString(),
          read: Math.random() > 0.5,
          projectId: project.id,
          projectName: project.name,
        })
      }
      usedProjectIds.add(project.id)
    }

    // Occasionally add a config change or restart notification
    if (Math.random() > 0.6 && notifications.length < 10) {
      const templates = [
        {
          type: 'info' as NotificationType,
          title: 'Configuration Updated',
          message: `Environment variables for ${project.name} ${randomElement(envs).name} have been updated. Restart may be required.`,
        },
        {
          type: 'success' as NotificationType,
          title: 'Rebuild Complete',
          message: `Environment rebuild for ${project.name} completed successfully. All services restored.`,
        },
      ]
      const template = randomElement(templates)
      notifications.push({
        id: `notif_${++idCounter}`,
        type: template.type,
        title: template.title,
        message: template.message,
        timestamp: new Date(
          now - Math.floor(Math.random() * 14400000 + 3600000)
        ).toISOString(),
        read: Math.random() > 0.4,
        projectId: project.id,
        projectName: project.name,
      })
    }
  }

  // Add general system notifications
  const systemNotifications: Notification[] = [
    {
      id: `notif_${++idCounter}`,
      type: 'info',
      title: 'Gateway Configuration Updated',
      message:
        'Caddy gateway configuration has been reloaded. All routes are active and healthy.',
      timestamp: new Date(now - 3600000).toISOString(),
      read: true,
    },
    {
      id: `notif_${++idCounter}`,
      type: 'warning',
      title: 'SSL Certificate Expiring',
      message:
        'SSL certificate for gateway.example.com expires in 14 days. Please renew before expiration.',
      timestamp: new Date(now - 7200000).toISOString(),
      read: false,
    },
    {
      id: `notif_${++idCounter}`,
      type: 'info',
      title: 'System Update Available',
      message:
        'A new version of the project manager (v2.9.0) is available. Consider upgrading for latest security patches.',
      timestamp: new Date(now - 25200000).toISOString(),
      read: false,
    },
    {
      id: `notif_${++idCounter}`,
      type: 'success',
      title: 'Health Check Passed',
      message: `All ${projects.length} project health checks passed. System operating normally.`,
      timestamp: new Date(now - 600000).toISOString(),
      read: false,
    },
    {
      id: `notif_${++idCounter}`,
      type: 'error',
      title: 'Port Conflict Detected',
      message:
        'Multiple services attempting to bind to the same port. Check environment configurations for conflicts.',
      timestamp: new Date(now - 10800000).toISOString(),
      read: true,
    },
  ]

  // Add system notifications to fill up to 8-12 total
  const targetCount = Math.min(
    12,
    Math.max(8, notifications.length + 2)
  )
  while (notifications.length < targetCount && systemNotifications.length > 0) {
    const sysNotif = systemNotifications.shift()!
    notifications.push(sysNotif)
  }

  // Sort by timestamp (newest first)
  notifications.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )

  return notifications
}

// In-memory read state tracking (per server instance)
const readState = new Map<string, boolean>()

export async function GET() {
  try {
    const projects = await db.project.findMany({
      include: { environments: true },
    })

    const notifications = generateNotifications(projects)

    // Apply read state from memory
    for (const notif of notifications) {
      if (readState.has(notif.id)) {
        notif.read = readState.get(notif.id)!
      }
    }

    return NextResponse.json(notifications)
  } catch (error) {
    console.error('Failed to fetch notifications:', error)
    return NextResponse.json(
      { error: 'Failed to fetch notifications' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { id, markAll } = body

    if (markAll) {
      // Mark all known notification IDs as read
      // Since notifications are generated dynamically, we mark the current set
      const projects = await db.project.findMany({
        include: { environments: true },
      })
      const notifications = generateNotifications(projects)
      for (const n of notifications) {
        readState.set(n.id, true)
      }
      return NextResponse.json({ message: 'All notifications marked as read' })
    }

    if (id) {
      readState.set(id, true)
      return NextResponse.json({
        message: 'Notification marked as read',
        id,
      })
    }

    return NextResponse.json(
      { error: 'Either id or markAll is required' },
      { status: 400 }
    )
  } catch (error) {
    console.error('Failed to update notification:', error)
    return NextResponse.json(
      { error: 'Failed to update notification' },
      { status: 500 }
    )
  }
}

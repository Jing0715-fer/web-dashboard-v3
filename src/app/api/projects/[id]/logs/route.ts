import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { isRemoteProject, proxyProjectAction } from '@/lib/route-decision'
import { getLogs } from '@/lib/process-manager'

// GET /api/projects/[id]/logs
// Local project → real process logs. The process manager writes one log file
// per (projectId, envName) under /tmp/web-dashboard-logs; lines written by
// the manager itself carry a "[<ISO timestamp>] " prefix (parsed out into
// the timestamp field), raw stdout/stderr lines have no timestamp → null.
// Remote project → proxy to agent.

interface LocalLogEntry {
  id: string
  timestamp: string | null
  level: 'error' | 'warn' | 'info'
  source: string
  message: string
  projectId: string
  envName: string
}

// Leading "[2025-01-02T03:04:05.678Z] " written by appendLog()
const TIMESTAMP_PREFIX = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]\s?/

function inferLevel(line: string): 'error' | 'warn' | 'info' {
  if (/error|exception|failed|fatal|EADDRINUSE|Cannot find|crash/i.test(line)) return 'error'
  if (/warn|warning|deprecated/i.test(line)) return 'warn'
  return 'info'
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

    // Local project → read the real log files of every environment.
    // Within one environment the file order is preserved (oldest → newest);
    // environments are concatenated in project order (creation order).
    const environments = await db.environment.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'asc' },
    })

    const logs: LocalLogEntry[] = []
    for (const env of environments) {
      const lines = getLogs(id, env.name)
      lines.forEach((line, lineIdx) => {
        const tsMatch = line.match(TIMESTAMP_PREFIX)
        logs.push({
          id: `${env.id}-${lineIdx}`,
          timestamp: tsMatch ? tsMatch[1] : null,
          level: inferLevel(line),
          source: env.name,
          message: tsMatch ? line.slice(tsMatch[0].length) : line,
          projectId: id,
          envName: env.name,
        })
      })
    }

    return NextResponse.json(logs)
  } catch (error) {
    console.error('Failed to fetch logs:', error)
    return NextResponse.json({ error: 'Failed to fetch logs' }, { status: 500 })
  }
}

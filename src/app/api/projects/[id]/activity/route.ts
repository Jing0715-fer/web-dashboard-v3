import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { isRemoteProject, proxyProjectAction } from '@/lib/route-decision'
import { serializeActivityEvent, type SerializedActivityEvent } from '@/lib/activity'
import { requireApprovedUser } from '@/lib/auth';

// GET /api/projects/[id]/activity
// Local project → real events from the ActivityEvent table (written
// fire-and-forget by the mutation routes). Remote project → proxy to agent.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(request);
  if (authGuard.error) return authGuard.error;
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

    // Local project → persisted activity events (newest first)
    const events = await db.activityEvent.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    const serialized: SerializedActivityEvent[] = events.map(serializeActivityEvent)
    return NextResponse.json(serialized)
  } catch (error) {
    console.error('Failed to fetch activity:', error)
    return NextResponse.json({ error: 'Failed to fetch activity' }, { status: 500 })
  }
}

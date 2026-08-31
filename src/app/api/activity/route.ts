import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { isRemoteProject, proxyProjectAction } from '@/lib/route-decision'
import { serializeActivityEvent, type SerializedActivityEvent } from '@/lib/activity'
import { requireApprovedUser } from '@/lib/auth';

// GET /api/activity — global activity feed.
// Merges locally persisted ActivityEvent rows (written by the mutation
// routes) with events proxied from remote devices' own activity endpoints,
// then returns the newest 50 overall. Remote events keep their own shape
// (their agent serializes them) and are passed through as-is.
export async function GET(req: Request) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const [localEvents, projects] = await Promise.all([
      db.activityEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
      db.project.findMany({ include: { device: true } }),
    ])

    const allEvents: SerializedActivityEvent[] = localEvents.map(serializeActivityEvent)

    // Fetch remote projects' activity in parallel (best-effort per project)
    const remoteProjects = projects.filter((p) => isRemoteProject(p))
    const results = await Promise.allSettled(
      remoteProjects.map(async (project) => {
        try {
          const result = await proxyProjectAction(
            project.deviceId!,
            `/projects/${project.id}/activity`,
            'GET'
          )
          return (result.data as SerializedActivityEvent[]) || []
        } catch {
          return []
        }
      })
    )

    for (const result of results) {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        allEvents.push(...result.value)
      }
    }

    // Sort by timestamp descending (guard against missing/invalid timestamps
    // in remote payloads) and limit to the top 50.
    allEvents.sort(
      (a, b) =>
        (b.timestamp ? new Date(b.timestamp).getTime() : 0) -
        (a.timestamp ? new Date(a.timestamp).getTime() : 0)
    )

    return NextResponse.json(allEvents.slice(0, 50))
  } catch (error) {
    console.error('Failed to fetch aggregated activity:', error)
    return NextResponse.json({ error: 'Failed to fetch activity' }, { status: 500 })
  }
}

import { db } from '@/lib/db'

/**
 * Persistent activity feed.
 *
 * logActivity() is strictly fire-and-forget: it kicks off an async DB write
 * and never throws, never returns a promise the caller must await, and never
 * delays or breaks the HTTP request it is called from. All errors are
 * swallowed (logged to console at most).
 *
 * Rows are snapshot-style (project/env/device names copied at write time, no
 * foreign keys) so deleting a project never cascades away its history.
 */

export type ActivityLevel = 'info' | 'success' | 'warn' | 'error'

export interface ActivityInput {
  projectId?: string
  projectName?: string
  envId?: string
  envName?: string
  deviceId?: string
  deviceName?: string
  type: string
  message: string
  detail?: string
  level?: ActivityLevel
  durationMs?: number
}

// Retention: drop events older than 30 days and cap the table at the newest
// 2000 rows. Enforced probabilistically (2% of writes) to amortize cost.
const RETENTION_DAYS = 30
const MAX_ROWS = 2000
const RETENTION_PROBABILITY = 0.02

/** Fire-and-forget activity write. Never throws, never blocks the caller. */
export function logActivity(input: ActivityInput): void {
  void persist(input).catch(() => {
    // swallow — activity logging must never break a request
  })
}

async function persist(input: ActivityInput): Promise<void> {
  try {
    await db.activityEvent.create({
      data: {
        projectId: input.projectId ?? null,
        projectName: input.projectName ?? null,
        envId: input.envId ?? null,
        envName: input.envName ?? null,
        deviceId: input.deviceId ?? null,
        deviceName: input.deviceName ?? null,
        type: input.type,
        message: input.message,
        detail: input.detail ?? null,
        level: input.level ?? 'info',
        durationMs: input.durationMs ?? null,
      },
    })
    if (Math.random() < RETENTION_PROBABILITY) {
      await enforceRetention()
    }
  } catch (err) {
    // swallow — best-effort telemetry only
    console.error('[activity] failed to persist event:', err instanceof Error ? err.message : err)
  }
}

async function enforceRetention(): Promise<void> {
  try {
    // 1. Age-based: anything older than 30 days goes away.
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    await db.activityEvent.deleteMany({ where: { createdAt: { lt: cutoff } } })

    // 2. Count-based: keep only the newest MAX_ROWS rows. Find the createdAt
    // of the first row beyond the cap, then delete everything strictly older.
    const total = await db.activityEvent.count()
    if (total > MAX_ROWS) {
      const boundary = await db.activityEvent.findMany({
        orderBy: { createdAt: 'desc' },
        skip: MAX_ROWS,
        take: 1,
        select: { createdAt: true },
      })
      if (boundary.length > 0) {
        await db.activityEvent.deleteMany({
          where: { createdAt: { lt: boundary[0].createdAt } },
        })
      }
    }
  } catch {
    // swallow — retention is best-effort
  }
}

// ====================== serialization (frontend shape) ======================

/** Raw DB row as returned by prisma (subset of fields we serialize). */
export interface ActivityEventRow {
  id: string
  projectId: string | null
  projectName: string | null
  envId: string | null
  envName: string | null
  deviceId: string | null
  deviceName: string | null
  type: string
  message: string
  detail: string | null
  level: string | null
  durationMs: number | null
  createdAt: Date
}

/**
 * Shape consumed by the frontend ActivityEvent interface:
 *   { id, type, message, timestamp (ISO), projectId, projectName?, metadata? }
 * Null fields are omitted; metadata only contains keys with values.
 */
export interface SerializedActivityEvent {
  id: string
  type: string
  message: string
  timestamp: string
  projectId?: string
  projectName?: string
  level?: string
  metadata?: Record<string, unknown>
}

export function serializeActivityEvent(row: ActivityEventRow): SerializedActivityEvent {
  const event: SerializedActivityEvent = {
    id: row.id,
    type: row.type,
    message: row.message,
    timestamp: row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString(),
  }
  if (row.projectId) event.projectId = row.projectId
  if (row.projectName) event.projectName = row.projectName
  if (row.level) event.level = row.level

  const metadata: Record<string, unknown> = {}
  if (row.envName) metadata.environmentName = row.envName
  if (row.detail) metadata.detail = row.detail
  if (row.durationMs != null) metadata.durationMs = row.durationMs
  if (row.deviceName) metadata.deviceName = row.deviceName
  if (Object.keys(metadata).length > 0) event.metadata = metadata

  return event
}

import { db } from '@/lib/db'
import { batchCheckPorts } from '@/lib/process-manager'

/**
 * Heuristic: is the env "really running"?
 *
 *  - DB says running + port is listening on localhost → running
 *  - DB says running + port is NOT listening         → stale "running" in DB
 *  - DB says stopped + port IS listening             → orphan from a previous run
 *
 * Returns the truth AND auto-corrects the DB when it's stale, so the
 * dashboard's project list self-heals on every poll (no user action needed).
 */
function isReallyRunning(port: number): Promise<boolean> {
  return new Promise(async (resolve) => {
    // We use the same `batchCheckPorts` to stay consistent with the manager.
    // One call per row would be wasteful, so callers should batch with
    // enrichEnvStatusesWithPortStatus() below.
    const active = await batchCheckPorts([port])
    resolve(active.has(port))
  })
}

/**
 * Single-env version: returns the actual status (DB or port-based) AND
 * auto-corrects the DB if the recorded state is stale.
 */
export async function reconcileEnv(envId: string, dbStatus: string, dbPid: number | null, port: number): Promise<{
  status: 'running' | 'stopped'
  corrected: boolean
}> {
  const portActive = await isReallyRunning(port)

  // Case 1: DB says running, port listening → all good.
  if (dbStatus === 'running' && portActive) {
    return { status: 'running', corrected: false }
  }

  // Case 2: DB says running, port NOT listening → stale "running". Clear it.
  if (dbStatus === 'running' && !portActive) {
    await db.environment.update({
      where: { id: envId },
      data: { status: 'stopped', pid: null },
    })
    return { status: 'stopped', corrected: true }
  }

  // Case 3: DB says stopped, port IS listening → orphaned process from a
  // previous session (e.g. user ran `npm run dev` manually in a terminal).
  // We don't auto-stop it — that could kill something the user wants.
  // Just report "running" so the UI reflects reality, and leave the DB alone
  // (the next legitimate start will overwrite status + pid).
  if (dbStatus === 'stopped' && portActive) {
    return { status: 'running', corrected: false }
  }

  // Case 4: DB says stopped, port free → all good.
  return { status: 'stopped', corrected: false }
}

/**
 * Enrich a list of environments with reconciled status, in a single
 * `ss` call. Returns a new list — the original objects are not mutated.
 *
 * Mutates the DB in-place when stale "running" rows are detected.
 */
export async function enrichEnvStatuses<
  T extends { id: string; status: string; pid: number | null; port: number }
>(envs: T[]): Promise<(T & { status: 'running' | 'stopped' })[]> {
  if (envs.length === 0) return []
  const ports = envs.map((e) => e.port)
  const activePorts = await batchCheckPorts(ports)

  const results = await Promise.all(
    envs.map(async (e) => {
      const portActive = activePorts.has(e.port)
      if (e.status === 'running' && !portActive) {
        // Stale — clear it
        await db.environment.update({
          where: { id: e.id },
          data: { status: 'stopped', pid: null },
        })
        return { ...e, status: 'stopped' as const }
      }
      if (e.status === 'stopped' && portActive) {
        // Orphaned — report running but don't touch DB
        return { ...e, status: 'running' as const }
      }
      return { ...e, status: e.status as 'running' | 'stopped' }
    })
  )
  return results
}

import { db } from '@/lib/db'
import { proxyToAgent } from '@/lib/remote-agent'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Remote project sync — stale-while-revalidate.
 *
 * History: GET /api/projects used to await every remote agent inline with a
 * 15s timeout. One unreachable (TCP-hanging) device stalled the whole list
 * request for 15s — and because the frontend polls every 8s, requests piled
 * up faster than they resolved, making page refreshes feel endlessly slow.
 *
 * Now:
 *  - Listing is a cheap read: online devices get a 6s budget, offline devices
 *    get 1.5s (probing whether they came back). Control operations (start /
 *    stop / rebuild) keep the original 15s timeout.
 *  - The sync result is cached at module level. Responses serve the cached
 *    list instantly; a refresh runs in the background and lands on the next
 *    poll (frontend re-polls every 8s, so data converges within one cycle).
 *  - Cold cache (first request after boot): we await the sync — online
 *    agents respond in well under a second, offline ones fail fast.
 *  - Mutating routes (start/stop/restart/rebuild/sync/device changes) call
 *    invalidateRemoteProjectCache() so the very next GET re-syncs for real
 *    instead of serving a stale snapshot of process statuses.
 */

const FRESH_MS = 6_000 // serve from cache with no background refresh
const ONLINE_TIMEOUT_MS = 6_000
const OFFLINE_TIMEOUT_MS = 1_500

const AGENT_DIRS = ['agent', 'agent-linux', 'agent-macos', 'agent-win', 'agent-windows']

/**
 * apiKeys of the agent(s) co-located on THIS machine (mini-services/agent-*'
 * agent-config.json). A Device row carrying one of these keys IS this
 * machine — its projects are already our local rows. Syncing such a row
 * would feed our own projects back through the agent and flip them to
 * "remote" (self-mirror corruption — seen live: a local project's deviceId
 * got overwritten with the self device's id).
 */
function localAgentApiKeys(): Set<string> {
  const keys = new Set<string>()
  const root = process.cwd()
  for (const dir of AGENT_DIRS) {
    try {
      const cfg = JSON.parse(
        fs.readFileSync(path.join(root, 'mini-services', dir, 'agent-config.json'), 'utf-8')
      )
      if (cfg.apiKey) keys.add(String(cfg.apiKey))
    } catch { /* no config in this dir */ }
  }
  return keys
}

export interface RemoteSyncResult {
  at: number
  /** Deduped live remote projects, already carrying deviceId/deviceName. */
  projects: any[]
}

let cache: RemoteSyncResult | null = null
let inflight: Promise<RemoteSyncResult> | null = null

/** Drop the cache so the next GET performs a real await-sync. */
export function invalidateRemoteProjectCache() {
  cache = null
}

/**
 * Fetch from every device, reconcile device status, dedupe, and persist to
 * the local DB (so start/stop routes can address remote rows). This is the
 * full sync — extracted verbatim from the old GET /api/projects handler.
 */
async function syncRemoteProjects(): Promise<RemoteSyncResult> {
  const startedAt = Date.now()
  // Skip the self-mirroring device rows: an agent co-located with THIS
  // dashboard serves our own local projects, and mirroring them back would
  // corrupt deviceId. (Device rows for other machines are unaffected.)
  const localKeys = localAgentApiKeys()
  const allDevices = await db.device.findMany()
  const devices = allDevices.filter((d) => !localKeys.has(d.apiKey))
  const remoteResults = await Promise.allSettled(
    devices.map(async (device) => {
      // Offline devices get a short probe budget; online ones the full (but
      // still modest) 6s. proxyToAgent returns { ok: false } on timeout or
      // connection failure — that's the signal to flip the device offline,
      // which shrinks its next budget to 1.5s (fast convergence both ways).
      const timeout =
        device.status === 'offline' ? OFFLINE_TIMEOUT_MS : ONLINE_TIMEOUT_MS
      const config = { ip: device.ip, port: device.port, apiKey: device.apiKey }
      try {
        const result = await proxyToAgent(config, '/projects', 'GET', undefined, timeout)
        if (!result.ok) {
          if (device.status !== 'offline') {
            await db.device
              .update({ where: { id: device.id }, data: { status: 'offline' } })
              .catch(() => {})
          }
          return []
        }
        // Agent answered — it's online regardless of project count.
        if (device.status !== 'online') {
          await db.device
            .update({ where: { id: device.id }, data: { status: 'online', lastSeen: new Date() } })
            .catch(() => {})
        }
        const projects: any[] = result.data?.projects || []
        return projects.map((p: any) => ({
          ...p,
          deviceId: device.id,
          deviceName: device.name,
          deviceIp: device.ip,
          deviceStatus: 'online' as const,
          environments: (p.environments || []).map((e: any) => ({
            ...e,
            status: e.status || 'stopped',
          })),
        }))
      } catch {
        if (device.status !== 'offline') {
          await db.device
            .update({ where: { id: device.id }, data: { status: 'offline' } })
            .catch(() => {})
        }
        return []
      }
    })
  )

  const enrichedRemote = remoteResults.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))

  // Dedupe live remote projects by (deviceId, path) — the Windows agent
  // occasionally returns the same project twice. Prefer rows with envs.
  const remoteByKey = new Map<string, any>()
  for (const p of enrichedRemote as any[]) {
    if (!p.deviceId || !p.path) continue
    const key = `${p.deviceId}::${p.path}`
    const existing = remoteByKey.get(key)
    if (!existing) {
      remoteByKey.set(key, p)
      continue
    }
    const existingHasEnv = (existing.environments?.length ?? 0) > 0
    const incomingHasEnv = (p.environments?.length ?? 0) > 0
    if (incomingHasEnv && !existingHasEnv) {
      remoteByKey.set(key, p)
    }
  }
  const dedupedRemote = Array.from(remoteByKey.values())

  // Persist live remote projects so start/stop/restart routes can find them.
  // Change-detection avoids rewriting identical rows on every poll.
  const cachedRows = await db.project.findMany({
    where: { deviceId: { not: null } },
    include: { environments: true },
  })
  const cachedById = new Map(cachedRows.map((p) => [p.id, p]))
  for (const remote of dedupedRemote) {
    try {
      const envData = (remote.environments || []).map((e: any) => ({
        id: e.id,
        projectId: remote.id,
        name: e.name,
        cmd: e.cmd,
        port: e.port,
        envVars: typeof e.envVars === 'string' ? e.envVars : JSON.stringify(e.envVars || {}),
        status: e.status || 'stopped',
        pid: e.pid ?? null,
      }))
      const tagsStr = typeof remote.tags === 'string' ? remote.tags : JSON.stringify(remote.tags || [])
      const cached = cachedById.get(remote.id)
      if (
        cached &&
        cached.name === remote.name &&
        cached.path === remote.path &&
        cached.description === (remote.description || '') &&
        cached.icon === (remote.icon || 'folder') &&
        cached.tags === tagsStr &&
        cached.deviceId === remote.deviceId &&
        cached.environments.length === envData.length &&
        cached.environments.every((ce, i) =>
          ce.id === envData[i].id &&
          ce.name === envData[i].name &&
          ce.cmd === envData[i].cmd &&
          ce.port === envData[i].port &&
          ce.envVars === envData[i].envVars &&
          ce.status === envData[i].status &&
          (ce.pid ?? null) === envData[i].pid
        )
      ) {
        continue
      }
      await db.$transaction(async (tx) => {
        await tx.project.upsert({
          where: { id: remote.id },
          update: {
            name: remote.name,
            path: remote.path,
            description: remote.description || '',
            icon: remote.icon || 'folder',
            tags: tagsStr,
            deviceId: remote.deviceId,
          },
          create: {
            id: remote.id,
            name: remote.name,
            path: remote.path,
            description: remote.description || '',
            icon: remote.icon || 'folder',
            tags: tagsStr,
            deviceId: remote.deviceId,
            order: remote.order ?? 0,
          },
        })
        await tx.environment.deleteMany({ where: { projectId: remote.id } })
        if (envData.length > 0) {
          await tx.environment.createMany({ data: envData })
        }
      })
    } catch (e) {
      console.error('Failed to persist remote project', remote.id, e)
    }
  }

  console.log(
    `[remote-sync] completed in ${Date.now() - startedAt}ms: ${devices.length} device(s), ${dedupedRemote.length} remote project(s)`
  )
  return { at: Date.now(), projects: dedupedRemote }
}

function startSync(): Promise<RemoteSyncResult> {
  if (!inflight) {
    inflight = syncRemoteProjects().finally(() => {
      inflight = null
    })
  }
  return inflight
}

/**
 * SWR accessor used by GET /api/projects.
 *  - fresh cache → instant return, no network
 *  - stale cache → instant return + background refresh
 *  - no cache    → await the first sync (fast: online <1s, offline 1.5s)
 * `force` bypasses the cache entirely (manual sync / post-mutation).
 */
export async function getRemoteProjectsCached(force = false): Promise<any[]> {
  if (force) {
    invalidateRemoteProjectCache()
    const result = await startSync()
    cache = result
    return result.projects
  }
  if (cache) {
    const age = Date.now() - cache.at
    if (age >= FRESH_MS) {
      // Stale — serve immediately, refresh in the background. Errors are
      // swallowed on purpose: the next poll retries, and the caller already
      // has usable (slightly old) data in hand.
      startSync().then((fresh) => { cache = fresh }).catch(() => {})
    }
    return cache.projects
  }
  // Cold path: block once so the very first paint includes remote projects.
  const result = await startSync()
  cache = result
  return result.projects
}

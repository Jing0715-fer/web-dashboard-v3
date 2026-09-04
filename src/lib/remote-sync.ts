import { db } from '@/lib/db'
import { proxyToAgent } from '@/lib/remote-agent'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

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
 *  - HEARTBEAT PUSH FALLBACK: agents push their project list to every paired
 *    dashboard with each 60s heartbeat (recorded via /api/mesh/register).
 *    When the direct pull below fails (typically the peer's firewall blocks
 *    inbound connections — Windows Defender), a fresh push keeps the device
 *    ONLINE and its projects visible read-only. One-way networks (A can
 *    reach B, B cannot reach A) still get data in BOTH directions.
 */

const FRESH_MS = 6_000 // serve from cache with no background refresh
const ONLINE_TIMEOUT_MS = 6_000
const OFFLINE_TIMEOUT_MS = 1_500

// ---- heartbeat push store ----
// Agents re-register with every paired dashboard each 60s heartbeat and
// now attach their project list. A device whose DIRECT pull fails (peer
// firewall) still serves this last-pushed data: the agent is demonstrably
// alive (it just pushed) and its projects stay visible read-only.
const PUSH_STALE_MS = 5 * 60_000 // heartbeat is 60s — allow a few missed beats
export const PUSH_FRESH_MS = 2 * 60_000 // UI badge threshold ("push mode")

export interface DevicePush {
  at: number
  projects: any[]
  ip: string
  port: number
}

const pushStore = new Map<string, DevicePush>()

/** Record a heartbeat-pushed project list for a device (trusted: the
 *  register endpoint authenticates the agent by its stored apiKey). */
export function recordDevicePush(deviceId: string, projects: any[], ip: string, port: number): void {
  if (!Array.isArray(projects)) return
  pushStore.set(deviceId, { at: Date.now(), projects, ip, port })
}

/** Last heartbeat push for a device (null when it never pushed). */
export function getDevicePush(deviceId: string): DevicePush | null {
  return pushStore.get(deviceId) ?? null
}

const AGENT_DIRS = ['agent', 'agent-linux', 'agent-macos', 'agent-win', 'agent-windows']

/**
 * apiKeys of the agent(s) co-located on THIS machine (mini-services/agent-*'
 * agent-config.json). A Device row carrying one of these keys IS this
 * machine — its projects are already our local rows. Syncing such a row
 * would feed our own projects back through the agent and flip them to
 * "remote" (self-mirror corruption — seen live: a local project's deviceId
 * got overwritten with the self device's id).
 */
export function localAgentApiKeys(): Set<string> {
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

// ---- self-row identification (key + ADDRESS, not key alone) ----

let localIfaceCache: { at: number; ips: Set<string> } | null = null;

/** IPv4/IPv6 addresses of THIS machine (loopback included), 30s-cached. */
function localInterfaceIps(): Set<string> {
  if (localIfaceCache && Date.now() - localIfaceCache.at < 30_000) return localIfaceCache.ips;
  const ips = new Set<string>(['localhost', '::1']);
  try {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const i of ifaces || []) {
        if (i && i.address) ips.add(i.address.toLowerCase());
      }
    }
  } catch { /* interfaces unavailable */ }
  localIfaceCache = { at: Date.now(), ips };
  return ips;
}

/** True when `ip` is an address of THIS machine (loopback or a local
 * network interface address). */
export function isLocalAddress(ip: string | null | undefined): boolean {
  const host = String(ip || '').trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith('127.')) return true;
  return localInterfaceIps().has(host);
}

/**
 * A Device row IS this machine only when BOTH hold: its apiKey matches a
 * co-located agent's key AND its address is one of this machine's own.
 * Key-only matching used to hide REAL peers: the repo accidentally shipped
 * one shared agent-config.json (tracked before the .gitignore rule), every
 * clone adopted the same key, and each side filtered the other's Device
 * row out of /api/devices and the project sync — "paired successfully but
 * we can't see each other, 0 projects". The address check makes that
 * failure mode impossible: a peer on another LAN IP is shown and synced
 * even if its key happens to collide with a local one.
 */
export function isSelfDeviceRow(
  device: { apiKey: string | null; ip: string | null },
  localKeys: Set<string>
): boolean {
  if (!device?.apiKey || !localKeys.has(device.apiKey)) return false;
  return isLocalAddress(device.ip);
}

/**
 * Self-mirror corruption heal. Versions before the deviceId-IS-NULL guard
 * could feed this dashboard's OWN projects back through its own agent and
 * overwrite their deviceId with the self device row's id. Such projects
 * then vanish from BOTH views at once: the local list (deviceId != null)
 * and the agent's serving (deviceId IS NULL filter) — the machine shows
 * "0 projects" to every peer (and to itself) forever. Reset deviceId to
 * NULL for any project owned by a SELF device row.
 */
async function healSelfMirroredProjects(localKeys: Set<string>): Promise<number> {
  if (localKeys.size === 0) return 0;
  const keyRows = await db.device.findMany({
    where: { apiKey: { in: [...localKeys] } },
    select: { id: true, name: true, ip: true },
  });
  // Key match alone is NOT proof of "self" (shared-key collision — see
  // isSelfDeviceRow): only rows whose address is one of THIS machine's
  // own may be healed.
  const selfRows = keyRows.filter((r) => isLocalAddress(r.ip));
  if (selfRows.length === 0) return 0;
  const res = await db.project.updateMany({
    where: { deviceId: { in: selfRows.map((r) => r.id) } },
    data: { deviceId: null },
  });
  return res.count;
}

/** Idempotent, safe to call on every projects GET — early-exits when this
 * machine has no self device rows (the overwhelmingly common case). */
export async function healSelfMirroredLocalProjects(): Promise<void> {
  const healed = await healSelfMirroredProjects(localAgentApiKeys());
  if (healed > 0) {
    console.log(`[remote-sync] healed ${healed} self-mirrored project(s) back to local`);
  }
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

  // Heal rows already corrupted by pre-guard versions (deviceId pointing
  // at the self device row) BEFORE anything reads them — the local list,
  // the agent's serving and the peer's view all recover in this same pass.
  const healed = await healSelfMirroredProjects(localKeys)
  if (healed > 0) {
    console.log(`[remote-sync] healed ${healed} self-mirrored project(s) back to local`)
  }

  const allDevices = await db.device.findMany()
  // Self rows (co-located agent) are skipped — but ONLY rows whose address
  // is actually this machine's (see isSelfDeviceRow): a peer carrying a
  // colliding key stays visible and synced.
  const devices = allDevices.filter((d) => !isSelfDeviceRow(d, localKeys))
  const remoteResults = await Promise.allSettled(
    devices.map(async (device) => {
      // Offline devices get a short probe budget; online ones the full (but
      // still modest) 6s. proxyToAgent returns { ok: false } on timeout or
      // connection failure — that's the signal to flip the device offline,
      // which shrinks its next budget to 1.5s (fast convergence both ways).
      const timeout =
        device.status === 'offline' ? OFFLINE_TIMEOUT_MS : ONLINE_TIMEOUT_MS
      const config = { ip: device.ip, port: device.port, apiKey: device.apiKey }
      const enrich = (projects: any[], online: boolean) =>
        projects.map((p: any) => ({
          ...p,
          deviceId: device.id,
          deviceName: device.name,
          deviceIp: device.ip,
          deviceStatus: online ? ('online' as const) : ('offline' as const),
          environments: (p.environments || []).map((e: any) => ({
            ...e,
            status: e.status || 'stopped',
          })),
        }))
      try {
        const result = await proxyToAgent(config, '/projects', 'GET', undefined, timeout)
        if (!result.ok) {
          // Direct pull failed — BUT a fresh heartbeat push proves the agent
          // is alive (its machine just can't ACCEPT inbound connections,
          // e.g. Windows Defender Firewall). Stay online + serve pushed
          // projects read-only instead of flipping to offline/0-projects.
          const push = pushStore.get(device.id)
          if (push && Date.now() - push.at < PUSH_STALE_MS) {
            if (device.status !== 'online') {
              await db.device
                .update({ where: { id: device.id }, data: { status: 'online', lastSeen: new Date(push.at) } })
                .catch(() => {})
            }
            return enrich(push.projects, true)
          }
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
        return enrich(projects, true)
      } catch {
        const push = pushStore.get(device.id)
        if (push && Date.now() - push.at < PUSH_STALE_MS) {
          return enrich(push.projects, true)
        }
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
      // Older agents don't send repoUrl at all (undefined) — in that case skip
      // the field entirely so a locally-set value on the cached row survives;
      // a string (incl. '') means the agent did report it.
      const agentRepoUrl = typeof remote.repoUrl === 'string' ? remote.repoUrl.trim() : undefined
      const cached = cachedById.get(remote.id)
      if (
        cached &&
        cached.name === remote.name &&
        cached.path === remote.path &&
        cached.description === (remote.description || '') &&
        cached.icon === (remote.icon || 'folder') &&
        cached.tags === tagsStr &&
        (agentRepoUrl === undefined || cached.repoUrl === agentRepoUrl) &&
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
            ...(agentRepoUrl !== undefined && { repoUrl: agentRepoUrl }),
            deviceId: remote.deviceId,
          },
          create: {
            id: remote.id,
            name: remote.name,
            path: remote.path,
            description: remote.description || '',
            icon: remote.icon || 'folder',
            tags: tagsStr,
            repoUrl: agentRepoUrl ?? '',
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

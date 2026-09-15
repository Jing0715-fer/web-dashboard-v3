import { db } from '@/lib/db'
import { proxyToAgent } from '@/lib/remote-agent'
import { detectLocalAgent } from '@/lib/agent-lifecycle'
import { logActivity } from '@/lib/activity'
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
 *  - PEER-CACHE RELAY: register responses now carry the TARGET side's own
 *    agent coordinates + project list. Each agent caches what its
 *    heartbeats got back; this dashboard reads that cache over 127.0.0.1
 *    (GET /api/agent/peer-cache on the local agent) when a device's direct
 *    pull fails — the ONLY leg guaranteed to work when both agent paths are
 *    firewalled (A's pull to B blocked AND B's push to A blocked, while A's
 *    agent heartbeat to B's dashboard works). Example: a Mac whose firewall
 *    blocks all inbound still sees the Windows peer's projects, because the
 *    Mac agent's heartbeat response carried them home.
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

// ---- agent meta store (v1.12) ----
// Co-located dashboard-DB state reported by agents: in the heartbeat payload
// (agentMeta — works even when the agent is firewalled) and in the
// /api/agent/projects response (meta — the pull leg). A healthy agent that
// reports dashboardDbFound:false is the "device online but 0 projects"
// smoking gun: its machine's dashboard keeps its SQLite somewhere the agent
// doesn't know (e.g. a relative .env URL, which Prisma resolves against
// prisma/), so the agent serves only its own (empty) DB to every peer.
export interface AgentMeta {
  dashboardDbFound: boolean
  dashboardDbPath: string | null
  at: number
}

/** Record an agent's self-reported co-located DB state. Trusted source: the
 *  register endpoint authenticates the agent by its stored apiKey; the pull
 *  leg authenticates with the Bearer key before reading meta. */
export function recordAgentMeta(
  deviceId: string,
  meta: { dashboardDbFound?: unknown; dashboardDbPath?: unknown } | null | undefined,
): void {
  if (!meta || typeof meta !== 'object') return
  if (typeof meta.dashboardDbFound !== 'boolean') return
  S.agentMetaStore.set(deviceId, {
    dashboardDbFound: meta.dashboardDbFound,
    dashboardDbPath: typeof meta.dashboardDbPath === 'string' ? meta.dashboardDbPath : null,
    at: Date.now(),
  })
}

/** Last reported agent meta for a device (null when never reported). */
export function getAgentMeta(deviceId: string): AgentMeta | null {
  const m = S.agentMetaStore.get(deviceId)
  if (!m) return null
  // Heartbeat cadence is 60s — anything older than 10 minutes is stale
  // (device re-imaged / agent down): hide it instead of showing a ghost
  // warning.
  if (Date.now() - m.at > 10 * 60_000) return null
  return m
}

// ---- local-agent peer-cache relay ----
// One-way networks: this machine's agent heartbeats OUT to a peer dashboard
// (works), but this dashboard's direct pull to the peer's agent fails AND
// the peer's agent can never push here. The peer's register response now
// carries its own agent coordinates + project list; the agent caches each
// entry keyed by the PEER's agent apiKey. Reading that cache over 127.0.0.1
// is the only leg that provably works, so relayed entries feed the same
// push-store path as direct heartbeat pushes.
const PEER_CACHE_TTL_MS = 30_000        // refetch the agent's relay cache at most every 30s
const PEER_CACHE_FRESH_MS = 5 * 60_000  // entry freshness (heartbeat cadence is 60s)

interface RelayEntry {
  at: number
  peer: { name?: string; ip?: string; port?: number; apiKey?: string }
  projects: any[]
}

// ---- process-wide singleton state ----
// Next dev compiles each route into its own bundle with its own copy of this
// module: module-scoped mutable state (the push store written by
// /api/mesh/register, the sync cache read by /api/projects, …) was DUPLICATED
// per route — writes from one route were invisible to the others (live
// evidence: a heartbeat's recordDevicePush never showed up in /api/devices'
// getDevicePush). All mutable state lives on globalThis so every route bundle
// shares ONE instance per server process.
interface RemoteSyncState {
  pushStore: Map<string, DevicePush>
  agentMetaStore: Map<string, AgentMeta>
  relayCache: { at: number; entries: RelayEntry[] } | null
  localIfaceCache: { at: number; ips: Set<string> } | null
  dedupScanState: { at: number }
  dedupInFlight: boolean
  cache: RemoteSyncResult | null
  inflight: Promise<RemoteSyncResult> | null
  /** Bumped by invalidateRemoteProjectCache (see below). */
  syncGeneration: number
}
const g = globalThis as typeof globalThis & { __remoteSyncState?: RemoteSyncState }
const S: RemoteSyncState = (g.__remoteSyncState ??= {
  pushStore: new Map(),
  agentMetaStore: new Map(),
  relayCache: null,
  localIfaceCache: null,
  dedupScanState: { at: 0 },
  dedupInFlight: false,
  cache: null,
  inflight: null,
  syncGeneration: 0,
})

/** Record a heartbeat-pushed project list for a device (trusted: the
 *  register endpoint authenticates the agent by its stored apiKey). */
export function recordDevicePush(deviceId: string, projects: any[], ip: string, port: number): void {
  if (!Array.isArray(projects)) return
  S.pushStore.set(deviceId, { at: Date.now(), projects, ip, port })
}

/** Last heartbeat push for a device (null when it never pushed). */
export function getDevicePush(deviceId: string): DevicePush | null {
  return S.pushStore.get(deviceId) ?? null
}

/** Entries the LOCAL agent cached from its heartbeats' responses (each
 *  paired dashboard hands back its own agent coordinates + project list).
 *  Never throws; failures (agent down / pre-upgrade agent without the
 *  endpoint) yield an empty list, briefly cached so the sync poll doesn't
 *  hammer a dead agent. */
async function fetchLocalAgentPeerCache(): Promise<RelayEntry[]> {
  if (S.relayCache && Date.now() - S.relayCache.at < PEER_CACHE_TTL_MS) {
    return S.relayCache.entries
  }
  const entries: RelayEntry[] = []
  try {
    const agent = await detectLocalAgent()
    if (agent?.running && agent.port > 0 && agent.apiKey) {
      const res = await fetch(`http://127.0.0.1:${agent.port}/api/agent/peer-cache`, {
        headers: { Authorization: `Bearer ${agent.apiKey}` },
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) {
        const data = await res.json().catch(() => null)
        if (Array.isArray(data?.entries)) {
          for (const e of data.entries) {
            if (e && typeof e === 'object' && e.peer && Array.isArray(e.projects)) {
              entries.push({ at: Number(e.at) || 0, peer: e.peer, projects: e.projects })
            }
          }
        }
      }
    }
  } catch { /* local agent down / old agent without the endpoint */ }
  S.relayCache = { at: Date.now(), entries }
  return entries
}

/** Auto-register peers discovered through the local agent's relay cache
 *  (see the comment at the call site). Mutates `devices` by appending the
 *  freshly created rows so the sync loop below processes them in the same
 *  pass: short offline probe budget → direct pull fails → relay fallback
 *  flips the row online and serves the pushed projects. */
async function registerRelayPeers(
  devices: { id: string; apiKey: string | null; ip: string | null; port: number; name: string }[],
  localKeys: Set<string>,
  peerCachePromise: Promise<RelayEntry[]>,
): Promise<void> {
  try {
    const entries = await peerCachePromise
    if (!Array.isArray(entries) || entries.length === 0) return
    const fresh = entries.filter((e) => Date.now() - (e?.at || 0) < PEER_CACHE_FRESH_MS)
    for (const e of fresh) {
      const peer = (e && e.peer) || {}
      const apiKey = String(peer.apiKey || '')
      const ip = String(peer.ip || '')
      const port = Number(peer.port) || 0
      if (!apiKey || !port) continue
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue
      // Never register OUR OWN agent mirrored back (a dashboard running on
      // this same machine answered the heartbeat) — that is the self-mirror
      // corruption the sync carefully avoids.
      if (localKeys.has(apiKey) && isLocalAddress(ip)) continue
      const known =
        devices.some((d) => d.apiKey === apiKey) ||
        devices.some((d) => d.ip === ip && d.port === port)
      if (known) continue
      const created = await db.device
        .create({
          data: {
            name: String(peer.name || 'Dashboard peer'),
            ip,
            port,
            apiKey,
            // 'offline' → the first sync probe uses the short 1.5s budget;
            // the relay fallback in the same pass flips it online.
            status: 'offline',
            lastSeen: new Date(Number(e.at) || Date.now()),
          },
        })
        .catch(() => null)
      if (created) {
        devices.push(created)
        console.log(
          `[remote-sync] relay-registered peer device '${created.name}' (${ip}:${port})`,
        )
        logActivity({
          type: 'pair',
          level: 'success',
          message: `Device '${created.name}' auto-registered via heartbeat relay`,
          deviceId: created.id,
          deviceName: created.name,
          detail: `${ip}:${port} — paired through the heartbeat exchange, projects visible read-only`,
        })
      }
    }
  } catch { /* relay registration is best-effort */ }
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

/** IPv4/IPv6 addresses of THIS machine (loopback included), 30s-cached. */
function localInterfaceIps(): Set<string> {
  if (S.localIfaceCache && Date.now() - S.localIfaceCache.at < 30_000) return S.localIfaceCache.ips;
  const ips = new Set<string>(['localhost', '::1']);
  try {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const i of ifaces || []) {
        if (i && i.address) ips.add(i.address.toLowerCase());
      }
    }
  } catch { /* interfaces unavailable */ }
  S.localIfaceCache = { at: Date.now(), ips };
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

/** Merge Device rows that share (ip, port) — one machine must be ONE row.
 *  Winner selection, in priority order:
 *    1. row with a fresh heartbeat push (its key provably authenticates —
 *       the register handler only records pushes for the key-matching row);
 *    2. row whose direct pull just succeeded (key verified this cycle);
 *    3. row with the most cached project rows;
 *    4. row with the most recent lastSeen.
 *  Losers drop their cached project rows (mirror copies — the winner's sync
 *  re-creates them) and are then deleted. Rate-limited: the DB work is not
 *  free and duplicates are rare once the creation paths dedupe correctly. */
const DEDUP_SCAN_MIN_MS = 5 * 60_000;

async function mergeDuplicateDeviceRows(
  devices: any[],
  pullOkById: Map<string, boolean>,
): Promise<Map<string, { id: string; name: string }>> {
  const loserToWinner = new Map<string, { id: string; name: string }>();
  if (S.dedupInFlight) return loserToWinner;
  const groups = new Map<string, any[]>();
  for (const d of devices) {
    if (!d?.ip || !d?.port || Number(d.port) <= 0) continue;
    const key = `${String(d.ip)}:${Number(d.port)}`;
    const arr = groups.get(key) || [];
    arr.push(d);
    groups.set(key, arr);
  }
  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  if (dupGroups.length === 0) return loserToWinner;
  if (Date.now() - S.dedupScanState.at < DEDUP_SCAN_MIN_MS) return loserToWinner;
  S.dedupScanState.at = Date.now();
  S.dedupInFlight = true;
  try {
    for (const group of dupGroups) {
      try {
        const counts = await db.project.groupBy({
          by: ['deviceId'],
          where: { deviceId: { in: group.map((d) => String(d.id)) } },
          _count: { id: true },
        });
        const countById = new Map(
          counts.map((c: any) => [String(c.deviceId), Number(c?._count?.id) || 0]),
        );
        const score = (d: any): number[] => {
          const push = S.pushStore.get(String(d.id));
          const freshPush = push && Date.now() - push.at < PUSH_STALE_MS ? 1 : 0;
          return [
            freshPush,
            pullOkById.get(String(d.id)) ? 1 : 0,
            countById.get(String(d.id)) || 0,
            Date.parse(String(d.lastSeen)) || 0,
          ];
        };
        const sorted = [...group].sort((a, b) => {
          const sa = score(a);
          const sb = score(b);
          for (let i = 0; i < sa.length; i++) if (sb[i] !== sa[i]) return sb[i] - sa[i];
          return 0;
        });
        const winner = sorted[0];
        for (const loser of sorted.slice(1)) {
          // Cached rows first (mirror copies — the winner's sync re-creates
          // them), then the row itself. Deleting the row alone would SetNull
          // the projects into LOCAL rows (duplicated home-machine cards).
          await db.project.deleteMany({ where: { deviceId: loser.id } });
          await db.device.delete({ where: { id: loser.id } });
          loserToWinner.set(String(loser.id), { id: String(winner.id), name: String(winner.name) });
          console.log(
            `[remote-sync] merged duplicate device row '${loser.name}' into '${winner.name}' (${winner.ip}:${winner.port})`,
          );
          logActivity({
            type: 'pair',
            level: 'info',
            message: `Duplicate device row '${loser.name}' merged into '${winner.name}'`,
            deviceId: String(winner.id),
            deviceName: String(winner.name),
            detail: `both pointed at ${winner.ip}:${winner.port} — the stale row (dead key, no reachable projects) was removed`,
          });
        }
      } catch (e) {
        console.error('[remote-sync] duplicate merge failed for a group', e);
      }
    }
  } finally {
    S.dedupInFlight = false;
  }
  return loserToWinner;
}

/** Agent-reported repoUrl values must be https URLs before they may enter
 *  the DB or the API response. The agent-side editors normalize identically,
 *  so anything else (javascript:, file://, ssh, plain paths …) is either a
 *  hostile push or a legacy value — both are refused here, killing the
 *  stored-XSS chain (agent push → DB → card href → script execution in the
 *  dashboard origin, where the raw session token sits in localStorage).
 *  Exported: the mesh register route reuses it for repoSync overrides. */
export function isHttpsRepoUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  const s = raw.trim()
  return /^https:\/\/[\w.-]+\//i.test(s) || /^https:\/\/[^/\s]+$/i.test(s)
}

export interface RemoteSyncResult {
  at: number
  /** Deduped live remote projects, already carrying deviceId/deviceName. */
  projects: any[]
  /** Generation (invalidation counter) this snapshot was computed under. */
  gen: number
}

// (cache / inflight / syncGeneration live on the shared singleton S — see
// the "process-wide singleton state" block above.)

/** Drop the cache so the next GET performs a real await-sync. */
export function invalidateRemoteProjectCache() {
  S.cache = null
  S.syncGeneration++
}

/**
 * Fetch from every device, reconcile device status, dedupe, and persist to
 * the local DB (so start/stop routes can address remote rows). This is the
 * full sync — extracted verbatim from the old GET /api/projects handler.
 */
async function syncRemoteProjects(): Promise<RemoteSyncResult> {
  const startedAt = Date.now()
  // Snapshot the generation at START: if an invalidation lands MID-sync the
  // result is (at best) mixed pre/post-mutation data — marking it with the
  // older generation makes force callers re-run one extra sync. The safe
  // direction: an unnecessary re-sync, never a stale-labeled-fresh result.
  const startedGen = S.syncGeneration
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

  // Peer-cache relay: kick the local agent's cached-entry fetch in parallel
  // with the direct pulls — it is consulted inside a device's pull-failure
  // path (see freshPushFor) AND by registerRelayPeers just below (peers the
  // relay discovered that have no Device row here get auto-registered).
  // ALWAYS fetched (not only when rows exist): the relay is exactly how a
  // machine with ZERO device rows still learns its paired peers.
  const peerCachePromise: Promise<RelayEntry[]> = fetchLocalAgentPeerCache().catch(
    () => [] as RelayEntry[],
  )

  // Relay auto-registration: entries the LOCAL agent cached from heartbeat
  // responses (each paired dashboard hands its own agent coordinates +
  // project list back on the response) describe peers THIS machine is paired
  // with. When such a peer has no Device row here, create it now — the data
  // rides the one leg that provably works (our outbound heartbeat), so the
  // peer's projects become visible WITHOUT a manual "join network" on this
  // side and without either firewall opening an inbound port. Real-world
  // case: the Mac's agent heartbeats at the Windows dashboard (works), every
  // direct path back is firewalled, and the join-time mirrored row never
  // existed — the Mac saw NOTHING of Windows. Trust anchor is identical to
  // the join-time peer mirroring: the entry came from a dashboard this agent
  // was deliberately pointed at (pair code), keyed by the peer agent's
  // apiKey (the heartbeat credential).
  await registerRelayPeers(devices, localKeys, peerCachePromise)

  /** Fresh push data for a device: the direct heartbeat push store first;
   *  otherwise the local agent's peer-cache relay (one-way networks — the
   *  peer's projects came back on OUR agent's heartbeat response). Relayed
   *  hits are recorded into the push store; rows whose identity drifted
   *  (peer regenerated its agent key) are healed so later direct pulls can
   *  authenticate again. */
  const freshPushFor = async (device: {
    id: string; apiKey: string | null; ip: string | null; port: number; name: string
  }): Promise<DevicePush | null> => {
    const direct = S.pushStore.get(device.id)
    if (direct && Date.now() - direct.at < PUSH_STALE_MS) return direct
    try {
      const entries = await peerCachePromise
      if (!Array.isArray(entries) || entries.length === 0) return null
      const fresh = entries.filter((e) => Date.now() - (e?.at || 0) < PEER_CACHE_FRESH_MS)
      // Primary match: the peer's agent apiKey — the join flow stored the
      // same key into this row, so this is exact.
      let hit: RelayEntry | null =
        fresh.find((e) => e?.peer?.apiKey && e.peer.apiKey === device.apiKey) ?? null
      if (!hit && device.ip) {
        // Fallback (identity drift on the peer): exactly ONE fresh entry
        // whose reported address matches the row. The entry came from a
        // live heartbeat exchange, so its identity is the freshest truth —
        // heal the row's key/name when they differ.
        const byAddr = fresh.filter((e) =>
          e?.peer?.ip === device.ip && Number(e?.peer?.port) === device.port)
        if (byAddr.length === 1) {
          hit = byAddr[0]
          const newKey = String(hit.peer?.apiKey || '')
          if (newKey && newKey !== device.apiKey) {
            await db.device
              .update({
                where: { id: device.id },
                data: { apiKey: newKey, name: String(hit.peer?.name || device.name) },
              })
              .catch(() => {})
            console.log(
              `[remote-sync] healed device '${device.name}' identity from peer-cache relay`,
            )
          }
        }
      }
      if (hit && Array.isArray(hit.projects)) {
        recordDevicePush(device.id, hit.projects, device.ip || '', device.port)
        return S.pushStore.get(device.id) ?? null
      }
    } catch { /* relay unavailable */ }
    return null
  }

  const remoteResults = await Promise.allSettled(
    devices.map(async (device): Promise<{ ok: boolean; projects: any[] }> => {
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
          // freshPushFor additionally consults the local agent's peer-cache
          // relay when no direct push exists (both agent paths blocked, only
          // our agent's outbound heartbeat works).
          const push = await freshPushFor(device)
          if (push) {
            if (device.status !== 'online') {
              await db.device
                .update({ where: { id: device.id }, data: { status: 'online', lastSeen: new Date(push.at) } })
                .catch(() => {})
            }
            return { ok: true, projects: enrich(push.projects, true) }
          }
          if (device.status !== 'offline') {
            await db.device
              .update({ where: { id: device.id }, data: { status: 'offline' } })
              .catch(() => {})
          }
          return { ok: false, projects: [] }
        }
        // Agent answered — it's online regardless of project count.
        if (device.status !== 'online') {
          await db.device
            .update({ where: { id: device.id }, data: { status: 'online', lastSeen: new Date() } })
            .catch(() => {})
        }
        const projects: any[] = result.data?.projects || []
        // v1.12 agents attach their co-located DB state to the listing —
        // record it so the devices UI can explain a "0 projects" device.
        if (result.data?.meta) recordAgentMeta(device.id, result.data.meta)
        return { ok: true, projects: enrich(projects, true) }
      } catch {
        const push = await freshPushFor(device)
        if (push) {
          return { ok: true, projects: enrich(push.projects, true) }
        }
        if (device.status !== 'offline') {
          await db.device
            .update({ where: { id: device.id }, data: { status: 'offline' } })
            .catch(() => {})
        }
        return { ok: false, projects: [] }
      }
    })
  )

  const enrichedRemote = remoteResults.flatMap((r) =>
    r.status === 'fulfilled' ? r.value.projects : []
  )

  // Pull outcome per device row (reused by the duplicate merge below and
  // the repoUrl write-back leg): true = the row's apiKey authenticated with
  // the agent this cycle.
  const pullOkById = new Map<string, boolean>();
  devices.forEach((d, i) => {
    const r = remoteResults[i];
    pullOkById.set(d.id, r?.status === 'fulfilled' && !!r.value.ok);
  });

  // ---- merge duplicate device rows (same ip:port) ----
  // Two Device rows pointing at ONE machine (manual add + pairing, or two
  // pairing generations across an agent key rotation) each carry their own
  // key — at most one still authenticates. The stale twin can never update
  // again (its heartbeat 400s on the unknown key, its pulls 401), so the
  // machine shows TWO rows with at least one stuck at "0 projects" forever
  // (user report: two same-address rows at :3101, both 0). Merge each
  // address group into its best row and delete the losers BEFORE persisting
  // so the cached rows land under the survivor.
  {
    const loserToWinner = await mergeDuplicateDeviceRows(devices, pullOkById);
    if (loserToWinner.size > 0) {
      for (const p of enrichedRemote) {
        const winner = loserToWinner.get(String(p.deviceId || ''));
        if (winner) {
          p.deviceId = winner.id;
          p.deviceName = winner.name;
        }
      }
    }
  }

  // ---- prune zombie rows (devices whose listing we actually trust) -----
  // The persist step below mirrors the live listing, but rows whose ids the
  // agent no longer reports (project deleted and RE-CREATED on the device
  // → new id, same path) were never removed: the stale row then BLOCKS the
  // upsert of the fresh one (unique Project.path index) and every DB-keyed
  // consumer — versions (no badge), start/stop, pull — keeps hitting the
  // dead id. Prune per-device ONLY when that device's listing succeeded (or
  // a fresh push fallback stood in): a failed probe must preserve rows.
  {
    const liveIdsByDevice = new Map<string, Set<string>>()
    remoteResults.forEach((r, i) => {
      if (r.status !== 'fulfilled' || !r.value.ok) return
      const device = devices[i]
      const live = liveIdsByDevice.get(device.id) || new Set<string>()
      for (const p of r.value.projects) {
        if (p?.id) live.add(String(p.id))
      }
      liveIdsByDevice.set(device.id, live)
    })
    for (const [deviceId, live] of liveIdsByDevice) {
      try {
        const stale = await db.project.deleteMany({
          where: { deviceId, id: { notIn: [...live] } },
        })
        if (stale.count > 0) {
          console.log(`[remote-sync] pruned ${stale.count} zombie remote row(s) for device ${deviceId}`)
        }
      } catch (e) {
        console.error('[remote-sync] zombie prune failed for device', deviceId, e)
      }
    }
  }

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

  // ---- repoUrl write-back collection (direct leg of cross-dashboard
  // propagation) ----
  // A GitHub link cached HERE for a remote project whose home machine
  // reports none — collected now (BEFORE the dashboard-level fallback merge
  // below rewrites remote.repoUrl with cached values) and pushed to the agent
  // after the persist step, so it lands in the project's HOME stores and
  // propagates to every dashboard (user report: links added on one machine
  // never reached the other). Gates mirror the heartbeat repoSync leg:
  // repoUrl-capable agent only, empty agent value only, and a 10-min
  // freshness tolerance so a link CLEARED on the home machine (newer row)
  // is not resurrected. Pushes run ONLY for devices whose pull succeeded
  // this cycle (agent proven reachable — firewalled peers are covered by
  // the heartbeat-response repoSync leg instead, no timeout hammering).
  const repoPushByDevice = new Map<string, { id: string; repoUrl: string }[]>()
  {
    const cachedLinks = await db.project.findMany({
      where: { deviceId: { not: null } },
      select: { id: true, deviceId: true, repoUrl: true, updatedAt: true },
    })
    const linkById = new Map(cachedLinks.map((p) => [p.id, p]))
    for (const remote of dedupedRemote as any[]) {
      if (typeof remote.repoUrl !== 'string') continue // pre-repoUrl agent — cannot confirm
      if (isHttpsRepoUrl(remote.repoUrl)) continue // the home machine already has a link — it wins
      const cached = linkById.get(remote.id)
      if (!cached || !isHttpsRepoUrl(cached.repoUrl)) continue
      const agentUpdated = Date.parse(String(remote.updatedAt || '')) || 0
      const cachedUpdated = Date.parse(
        cached.updatedAt instanceof Date ? cached.updatedAt.toISOString() : String(cached.updatedAt)
      ) || 0
      if (agentUpdated - cachedUpdated > 10 * 60_000) continue // cleared on the home machine
      if (!pullOkById.get(String(remote.deviceId || ''))) continue // agent not proven reachable
      const list = repoPushByDevice.get(String(remote.deviceId)) || []
      if (list.length < 10) list.push({ id: String(remote.id), repoUrl: String(cached.repoUrl).trim() })
      repoPushByDevice.set(String(remote.deviceId), list)
    }
  }

  // ---- dashboard-level fields fallback (response path) ----
  // repoUrl/notes are DASHBOARD-level fields: the user may have set them
  // here while the device was unreachable (the PUT persists locally even
  // when the agent proxy 401s — "saved, device sync pending"). The persist
  // step below already refuses to blank the cached DB values, but the
  // RESPONSE serves dedupedRemote (the agent's raw listing) directly —
  // without this merge the card would visually lose the GitHub link even
  // though the DB still has it (agent-reported '' = "I don't know", not
  // "delete it"). Non-empty agent values still win (multi-dashboard
  // propagation from the project's home machine).
  {
    const cachedLevel = await db.project.findMany({
      where: { deviceId: { not: null } },
      select: { id: true, repoUrl: true, notes: true },
    })
    const cachedById = new Map(cachedLevel.map((p) => [p.id, p]))
    for (const remote of dedupedRemote as any[]) {
      const cached = cachedById.get(remote.id)
      if (!cached) continue
      // Same https-only gate as the persist step: an agent value that fails
      // it is treated as "unknown" so the card keeps the locally-set link
      // (a non-https string must never flow into a rendered href).
      const agentRepoUrl = isHttpsRepoUrl(remote.repoUrl) ? remote.repoUrl.trim() : ''
      if (!agentRepoUrl && cached.repoUrl) remote.repoUrl = cached.repoUrl
      const agentNotes = typeof remote.notes === 'string' ? remote.notes.trim() : ''
      if (!agentNotes && cached.notes) remote.notes = cached.notes
    }
  }

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
      // NEW agents with the repoUrl column report '' when the home machine
      // never had a link. An agent-reported '' would clobber a link that was
      // set HERE before the device upgraded its agent (the dashboard PUT
      // persisted it locally even when the proxy call failed). Treat '' as
      // "agent doesn't know" → keep the cached value; non-empty strings flow
      // through normally (multi-dashboard propagation) — BUT only when they
      // pass the https-only gate (isHttpsRepoUrl): a hostile or legacy
      // non-https value is discarded like '' so it never reaches the DB (and
      // from there the rendered card href — stored-XSS chain, see above).
      const agentRepoUrlRaw = typeof remote.repoUrl === 'string' ? remote.repoUrl.trim() : undefined
      const agentRepoUrl =
        agentRepoUrlRaw === '' ? undefined : isHttpsRepoUrl(agentRepoUrlRaw) ? agentRepoUrlRaw : undefined
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

  // ---- repoUrl write-back execution (direct leg) ----
  // PUT /projects/:id { repoUrl } on the agent — its PUT handler writes the
  // link into the project's home stores (co-located dashboard DB row first,
  // its own agent-DB row second). Best-effort: a failed push is simply
  // retried on the next sync (the diff only disappears once the agent
  // actually reports the link, so this converges instead of looping).
  if (repoPushByDevice.size > 0) {
    await Promise.allSettled(
      [...repoPushByDevice.entries()].map(async ([deviceId, entries]) => {
        const device = devices.find((d) => String(d.id) === deviceId)
        if (!device) return
        let pushed = 0
        for (const e of entries) {
          const r = await proxyToAgent(
            { ip: device.ip, port: device.port, apiKey: device.apiKey || '' },
            `/projects/${e.id}`,
            'PUT',
            { repoUrl: e.repoUrl },
            6000,
          )
          if (r.ok) pushed++
        }
        if (pushed > 0) {
          console.log(
            `[remote-sync] pushed ${pushed} repoUrl override(s) to device '${device.name}'`,
          )
          logActivity({
            type: 'config_change',
            level: 'success',
            message: `GitHub links synced to '${device.name}'`,
            deviceId: device.id,
            deviceName: device.name,
                       detail: `${pushed} project link(s) set on this dashboard were propagated to the device`,
          })
        }
      }),
    )
  }

  console.log(
    `[remote-sync] completed in ${Date.now() - startedAt}ms: ${devices.length} device(s), ${dedupedRemote.length} remote project(s)`
  )
  return { at: Date.now(), projects: dedupedRemote, gen: startedGen }
}

function startSync(): Promise<RemoteSyncResult> {
  if (!S.inflight) {
    S.inflight = syncRemoteProjects().finally(() => {
      S.inflight = null
    })
  }
  return S.inflight
}

/**
 * SWR accessor used by GET /api/projects.
 *  - fresh cache → instant return, no network
 *  - stale cache → instant return + background refresh
 *  - no cache    → await the first sync (fast: online <1s, offline 1.5s)
 * `force` bypasses the cache entirely (manual sync / post-mutation).
 *
 * Generation handling: a force refresh that joins an in-flight sync started
 * BEFORE the invalidation would await and cache a PRE-mutation snapshot —
 * the caller then sees stale data labeled fresh. When that happens we run
 * one more sync, which now starts under the current generation (bounded:
 * each iteration either returns a current-generation result or starts one).
 */
export async function getRemoteProjectsCached(force = false): Promise<any[]> {
  if (force) {
    invalidateRemoteProjectCache()
    const targetGeneration = S.syncGeneration
    let result = await startSync()
    if (result.gen < targetGeneration) {
      result = await startSync()
    }
    S.cache = result
    return result.projects
  }
  if (S.cache) {
    const age = Date.now() - S.cache.at
    if (age >= FRESH_MS) {
      // Stale — serve immediately, refresh in the background. Errors are
      // swallowed on purpose: the next poll retries, and the caller already
      // has usable (slightly old) data in hand.
      startSync().then((fresh) => { S.cache = fresh }).catch(() => {})
    }
    return S.cache.projects
  }
  // Cold path: block once so the very first paint includes remote projects.
  const result = await startSync()
  S.cache = result
  return result.projects
}

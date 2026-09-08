/**
 * Remote agent health/version probing — shared by /api/devices (device sheet
 * badges) and the remote pull route (actionable "too old" errors).
 *
 * WHY: users pair machines whose agents were started BEFORE a `git pull`
 * (git pull hot-reloads the dashboard, NOT the spawned agent process). The
 * symptoms then look unrelated — "pull says agent too old", "process exited
 * immediately" with no reason, "my Mac can't see the Windows machine's
 * projects" (the heartbeat project-push feature only exists in new agents)
 * — and nothing on the dashboard said WHICH machine was stale. Probing the
 * agent's OPEN /api/agent/health endpoint surfaces the running version and
 * missing feature markers so the devices page can point at the exact
 * machine that needs `git pull + agent restart`.
 *
 * Semantics: `outdated` is only ever TRUE on positive evidence (health
 * answered, payload looks like our agent, feature marker missing). An
 * unreachable (firewalled) agent is never called outdated — it may be
 * perfectly current and just refusing inbound connections.
 */

export interface RemoteAgentHealth {
  /** Running agent's self-reported version ('' when unknown). */
  version: string
  /** True ONLY with positive evidence: reachable + our agent + missing
   *  feature marker. False when unreachable / foreign / complete. */
  outdated: boolean
  /** Which feature is missing when outdated; probe status otherwise. */
  why: string
  /** Health endpoint answered. */
  reachable: boolean
  probedAt: number
}

const CACHE_TTL_MS = 60_000
const healthCache = new Map<string, RemoteAgentHealth>()

/** POSITIVE IDENTIFICATION: the payload must look like OUR agent's health
 *  (status:'ok' + string name/uptime/version) before any marker is read —
 *  otherwise a user project that happens to answer 200 JSON on the same
 *  port would be misreported as "an outdated agent". */
function looksLikeOurAgent(d: Record<string, unknown>): boolean {
  return (
    d.status === 'ok' &&
    typeof d.name === 'string' &&
    typeof d.uptime === 'number' &&
    typeof d.version === 'string'
  )
}

export async function probeRemoteAgentHealth(
  device: { id: string; ip: string | null; port: number }
): Promise<RemoteAgentHealth> {
  const cached = healthCache.get(device.id)
  if (cached && Date.now() - cached.probedAt < CACHE_TTL_MS) return cached

  let result: RemoteAgentHealth
  if (!device.ip || !device.port) {
    result = { version: '', outdated: false, why: 'no-address', reachable: false, probedAt: Date.now() }
  } else {
    try {
      const res = await fetch(`http://${device.ip}:${device.port}/api/agent/health`, {
        signal: AbortSignal.timeout(2500),
      })
      const data = res.ok ? await res.json().catch(() => null) : null
      const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
      if (d && looksLikeOurAgent(d)) {
        // Feature markers — a MISSING field means the process is executing
        // pre-upgrade code (mirrors agent-lifecycle's local-agent check).
        let why = ''
        if (!('dashboardDb' in d)) why = 'dashboard-DB serving'
        else if (!('pushProjects' in d)) why = 'heartbeat project push'
        else if (!('smartIp' in d)) why = 'smart LAN IP detection'
        result = {
          version: String(d.version ?? ''),
          outdated: why !== '',
          why,
          reachable: true,
          probedAt: Date.now(),
        }
      } else {
        result = { version: '', outdated: false, why: 'not-our-agent', reachable: true, probedAt: Date.now() }
      }
    } catch {
      result = { version: '', outdated: false, why: 'unreachable', reachable: false, probedAt: Date.now() }
    }
  }
  healthCache.set(device.id, result)
  return result
}

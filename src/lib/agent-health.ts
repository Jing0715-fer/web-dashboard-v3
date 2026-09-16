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
  /** Agent found its co-located dashboard DB? (null = pre-1.12 agent or
   *  unreachable — the field didn't exist / couldn't be read.) */
  dashboardDb: boolean | null
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
    result = { version: '', outdated: false, why: 'no-address', reachable: false, dashboardDb: null, probedAt: Date.now() }
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
        // v1.5+ fix marker: child-env sanitization + pull origin self-heal.
        else if (!('envSanitize' in d)) why = 'child-env sanitization + pull origin self-heal'
        // v1.6 marker: peer project relay (heartbeat-response peer projects
        // served at /api/agent/peer-cache — one-way-network visibility).
        else if (!('peerRelay' in d)) why = 'peer project relay'
        // v1.7 marker: dual-store repoUrl merge + pull cross-store heal.
        else if (!('repoMerge' in d)) why = 'dual-store repoUrl merge + pull heal'
        // v1.8 marker: branch switch pull.
        else if (!('branchSwitch' in d)) why = 'branch switch pull (git checkout + pull)'
        // v1.9 marker: pull-body repoUrl (cross-machine origin wire-up).
        else if (!('pullRepoUrl' in d)) why = 'pull-body repoUrl (cross-machine origin wire-up)'
        // v1.10 marker: agent self-update.
        else if (!('selfUpdate' in d)) why = 'agent self-update (heartbeat-signal pull + self-respawn)'
        // v1.11 marker: repoSync overrides.
        else if (!('repoSync' in d)) why = 'repoSync overrides (cross-dashboard repoUrl propagation)'
        // v1.12 marker: hardened dashboard-DB detection + lazy re-probe.
        else if (!('dashDbLazy' in d)) why = 'hardened dashboard-DB detection (.env-aware + lazy re-probe)'
        // v1.13 marker: dashboard-triggered agent restart (POST /api/agent/restart).
        else if (!('restart' in d)) why = 'remote agent restart (POST /api/agent/restart)'
        // v1.14 marker: LLM-driven remote project analysis. The TS reference
        // agent lacked /api/agent/analyze-project until v1.14 — remote
        // analysis against such a device failed with a bare "Not found".
        else if (!('autoDebug' in d)) why = 'remote project analysis (/api/agent/analyze-project)'
        // v1.15 marker: dashboard self-guard — the agent refuses to analyze
        // or start the co-located dashboard's own directory. Without it, a
        // remote "fetch environments" on the dashboard's own project kills
        // the live dashboard server on that machine.
        else if (!('selfGuard' in d)) why = 'dashboard self-analysis protection (self-kill guard)'
        result = {
          version: String(d.version ?? ''),
          outdated: why !== '',
          why,
          reachable: true,
          // Co-located DB state (v1.12+ agents): a healthy agent on a
          // dashboard machine that reports dashboardDb:false is the
          // "device online but 0 projects" smoking gun.
          dashboardDb: typeof d.dashboardDb === 'boolean' ? d.dashboardDb : null,
          probedAt: Date.now(),
        }
      } else {
        result = { version: '', outdated: false, why: 'not-our-agent', reachable: true, dashboardDb: null, probedAt: Date.now() }
      }
    } catch {
      result = { version: '', outdated: false, why: 'unreachable', reachable: false, dashboardDb: null, probedAt: Date.now() }
    }
  }
  healthCache.set(device.id, result)
  return result
}

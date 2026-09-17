import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { existsSync, openSync, closeSync } from 'fs';
import { spawn, execSync, execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { logActivity } from '@/lib/activity';
import { registerMeshServicePort } from '@/lib/ports';

/**
 * Local agent lifecycle — shared by the mesh pairing routes AND the server
 * boot instrumentation, so the co-located agent service
 * (mini-services/agent*) is always running / up-to-date on dashboard
 * machines without any manual start.sh step.
 */

// Agent service directories shipped with the project (platform variants).
export const AGENT_DIRS = ['agent', 'agent-linux', 'agent-macos', 'agent-win', 'agent-windows'];

/**
 * apiKeys that were accidentally COMMITTED to the repo: the author's own
 * machine identity in mini-services/agent-linux/agent-config.json was
 * git-tracked before the .gitignore rule (ignore rules do NOT apply to
 * already-tracked files), so every clone shipped it. ensureLocalAgent's
 * identity-adoption then handed that SAME key to each machine's local
 * agent — paired machines ended up sharing one identity, and each side's
 * localAgentApiKeys() filtered the PEER'S Device row out of /api/devices
 * and the project sync as "self" ("paired successfully but we can't see
 * each other, 0 projects"). Any config carrying one of these keys is
 * NOT this machine's identity: regenerate a fresh one instead of adopting.
 */
const POISONED_AGENT_KEYS = new Set(['remote-device-3101-key']);

export interface LocalAgentInfo {
  port: number;
  apiKey: string;
  name: string;
  running: boolean;
  dir: string;
}

export function existsSyncSafe(p: string): boolean {
  try { return existsSync(p); } catch { return false; }
}

/** Append-mode fd for the agent log (never fails the request — stdout is
 *  an acceptable fallback). */
function openSyncAppend(logFile: string): number {
  try { return openSync(logFile, 'a'); } catch { return 1; }
}

/**
 * Ranked LAN IP detection — v2 (gateway-subnet aware).
 *
 * os.networkInterfaces() order is arbitrary, and plain range ranking is NOT
 * enough on multi-NIC machines: a VMware VMnet8 adapter (192.168.253.1) and
 * the real WLAN (192.168.101.47) are BOTH 192.168.0.0/16, so the virtual
 * adapter used to win the tie by enumeration order. The user then advertises
 * an address no other device can ever reach ("paired but we can't see each
 * other"). v2 adds two decisive signals:
 *
 *   1. DEFAULT-GATEWAY SUBNET — the NIC that actually routes to the internet
 *      shares a subnet with the default gateway; virtual host-only adapters
 *      never do. Parsed once per 60s from the OS route table.
 *   2. VIRTUAL-ADAPTER NAME PENALTY — vmware/vmnet/virtualbox/vEthernet/
 *      docker/wsl/tap/tun/... get demoted below every physical NIC.
 *
 * Range ranking stays as a tie-breaker (192.168 > 10 > 172.16 > CGNAT).
 * Excluded entirely:
 *   - 198.18.0.0/15 — benchmark range hijacked by fake-IP VPN modes
 *   - 169.254.0.0/16 — link-local
 *
 * `preferIp` (optional): an address this machine was PROVABLY reached on
 * (e.g. the Host header IP of the current browser session) — ranked first
 * when present among the candidates.
 */
export interface LanIpCandidate {
  address: string;
  interface: string;
  score: number;
}

const VIRTUAL_IFACE_RE =
  /vmware|vmnet|virtualbox|vbox|hyper-?v|vethernet|docker|wsl|tap|tun|tailscale|zerotier|radmin|parallels|vnic|awdl|bridge|loopback|anydesk|clash|surge|wireguard|wg\d|llw/i;

function parseGatewayIp(text: string): string | null {
  // Windows `route print -4`: "0.0.0.0  0.0.0.0  <gateway>  <iface-ip>  <metric>"
  const mWin = text.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})/m);
  if (mWin) return mWin[1];
  // macOS `route -n get default`: "gateway: 192.168.1.1"
  const mMac = text.match(/gateway:\s*(\d{1,3}(?:\.\d{1,3}){3})/i);
  if (mMac) return mMac[1];
  // Linux `ip route show default`: "default via 192.168.1.1 dev eth0"
  const mLin = text.match(/via\s+(\d{1,3}(?:\.\d{1,3}){3})/);
  if (mLin) return mLin[1];
  // Linux `route -n`: "0.0.0.0  192.168.1.1  0.0.0.0  UG ..."
  const mLin2 = text.match(/^\s*0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+0\.0\.0\.0\s+UG/m);
  if (mLin2) return mLin2[1];
  return null;
}

let gatewayCache: { ip: string | null; at: number } | null = null;

/** Default gateway IP (the physical LAN's router), cached 60s. */
function defaultGateway(): string | null {
  if (gatewayCache && Date.now() - gatewayCache.at < 60_000) return gatewayCache.ip;
  // SILENT SPAWN: never shell out (`cmd.exe /c route print …`) — the
  // dashboard server often runs detached from any console (supervisor,
  // scheduled start), and every cmd.exe child then allocates a console
  // WINDOW that flashes on the user's desktop. Direct argv + windowsHide
  // (CREATE_NO_WINDOW) keeps the probe invisible on Windows and behaves
  // identically on Unix.
  const run = (file: string, argv: string[]): string => {
    try { return execFileSync(file, argv, { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString(); }
    catch { return ''; }
  };
  let ip: string | null = null;
  try {
    if (process.platform === 'win32') {
      ip = parseGatewayIp(run('route', ['print', '-4', '0.0.0.0']));
    } else if (process.platform === 'darwin') {
      ip = parseGatewayIp(run('route', ['-n', 'get', 'default']));
    } else {
      ip = parseGatewayIp(run('ip', ['route', 'show', 'default'])) || parseGatewayIp(run('route', ['-n']));
    }
  } catch { /* no route table access */ }
  gatewayCache = { ip, at: Date.now() };
  return ip;
}

function sameSubnet(a: string, b: string, mask: string): boolean {
  const m = mask.split('.').map(Number);
  const A = a.split('.').map(Number);
  const B = b.split('.').map(Number);
  if (m.length !== 4 || A.length !== 4 || B.length !== 4 || m.some((v) => !Number.isFinite(v))) return false;
  return A.every((v, i) => (v & m[i]) === (B[i] & m[i]));
}

/** Range tie-breaker (lower = better). */
function rangeRank(ip: string): number {
  const [a, b] = ip.split('.').map(Number);
  if (a === 192 && b === 168) return 0;               // typical home/office LAN
  if (a === 10) return 1;                             // larger private nets
  if (a === 172 && b >= 16 && b <= 31) return 2;      // docker / corp
  if (a === 100 && b >= 64 && b <= 127) return 3;     // CGNAT (Tailscale & friends)
  return 4;
}

export function lanIpCandidatesDetailed(preferIp?: string): LanIpCandidate[] {
  const gateway = defaultGateway();
  const out: LanIpCandidate[] = [];
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (!i || i.family !== 'IPv4' || i.internal) continue;
      const [a, b] = i.address.split('.').map(Number);
      if (a === 198 && (b === 18 || b === 19)) continue; // fake-IP VPN
      if (a === 169 && b === 254) continue;              // link-local
      if (a === 0) continue;                             // 0.0.0.0 bind-all artifact
      let score = -rangeRank(i.address);               // range tie-breaker
      if (gateway && sameSubnet(i.address, gateway, i.netmask || '255.255.255.0')) score += 100;
      if (VIRTUAL_IFACE_RE.test(name)) score -= 50;    // virtual NIC demotion
      if (preferIp && preferIp === i.address) score += 200;
      out.push({ address: i.address, interface: name, score });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

export function lanIpCandidates(preferIp?: string): string[] {
  return lanIpCandidatesDetailed(preferIp).map((c) => c.address);
}

export function lanIp(preferIp?: string): string {
  return lanIpCandidates(preferIp)[0] || '127.0.0.1';
}

export async function probeAgent(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Strict health probe: the response must be JSON that positively looks like
 * OUR mesh agent's health payload. Used when scanning *neighbouring* ports —
 * a user project that happens to listen there and answers 200 must never be
 * adopted as "the local agent" (its port would then be targeted by agent
 * restarts, killing the user's process).
 */
async function probeAgentHealthShape(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return false;
    return looksLikeOurAgent(data as Record<string, unknown>);
  } catch {
    return false;
  }
}

/**
 * True when the RUNNING agent on this port predates features the dashboard
 * now depends on:
 *   - `dashboardDb` — co-located dashboard-DB project serving (without it
 *     peers see the device online with 0 projects forever);
 *   - `pushProjects` — heartbeat pushes the project list to paired
 *     dashboards (without it a firewalled peer can never see this
 *     machine's projects);
 *   - `smartIp` — gateway-subnet-aware LAN IP detection (without it the
 *     agent keeps self-reporting virtual-adapter addresses like VMware
 *     VMnet 192.168.253.x, which poisons the peer's Device row).
 * New agents always include ALL markers; a missing field means the process
 * is executing pre-upgrade code — `git pull` hot-reloads the dashboard but
 * NOT the spawned agent process, so it must be respawned.
 *
 * POSITIVE IDENTIFICATION GUARD: before any of the markers are even looked
 * at, the response must look like OUR agent's health payload (status:'ok' +
 * string name + number uptime + string version). Without this guard, any
 * *user project* that happens to run on a scanned port (3100-3105) and
 * answers 200 JSON to /api/agent/health — a Next.js API route, a status
 * endpoint, any catch-all returning JSON — was misread as "an outdated
 * agent" and SIGTERMed by stopAgentOnPort. That killed real user processes
 * that the LLM had legitimately assigned to 310x ports (the usedPorts hint
 * only excluded 3000 and 3100). Now a foreign 200-JSON response is simply
 * "not our agent" → no restart, no kill.
 */
function looksLikeOurAgent(d: Record<string, unknown>): boolean {
  return (
    d.status === 'ok' &&
    typeof d.name === 'string' &&
    typeof d.uptime === 'number' &&
    typeof d.version === 'string'
  );
}

async function agentOutdated(port: number): Promise<{ outdated: boolean; why: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { outdated: false, why: '' }; // can't tell — do NOT restart
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return { outdated: false, why: '' };
    const d = data as Record<string, unknown>;
    // Foreign process on a scanned port — NOT our agent, never touch it.
    if (!looksLikeOurAgent(d)) return { outdated: false, why: '' };
    if (!('dashboardDb' in d)) return { outdated: true, why: 'dashboard-DB serving' };
    if (!('pushProjects' in d)) return { outdated: true, why: 'heartbeat project push' };
    if (!('smartIp' in d)) return { outdated: true, why: 'smart LAN IP detection' };
    // v1.5+ fix markers: child-process env sanitization (TURBOPACK=1 leaked
    // from the dashboard's own `next dev` tree made child projects with
    // --webpack dev scripts die instantly) + pull origin self-heal.
    if (!('envSanitize' in d)) return { outdated: true, why: 'child-env sanitization + pull origin self-heal' };
    // v1.6 marker: peer project relay — the agent caches peer coordinates +
    // project lists from heartbeat RESPONSES and serves them at
    // /api/agent/peer-cache (one-way-firewall project visibility). Without
    // the respawn the relayed sync silently degrades to the pre-relay
    // behavior on machines that pulled new dashboard code.
    if (!('peerRelay' in d)) return { outdated: true, why: 'peer project relay' };
    // v1.7 marker: dual-store listing merge + pull cross-store repoUrl heal —
    // without it a repoUrl set on the home dashboard never reaches peers
    // (remote cards lose the GitHub link) and remote pulls fail with
    // "No 'origin' remote is configured" even though the link exists.
    if (!('repoMerge' in d)) return { outdated: true, why: 'dual-store repoUrl merge + pull heal' };
    // v1.8 marker: branch switch pull — GET /projects/:id/branches +
    // { branch } on pull (git checkout + pull). Without it the switch-branch
    // picker 404s on remote projects and branch pulls degrade to plain pulls.
    if (!('branchSwitch' in d)) return { outdated: true, why: 'branch switch pull (git checkout + pull)' };
    // v1.9 marker: pull-body repoUrl — the CALLING dashboard sends its saved
    // GitHub link with every remote pull and the agent wires a missing
    // 'origin' from it. Without it, remote projects whose repoUrl lives only
    // in the calling dashboard's DB (the normal cross-machine case) still
    // fail with "No 'origin' remote is configured".
    if (!('pullRepoUrl' in d)) return { outdated: true, why: 'pull-body repoUrl (cross-machine origin wire-up)' };
    // v1.10 marker: agent self-update — the agent accepts updateSignal from
    // heartbeat responses (and POST /self-update) and pulls + respawns
    // ITSELF onto new code. Without it the agent stays on whatever code was
    // running when the machine last pulled manually.
    if (!('selfUpdate' in d)) return { outdated: true, why: 'agent self-update (heartbeat-signal pull + self-respawn)' };
    // v1.11 marker: repoSync — the agent applies repoSync overrides that
    // ride heartbeat RESPONSES (links a peer dashboard cached for our
    // projects while this machine was unreachable/firewalled). Without it,
    // GitHub links edited on another dashboard never reach the projects'
    // home stores.
    if (!('repoSync' in d)) return { outdated: true, why: 'repoSync overrides (cross-dashboard repoUrl propagation)' };
    // v1.12 marker: hardened dashboard-DB detection — multi-candidate
    // (.env DATABASE_URL-aware, __dirname-anchored) + lazy re-probe + agentMeta
    // reporting. Without it, an agent whose co-located dashboard keeps its DB
    // anywhere but <repo>/db/custom.db (e.g. a relative .env URL, which Prisma
    // resolves against prisma/) serves ZERO projects to every peer forever.
    if (!('dashDbLazy' in d)) return { outdated: true, why: 'hardened dashboard-DB detection (.env-aware + lazy re-probe)' };
    // v1.13 marker: remote agent restart — POST /api/agent/restart respawns
    // the agent on dashboard request. Without it the device panel's Restart
    // button 404s and stale agents still need a manual restart on that
    // machine (git pull hot-reloads the dashboard, not the spawned agent).
    if (!('restart' in d)) return { outdated: true, why: 'remote agent restart (POST /api/agent/restart)' };
    // v1.14 marker: LLM-driven remote project analysis — POST
    // /api/agent/analyze-project. The TS reference agent lacked the endpoint
    // until v1.14: remote analysis against such an agent answered a bare
    // "Not found" (the user-facing bug this marker now detects + heals).
    if (!('autoDebug' in d)) return { outdated: true, why: 'remote project analysis (/api/agent/analyze-project)' };
    // v1.15 marker: dashboard self-guard — the agent refuses to analyze or
    // start the co-located dashboard's own directory. Without it, a remote
    // "fetch environments" against the dashboard's own project KILLS the
    // live dashboard server on that machine (verify-spawn races the shared
    // .next + SQLite). Respawn so the guard takes over after a git pull.
    if (!('selfGuard' in d)) return { outdated: true, why: 'dashboard self-analysis protection (self-kill guard)' };
    // v1.16 marker: silent background spawns — every probe/spawn the agent
    // performs (netstat port checks, git fetch, taskkill, project starts)
    // runs with CREATE_NO_WINDOW + direct argv. Without it, a console-less
    // agent flashed a cmd.exe window on the desktop every ~30s poll and
    // during every git self-update fetch.
    if (!('silentSpawns' in d)) return { outdated: true, why: 'silent background spawns (no console-window flashes)' };
    // v1.17 marker: conflict-aware pull — when a pull is blocked by local
    // changes the agent answers 409 { conflict, modified, untracked } and
    // accepts { strategy: "stash" | "force" } resolutions. Without it the
    // dashboard's conflict dialog can never appear for remote projects and
    // the user is stuck on git's raw "would be overwritten" error.
    if (!('pullConflict' in d)) return { outdated: true, why: 'conflict-aware pull (stash or discard local changes)' };
    return { outdated: false, why: '' };
  } catch {
    return { outdated: false, why: '' };
  }
}

/**
 * PIDs currently LISTENING on `port`. Cross-platform best-effort:
 *   darwin / linux: `lsof -ti tcp:PORT` (falls back to `ss -tlnp` parsing)
 *   win32:         `netstat -ano | findstr ":PORT "` (LISTENING lines)
 * The port's listener was just health-verified to BE our agent, so killing
 * the owning pid(s) is surgical — no command-line pattern guessing that
 * would miss agents started via start.sh (whose argv lacks the full path).
 */
function portListenerPids(port: number): number[] {
  const pids = new Set<number>();
  const addAll = (text: string, re: RegExp) => {
    for (const m of text.matchAll(re)) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n !== process.pid) pids.add(n);
    }
  };
  try {
    if (process.platform === 'win32') {
      // SILENT SPAWN: direct `netstat -ano` argv + windowsHide — the old
      // `cmd.exe /c netstat | findstr` pipeline flashed a console window
      // on the desktop every supervisor tick (and the lsof/ss probes above
      // would have flashed too before failing — they don't exist on
      // Windows, so they now run on non-Windows only).
      const ns = execFileSync('netstat', ['-ano'], { encoding: 'utf-8', timeout: 3000, windowsHide: true }).toString();
      for (const line of ns.split('\n')) {
        if (!line.includes(`:${port} `) || !line.includes('LISTENING')) continue;
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (Number.isFinite(pid) && pid > 0) pids.add(pid);
      }
    } else {
      try {
        addAll(execSync(`lsof -ti tcp:${port} 2>/dev/null`, { timeout: 2000 }).toString(), /(\d+)/g);
      } catch { /* no lsof (common on linux) or nothing listening */ }
      if (pids.size === 0) {
        try {
          const ss = execSync('ss -tlnp 2>/dev/null', { timeout: 2000 }).toString();
          for (const line of ss.split('\n')) {
            if (!line.includes(`:${port} `)) continue;
            addAll(line, /pid=(\d+)/g);
          }
        } catch { /* no ss / nothing listening */ }
      }
    }
  } catch { /* nothing listening */ }
  return [...pids];
}

/** Stop the agent listening on `port` and wait for the port to actually
 * free, so the respawn below doesn't race into EADDRINUSE. */
async function stopAgentOnPort(port: number): Promise<void> {
  for (const pid of portListenerPids(port)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  for (let i = 0; i < 16; i++) {
    if (!(await probeAgent(port))) return; // listener is gone
    await new Promise((r) => setTimeout(r, 250));
  }
  // Still answering after 4s — force kill, then give the OS a beat.
  for (const pid of portListenerPids(port)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await new Promise((r) => setTimeout(r, 300));
}

/**
 * Auto-detect the agent service on this machine.
 * Reads agent-config.json (written by the agent on startup) from each
 * mini-services/agent-* dir, prefers a live (health-probe OK) instance.
 *
 * If the recorded port is dead but an agent is listening on a NEIGHBOURING
 * port (started manually with --port, stale .agent-session.env, …), the scan
 * finds it: all probes run in parallel and closed ports reject in ~1ms, so
 * the sweep adds no latency to the dead-config case.
 */
const AGENT_SCAN_PORTS = [3100, 3101, 3102, 3103, 3104, 3105];

export async function detectLocalAgent(): Promise<LocalAgentInfo | null> {
  const root = process.cwd();
  const candidates: Array<Omit<LocalAgentInfo, 'running'>> = [];
  for (const dir of AGENT_DIRS) {
    const base = path.join(root, 'mini-services', dir);
    try {
      const cfg = JSON.parse(await fs.readFile(path.join(base, 'agent-config.json'), 'utf-8'));
      let port = Number(cfg.port) || 3100;
      // start.sh writes the actually-used port here (agent-config.json may
      // hold the default 3100 when a different port was picked).
      try {
        const envTxt = await fs.readFile(path.join(base, '.agent-session.env'), 'utf-8');
        const m = envTxt.match(/^AGENT_PORT=(\d+)\s*$/m);
        if (m) port = parseInt(m[1], 10);
      } catch { /* no session file */ }
      if (cfg.apiKey) {
        candidates.push({
          port,
          apiKey: String(cfg.apiKey),
          name: String(cfg.name || os.hostname()),
          dir,
        });
      }
    } catch { /* no config in this dir */ }
  }
  if (candidates.length === 0) return null;
  for (const c of candidates) {
    if (await probeAgent(c.port)) return { ...c, running: true };
  }
  // Recorded port is dead — sweep the usual agent ports (and any other
  // candidates' ports) for a live agent before declaring "not running".
  // A plain 200 is NOT enough here: a user project the LLM put on a 310x
  // port would also answer 200 — require OUR agent's health shape.
  const scanPorts = [...new Set([...AGENT_SCAN_PORTS, ...candidates.map((c) => c.port)])];
  const alive = await Promise.all(
    scanPorts.map(async (p) => ((await probeAgentHealthShape(p)) ? p : null)),
  );
  const livePort = alive.find((p) => p != null) ?? null;
  if (livePort != null) return { ...candidates[0], port: livePort, running: true };
  return { ...candidates[0], running: false };
}

/** Best-effort merge-patch of an agent dir's agent-config.json. */
async function patchAgentConfig(
  dir: string,
  mutate: (cfg: Record<string, unknown>) => Record<string, unknown>,
): Promise<boolean> {
  try {
    const cfgPath = path.join(process.cwd(), 'mini-services', dir, 'agent-config.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf-8'));
    await fs.writeFile(cfgPath, JSON.stringify(mutate(cfg), null, 2), 'utf-8');
    return true;
  } catch { return false; }
}

/**
 * Add a dashboard URL to an agent dir's persisted heartbeat target list
 * (new agents heartbeat to ALL of them; the legacy single `dashboardUrl`
 * field is also refreshed for pre-upgrade agents). Takes effect at the next
 * agent boot when the agent is not currently running.
 */
export async function addPersistedHeartbeatTarget(dir: string, target: string): Promise<void> {
  await patchAgentConfig(dir, (cfg) => {
    const list = Array.isArray(cfg.dashboardUrls) ? cfg.dashboardUrls.map(String) : [];
    return {
      ...cfg,
      dashboardUrl: target,
      dashboardUrls: [...new Set([...list, target])].slice(0, 8),
      updatedAt: new Date().toISOString(),
    };
  });
}

/**
 * Start (or verify) the LOCAL agent service — shared by the 'ensure-agent'
 * action, the join flow, and the boot instrumentation, so joining never
 * requires a separate "start the agent first" step (one click fewer for
 * the user) and a `git pull` upgrade actually reaches the long-running
 * agent process.
 *
 * Returns the agent's coordinates (port / apiKey / name / dir) plus whether
 * it was just started or auto-upgraded.
 */
// Stale-agent crash-loop guard: on machines without bun, ensureLocalAgent
// spawns the PLATFORM BUNDLE (mini-services/agent-*/agent.js), which may lag
// the marker list (it is hand-maintained). Without a guard the supervisor's
// 60s ensure loop would kill & respawn the SAME old bundle forever. After a
// respawn the port is tolerated for 30 minutes — long enough to prove the
// spawned code was already the newest on disk; once a respawned agent
// reports every marker (real upgrade landed) the tolerance clears itself.
const toleratedStaleAgents = new Map<number, number>(); // port → tolerated-until
const TOLERATE_STALE_TTL_MS = 30 * 60 * 1000;

export async function ensureLocalAgent(): Promise<
  | { ok: true; agent: LocalAgentInfo; started: boolean; restarted: boolean }
  | { ok: false; error: string }
> {
  const detected = await detectLocalAgent();

  // Auto-upgrade: a long-running agent started BEFORE a code pull keeps
  // executing the OLD code (git pull only hot-reloads the dashboard, not
  // the spawned agent process). Old agents miss feature markers in their
  // health response (dashboardDb / pushProjects) → kill & respawn so the
  // new code takes over.
  let restarted = false;
  let restartReason = '';
  if (detected?.running) {
    const check = await agentOutdated(detected.port);
    const toleratedUntil = toleratedStaleAgents.get(detected.port) || 0;
    if (check.outdated && Date.now() < toleratedUntil) {
      // Respawned recently and STILL stale → the newest code on this disk
      // lacks the markers (platform bundle). Leave it running; retry in
      // ~30 min or after the next git pull.
    } else if (check.outdated) {
      await stopAgentOnPort(detected.port);
      restarted = true;
      restartReason = `old agent lacked ${check.why}`;
      toleratedStaleAgents.set(detected.port, Date.now() + TOLERATE_STALE_TTL_MS);
    } else {
      // All markers present — clear any stale tolerance.
      toleratedStaleAgents.delete(detected.port);
      if (detected.apiKey && POISONED_AGENT_KEYS.has(detected.apiKey)) {
        // Running with the repo-committed SHARED key: every clone of the
        // repo runs the same identity — kill it so the spawn path below
        // rewrites a fresh per-machine key (pairing rows refresh at the
        // next join / heartbeat).
        await stopAgentOnPort(detected.port);
        restarted = true;
        restartReason = 'repo-committed shared key (identity collision across clones)';
      }
    }
    if (restarted) {
      logActivity({
        type: 'pair',
        level: restartReason.includes('shared key') ? 'warn' : 'info',
        message: restartReason.includes('shared key')
          ? 'Local agent identity regenerated (unique key)'
          : 'Local agent restarted (code upgrade)',
        detail: `port ${detected.port} · ${restartReason}`,
      });
    }
  }

  if (detected?.running && !restarted) {
    // Already-running agent (typical boot path): its port is the dashboard's
    // own mesh infrastructure — make sure the stray sweeper knows.
    registerMeshServicePort(detected.port);
    return { ok: true, agent: detected, started: false, restarted };
  }

  // Pick the agent directory + entry to spawn:
  //   - mini-services/agent (TypeScript, self-contained node_modules +
  //     initialized db) via bun when the bun CLI is available;
  //   - platform agent.js bundle via node otherwise.
  // NOTE: process.versions.bun is useless here — `next dev` spawns a
  // node runtime for the server even under `bun run dev`, so probe the
  // bun CLI itself.
  const root = process.cwd();
  let bunAvailable = false;
  try {
    execSync('bun --version', { stdio: 'ignore', timeout: 3000, windowsHide: true });
    bunAvailable = true;
  } catch { /* no bun CLI */ }
  const platformDir = os.platform() === 'darwin' ? 'agent-macos' : os.platform() === 'win32' ? 'agent-windows' : 'agent-linux';
  const preferTs = bunAvailable && existsSyncSafe(path.join(root, 'mini-services', 'agent', 'index.ts'));
  const dir = preferTs ? 'agent' : platformDir;
  const base = path.join(root, 'mini-services', dir);
  const entry = preferTs ? path.join(base, 'index.ts') : path.join(base, 'agent.js');
  const runtime = preferTs ? 'bun' : 'node';
  if (!existsSyncSafe(entry)) {
    return { ok: false, error: `Agent entry not found: ${path.join('mini-services', dir, path.basename(entry))}` };
  }

  // Config: reuse the PERSISTED identity. Prefer the directory where an
  // agent was actually detected (its config holds this machine's paired
  // identity); fall back to the spawn directory on first run. A new random
  // key each boot would orphan every already-paired dashboard row.
  let port = 3101;
  let apiKey = randomBytes(24).toString('hex');
  let name = os.hostname();
  const cfgDir = detected?.dir ?? dir;
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(root, 'mini-services', cfgDir, 'agent-config.json'), 'utf-8'));
    port = Number(cfg.port) || port;
    apiKey = String(cfg.apiKey || apiKey);
    name = String(cfg.name || name);
  } catch { /* first run — defaults above */ }
  // Identity hygiene: NEVER adopt a repo-committed shared key — clones
  // would all run the same identity and filter each other out of their
  // device lists (see POISONED_AGENT_KEYS). The author's machine name
  // that shipped with it ('dev-laptop-2') is dropped the same way so
  // paired machines are distinguishable in the UI.
  if (POISONED_AGENT_KEYS.has(apiKey)) {
    apiKey = randomBytes(24).toString('hex');
    name = os.hostname();
    logActivity({
      type: 'pair',
      level: 'warn',
      message: 'Local agent identity regenerated',
      detail: `${cfgDir}/agent-config.json carried the repo-committed shared key — fresh per-machine key + hostname written`,
    });
  }
  // .agent-session.env records the actually-used port (start.sh writes
  // it; a stale file could pin an outdated port).
  try {
    const envTxt = await fs.readFile(path.join(root, 'mini-services', cfgDir, '.agent-session.env'), 'utf-8');
    const m = envTxt.match(/^AGENT_PORT=(\d+)\s*$/m);
    if (m) port = parseInt(m[1], 10);
  } catch { /* no session file */ }
  // Whatever the port ended up being, it belongs to the dashboard's own
  // mesh infrastructure — the stray sweeper must never kill this listener.
  registerMeshServicePort(port);

  const logFile = path.join('/tmp', 'dashboard-agent.log');
  const out = openSyncAppend(logFile);
  // Strip the dashboard's Next.js internals before spawning the agent: this
  // code runs inside `next dev` (Turbopack), which exports TURBOPACK=1 to
  // its children. The agent would inherit it and leak TURBOPACK=1 into
  // every project process it spawns — a child whose dev script pins
  // --webpack then dies instantly ("Multiple bundler flags set: TURBOPACK=1,
  // --webpack", exit 0). Agents sanitize their own children too; this is
  // the belt-and-braces fix at the source.
  const agentEnv: Record<string, string | undefined> = {
    ...process.env,
    DATABASE_URL: `file:${path.join(base, 'db', 'agent.db')}`,
    // Tell the agent WHICH dashboard spawned it, so its own self-guard can
    // refuse to analyze/start/kill anything inside the co-located dashboard's
    // directory (the remote self-analysis kill vector — see mini-services/agent
    // "DASHBOARD SELF-GUARD").
    DASHBOARD_ROOT: base,
    DASHBOARD_PID: String(process.pid),
    DASHBOARD_PORT: String(parseInt(process.env.PORT || '3000', 10) || 3000),
  };
  delete agentEnv.TURBOPACK;
  delete agentEnv.NEXT_RUNTIME;
  delete agentEnv.NEXT_DEPLOYMENT_ID;
  delete agentEnv.__NEXT_PROCESSED_ENV;
  for (const k of Object.keys(agentEnv)) {
    if (k.startsWith('__NEXT_PRIVATE_')) delete agentEnv[k];
  }
  const child = spawn(runtime, [entry, '--port', String(port), '--apiKey', apiKey, '--name', name], {
    cwd: base,
    detached: true,
    stdio: ['ignore', out, out],
    env: agentEnv,
    // The agent is a headless background service — never give it (or any
    // process it later spawns without a console of its own) a visible
    // console window on the desktop.
    windowsHide: true,
  });
  child.unref();
  if (out !== 1 && out !== 2) { try { closeSync(out); } catch { /* already closed */ } }

  logActivity({
    type: 'pair',
    level: 'info',
    message: `Local agent started (port ${port})`,
    detail: `${dir} · pid ${child.pid}`,
  });

  // Give the process a moment to bind, then verify.
  await new Promise((r) => setTimeout(r, 1500));
  const running = await probeAgent(port);
  return { ok: true, agent: { port, apiKey, name, dir, running }, started: true, restarted };
}

// ===================== LIFECYCLE SUPERVISOR =====================

/**
 * Periodic self-healing loop for everything the dashboard supervises on
 * THIS machine — the "zero manual maintenance" layer:
 *
 *   every 60s tick:
 *     1. ensureLocalAgent()      — agent died → respawn; agent process
 *                                  predates a git pull (stale feature
 *                                  markers) → kill & respawn on new code
 *     2. ensureAutoIterService() — same treatment for auto-iter (3111)
 *     3. autoPullIfSafe()        — this repo behind origin + clean tree +
 *                                  default branch + ops.autoUpdate on →
 *                                  `git pull --ff-only` (routes hot-reload
 *                                  in dev; the NEXT tick respawns the
 *                                  agent onto the new code)
 *
 * All three are idempotent and internally rate-limited; a tick never
 * throws (every step is individually caught) so the timer can never die.
 * Started once per server process from instrumentation via a globalThis
 * guard (Next dev can re-run module code — the guard keeps ONE loop).
 */
const SUPERVISOR_TICK_MS = 60 * 1000;

export function startLifecycleSupervisor(): void {
  const g = globalThis as any;
  if (g.__lifecycleSupervisor) return;
  g.__lifecycleSupervisor = true;

  const tick = async () => {
    try { await ensureLocalAgent(); } catch (e: any) {
      console.warn('[supervisor] agent ensure failed:', e?.message || e);
    }
    try {
      const { ensureAutoIterService } = await import('@/lib/auto-iter-lifecycle');
      await ensureAutoIterService();
    } catch (e: any) {
      console.warn('[supervisor] auto-iter ensure failed:', e?.message || e);
    }
    try {
      const { autoPullIfSafe } = await import('@/lib/dashboard-self-update');
      await autoPullIfSafe();
    } catch (e: any) {
      console.warn('[supervisor] self-update failed:', e?.message || e);
    }
  };

  // First tick shortly after boot (instrumentation already runs an initial
  // ensure; the short delay here mainly covers the self-update probe).
  setTimeout(tick, 15_000).unref?.();
  const timer = setInterval(tick, SUPERVISOR_TICK_MS);
  timer.unref?.();
  console.log(`[supervisor] lifecycle loop armed (every ${SUPERVISOR_TICK_MS / 1000}s: agent + auto-iter + self-update)`);
}

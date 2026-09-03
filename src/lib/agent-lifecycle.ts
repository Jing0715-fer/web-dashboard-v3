import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { existsSync, openSync, closeSync } from 'fs';
import { spawn, execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { logActivity } from '@/lib/activity';

/**
 * Local agent lifecycle — shared by the mesh pairing routes AND the server
 * boot instrumentation, so the co-located agent service
 * (mini-services/agent*) is always running / up-to-date on dashboard
 * machines without any manual start.sh step.
 */

// Agent service directories shipped with the project (platform variants).
export const AGENT_DIRS = ['agent', 'agent-linux', 'agent-macos', 'agent-win', 'agent-windows'];

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
  const run = (cmd: string): string => {
    try { return execSync(cmd, { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
    catch { return ''; }
  };
  let ip: string | null = null;
  try {
    if (process.platform === 'win32') {
      ip = parseGatewayIp(run('route print -4 0.0.0.0'));
    } else if (process.platform === 'darwin') {
      ip = parseGatewayIp(run('route -n get default'));
    } else {
      ip = parseGatewayIp(run('ip route show default')) || parseGatewayIp(run('route -n'));
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
 */
async function agentOutdated(port: number): Promise<{ outdated: boolean; why: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { outdated: false, why: '' }; // can't tell — do NOT restart
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return { outdated: false, why: '' };
    const d = data as Record<string, unknown>;
    if (!('dashboardDb' in d)) return { outdated: true, why: 'dashboard-DB serving' };
    if (!('pushProjects' in d)) return { outdated: true, why: 'heartbeat project push' };
    if (!('smartIp' in d)) return { outdated: true, why: 'smart LAN IP detection' };
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
  if (pids.size === 0 && process.platform === 'win32') {
    try {
      const ns = execSync(`netstat -ano | findstr ":${port} "`, { timeout: 3000 }).toString();
      for (const line of ns.split('\n')) {
        if (!line.includes('LISTENING')) continue;
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (Number.isFinite(pid) && pid > 0) pids.add(pid);
      }
    } catch { /* nothing listening */ }
  }
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
  const scanPorts = [...new Set([...AGENT_SCAN_PORTS, ...candidates.map((c) => c.port)])];
  const alive = await Promise.all(
    scanPorts.map(async (p) => ((await probeAgent(p)) ? p : null)),
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
  if (detected?.running) {
    const check = await agentOutdated(detected.port);
    if (check.outdated) {
      await stopAgentOnPort(detected.port);
      restarted = true;
      logActivity({
        type: 'pair',
        level: 'info',
        message: 'Local agent restarted (code upgrade)',
        detail: `port ${detected.port} · old agent lacked ${check.why}`,
      });
    }
  }

  if (detected?.running && !restarted) {
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
    execSync('bun --version', { stdio: 'ignore', timeout: 3000 });
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
  // .agent-session.env records the actually-used port (start.sh writes
  // it; a stale file could pin an outdated port).
  try {
    const envTxt = await fs.readFile(path.join(root, 'mini-services', cfgDir, '.agent-session.env'), 'utf-8');
    const m = envTxt.match(/^AGENT_PORT=(\d+)\s*$/m);
    if (m) port = parseInt(m[1], 10);
  } catch { /* no session file */ }

  const logFile = path.join('/tmp', 'dashboard-agent.log');
  const out = openSyncAppend(logFile);
  const child = spawn(runtime, [entry, '--port', String(port), '--apiKey', apiKey, '--name', name], {
    cwd: base,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, DATABASE_URL: `file:${path.join(base, 'db', 'agent.db')}` },
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

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { existsSync, openSync, closeSync } from 'fs';
import { spawn, execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { logActivity } from '@/lib/activity';
import { requireApprovedUser } from '@/lib/auth';
import { invalidateRemoteProjectCache } from '@/lib/remote-sync';

/**
 * Device mesh pairing — simple device interconnection.
 *
 *   POST /api/mesh/pair          → create a pairing code for this dashboard
 *   GET  /api/mesh/pair          → current pending pairing info (code + one-liner)
 *   POST /api/mesh/register      → a remote agent registers itself with {code, name, ip, port, apiKey, dashboardUrl?}
 *   GET  /api/mesh/ping          → OPEN probe: "is a dashboard running here?" (used by pre-flight checks)
 *   GET  /api/mesh/check?target= → pre-flight probe of ANOTHER dashboard (join dialog "test connection")
 *   GET  /api/mesh/local-agent   → auto-detect the agent running on THIS machine (for web-UI join)
 *   POST /api/mesh/join          → this dashboard joins another dashboard's mesh by entering
 *                                  {target, code} in the web UI (no CLI needed on this device).
 *                                  The local agent is auto-started/upgraded here — no separate step.
 *
 * Pairing is MUTUAL from a single join: the joiner registers with the target
 * (row created there), mirrors the target's peer coordinates into its own
 * DB, and both agents' heartbeats get wired at each other (joiner side wires
 * itself in 'join'; target side wires itself in 'register' via the joiner's
 * advertised dashboardUrl). No reverse join is ever needed.
 *
 * Two ways to join a mesh:
 *   A. CLI (agent-only devices):  node agent.js --pair http://<dashboard-host>:3000 --code <CODE>
 *   B. Web UI (devices running the full dashboard): 设备 → 加入网络 → 输入对方地址 + 验证码
 */

interface PendingPair {
  code: string;
  createdAt: number;
  expiresAt: number;
}

// In-memory pending pairing codes (5-minute validity, multi-device use).
const pendingPairs = new Map<string, PendingPair>();

// Simple in-memory rate limiter for register attempts (per client IP).
const registerAttempts = new Map<string, { count: number; resetAt: number }>();
const REGISTER_LIMIT = 12; // attempts per window
const REGISTER_WINDOW_MS = 60_000;

function registerRateLimited(clientIp: string): boolean {
  const now = Date.now();
  const entry = registerAttempts.get(clientIp);
  if (!entry || entry.resetAt < now) {
    registerAttempts.set(clientIp, { count: 1, resetAt: now + REGISTER_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > REGISTER_LIMIT;
}

// Agent service directories shipped with the project (platform variants).
const AGENT_DIRS = ['agent', 'agent-linux', 'agent-macos', 'agent-win', 'agent-windows'];

function existsSyncSafe(p: string): boolean {
  try { return existsSync(p); } catch { return false; }
}

/** Append-mode fd for the agent log (never fails the request — stdout is
 *  an acceptable fallback). */
function openSyncAppend(logFile: string): number {
  try { return openSync(logFile, 'a'); } catch { return 1; }
}

function hostFromReq(req: NextRequest): string {
  const url = new URL(req.url);
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
  return host;
}

/**
 * Ranked LAN IP detection.
 *
 * os.networkInterfaces() order is arbitrary — on machines with VPN / Clash /
 * Surge TUN adapters the FIRST non-internal IPv4 is often the fake-IP range
 * (198.18.0.0/15) which is unroutable from other devices. Ranking:
 *   1. 192.168.0.0/16  — typical home/office LAN (best)
 *   2. 10.0.0.0/8      — larger private nets
 *   3. 172.16.0.0/12   — docker/ corp nets
 *   4. 100.64.0.0/10   — CGNAT (Tailscale & friends) — reachable, keep last
 * Excluded entirely:
 *   - 198.18.0.0/15 — benchmark range hijacked by fake-IP VPN modes
 *   - 169.254.0.0/16 — link-local
 */
function lanIpCandidates(): string[] {
  const ifaces = Object.values(os.networkInterfaces()).flat();
  const ips: string[] = [];
  for (const i of ifaces) {
    if (!i || i.family !== 'IPv4' || i.internal) continue;
    const [a, b] = i.address.split('.').map(Number);
    if (a === 198 && (b === 18 || b === 19)) continue; // fake-IP VPN
    if (a === 169 && b === 254) continue; // link-local
    ips.push(i.address);
  }
  const rank = (ip: string): number => {
    const [a, b] = ip.split('.').map(Number);
    if (a === 192 && b === 168) return 0;
    if (a === 10) return 1;
    if (a === 172 && b >= 16 && b <= 31) return 2;
    if (a === 100 && b >= 64 && b <= 127) return 3; // CGNAT / tailscale
    return 4;
  };
  return ips.sort((x, y) => rank(x) - rank(y));
}

function lanIp(): string {
  return lanIpCandidates()[0] || '127.0.0.1';
}

interface LocalAgentInfo {
  port: number;
  apiKey: string;
  name: string;
  running: boolean;
  dir: string;
}

/**
 * Info about THIS dashboard machine's own agent, shared (pair code = trust
 * anchor) with a device registering via /api/mesh/register so the JOINER
 * can mirror us into its own device list — pairing becomes mutual instead
 * of one-directional. Null when this machine has no agent identity yet.
 */
async function localPeerInfo(detected?: LocalAgentInfo | null) {
  const d = detected ?? await detectLocalAgent();
  if (!d) return null;
  return {
    name: d.name,
    ip: lanIp(),
    port: d.port,
    apiKey: d.apiKey,
    running: d.running,
  };
}

/** Dashboard port as the user browses it (Host header). '' → 3000. */
function dashboardPortFromHost(host: string): number {
  try {
    const p = new URL(`http://${host}`).port;
    if (p) return Number(p) || 3000;
  } catch { /* odd host header */ }
  return 3000;
}

/**
 * Classify a network failure from a fetch() exception into a short machine
 * reason + raw detail. The join/check UIs map `reason` to a localized,
 * actionable hint (firewall / wrong port / wrong IP) instead of surfacing a
 * bare "TimeoutError was aborted".
 */
function classifyNetError(e: unknown): { reason: string; detail: string } {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  const code = err?.cause?.code || '';
  const name = err?.name || '';
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT') {
    return { reason: 'timeout', detail: err?.message || 'timeout' };
  }
  if (code === 'ECONNREFUSED') return { reason: 'refused', detail: err?.message || 'refused' };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { reason: 'dns', detail: err?.message || 'dns' };
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return { reason: 'unreachable', detail: err?.message || 'unreachable' };
  return { reason: 'error', detail: err?.message || String(e) };
}

/** Short localized hint for join/check failures, keyed by classifyNetError reason. */
function joinFailHint(reason?: string): string {
  switch (reason) {
    case 'timeout': return '常见原因：对方防火墙拦截入站连接（Windows 需允许 Node.js 通过防火墙）、IP 不正确、或两台设备不在同一网络';
    case 'refused': return '该地址/端口上没有运行仪表盘 — 请核对对方地址与端口';
    case 'dns': return '主机名无法解析 — 请改用对方的局域网 IP 地址';
    case 'unreachable': return '网络不可达 — 请检查 IP 与子网';
    default: return '请检查地址与网络';
  }
}

interface TargetProbe {
  reachable: boolean;
  dashboard: boolean;
  reason?: string;
  detail?: string;
  host?: string;
  status?: number;
}

/** Pre-flight probe of a remote dashboard: GET {target}/api/mesh/ping. */
async function probeDashboard(target: string, timeoutMs = 4000): Promise<TargetProbe> {
  try {
    const res = await fetch(`${target}/api/mesh/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    const data = await res.json().catch(() => null);
    if (res.ok && data && typeof data === 'object' && (data as Record<string, unknown>).dashboard === true) {
      return { reachable: true, dashboard: true, host: String((data as Record<string, unknown>).host || '') };
    }
    return { reachable: true, dashboard: false, status: res.status };
  } catch (e) {
    const c = classifyNetError(e);
    return { reachable: false, dashboard: false, reason: c.reason, detail: c.detail };
  }
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
async function addPersistedHeartbeatTarget(dir: string, target: string): Promise<void> {
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
 * action and the join flow, so joining never requires a separate
 * "start the agent first" step (one click fewer for the user).
 *
 * Returns the agent's coordinates (port / apiKey / name / dir) plus whether
 * it was just started or auto-upgraded.
 */
async function ensureLocalAgent(): Promise<
  | { ok: true; agent: LocalAgentInfo; started: boolean; restarted: boolean }
  | { ok: false; error: string }
> {
  const detected = await detectLocalAgent();

  // Auto-upgrade: a long-running agent started BEFORE a code pull keeps
  // executing the OLD code (git pull only hot-reloads the dashboard, not
  // the spawned agent process). Old agents report no `dashboardDb` field
  // → kill & respawn so the new code (co-located dashboard DB serving)
  // takes over. Without this, paired peers see the device "online" with
  // 0 projects forever no matter how many times the user pulls.
  let restarted = false;
  if (detected?.running && (await agentOutdated(detected.port))) {
    await stopAgentOnPort(detected.port);
    restarted = true;
    logActivity({
      type: 'pair',
      level: 'info',
      message: 'Local agent restarted (code upgrade)',
      detail: `port ${detected.port} · old agent lacked dashboard-DB support`,
    });
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

async function probeAgent(port: number): Promise<boolean> {
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
 * True when the RUNNING agent on this port predates the dashboard-DB
 * support: its /api/agent/health response lacks the `dashboardDb` marker
 * (new agents always include the field, true or false). Such an agent
 * keeps serving its own EMPTY agent.db — remote peers see the device
 * online but with 0 projects, which is exactly the stale-agent failure
 * mode reported after a git pull upgraded the dashboard code but the
 * long-running agent process kept executing the old code.
 */
async function agentOutdated(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false; // can't tell — do NOT restart
    const data = await res.json().catch(() => null);
    return !!data && typeof data === 'object' && !('dashboardDb' in (data as Record<string, unknown>));
  } catch {
    return false;
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

async function detectLocalAgent(): Promise<LocalAgentInfo | null> {
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

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const action = url.pathname.split('/').pop();

  // Auth guard (Task 11-a): 'pair', 'join' and 'ensure-agent' are UI actions
  // and require an approved session. 'register' stays OPEN — remote device
  // CLIs call it with apiKey + pair code, no cookies available.
  if (action === 'pair' || action === 'join' || action === 'ensure-agent') {
    const authGuard = await requireApprovedUser(req);
    if (authGuard.error) return authGuard.error;
  }

  try {
    if (action === 'ensure-agent') {
      // Start (or verify) the LOCAL agent service. The agent ships with the
      // project (mini-services/agent*), so the dashboard can bring it up on
      // demand — fixing the most common mesh failure mode: "Local Agent: Not
      // running" because nobody ran start.sh on this machine.
      const ensured = await ensureLocalAgent();
      if (!ensured.ok) {
        return NextResponse.json({ error: ensured.error }, { status: 500 });
      }
      return NextResponse.json({
        running: ensured.agent.running,
        started: ensured.started,
        restarted: ensured.restarted,
        port: ensured.agent.port,
        name: ensured.agent.name,
        agent: ensured.agent,
        dir: ensured.agent.dir,
      });
    }

    if (action === 'pair') {
      // Invalidate ALL previous pending codes — only the newest code is
      // valid at any time (a fresh code supersedes older ones).
      pendingPairs.clear();
      // 8 hex chars (4 bytes) — harder to brute-force within the 5-minute
      // window than the previous 6-char code.
      const code = randomBytes(4).toString('hex').toUpperCase();
      const entry: PendingPair = {
        code,
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000,
      };
      pendingPairs.set(code, entry);
      const host = hostFromReq(req);
      const proto = req.headers.get('x-forwarded-proto') || (host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'http');

      logActivity({
        type: 'pair',
        level: 'info',
        message: 'Pairing code generated (valid 5 min)',
      });

      // The port THIS dashboard is browsed on (Host header) — lets the UI
      // advertise an address with the RIGHT port instead of a hardcoded
      // :3000 (a dashboard started on e.g. 3001 would otherwise hand the
      // joiner a dead URL).
      const dashPort = dashboardPortFromHost(host);

      return NextResponse.json({
        code,
        expiresAt: entry.expiresAt,
        port: dashPort,
        dashboardUrl: `${proto}://${host}`,
        command: `node agent.js --pair ${proto}://${host} --code ${code}`,
        curlCommand: `curl -X POST ${proto}://${host}/api/mesh/register -H 'Content-Type: application/json' -d '{"code":"${code}","name":"<device-name>","ip":"<device-ip>","port":3100,"apiKey":"<agent-api-key>"}'`,
      });
    }

    if (action === 'register') {
      const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
      if (registerRateLimited(clientIp)) {
        return NextResponse.json({ error: '尝试过于频繁，请稍后再试' }, { status: 429 });
      }
      const body = await req.json();
      const { code, name, ip, port, apiKey } = body || {};

      // ---- Self-heal re-registration (no pair code) ----
      // An agent whose apiKey already exists in the Device table may
      // re-register its CURRENT ip/port. IP drift (DHCP / new network / VPN
      // up) or a port change would otherwise leave the DB pointing at a dead
      // address and the device shows offline forever (user report:
      // dev-laptop-2 registered 192.168.253.1:3100 while the agent now runs
      // on 192.168.101.43:3101). The stored apiKey IS the credential.
      if (!code) {
        const keyRow = apiKey
          ? await db.device.findFirst({ where: { apiKey: String(apiKey) } })
          : null;
        if (!keyRow) {
          return NextResponse.json(
            { error: '缺少配对码 — 新设备请先在对方仪表盘生成配对码（或提供已注册设备的 apiKey）' },
            { status: 400 },
          );
        }
        const ipChanged = keyRow.ip !== String(ip);
        const portChanged = keyRow.port !== Number(port);
        const device = await db.device.update({
          where: { id: keyRow.id },
          data: {
            name: String(name),
            ip: String(ip),
            port: Number(port),
            status: 'online',
            lastSeen: new Date(),
          },
        });
        if (ipChanged || portChanged) {
          logActivity({
            type: 'pair',
            level: 'success',
            message: `Device '${device.name}' address self-healed`,
            deviceId: device.id,
            deviceName: device.name,
            detail: `${keyRow.ip}:${keyRow.port} → ${device.ip}:${device.port}`,
          });
        }
        return NextResponse.json({
          ok: true,
          deviceId: device.id,
          reRegistered: true,
          addressFixed: ipChanged || portChanged,
        });
      }

      if (!pendingPairs.has(String(code).toUpperCase())) {
        return NextResponse.json({ error: '无效或已过期的配对码' }, { status: 400 });
      }
      const entry = pendingPairs.get(String(code).toUpperCase())!;
      if (entry.expiresAt < Date.now()) {
        pendingPairs.delete(entry.code);
        return NextResponse.json({ error: '配对码已过期，请重新生成' }, { status: 400 });
      }
      if (!name || !ip || !port || !apiKey) {
        return NextResponse.json({ error: '缺少 name / ip / port / apiKey' }, { status: 400 });
      }

      // Dedup by apiKey FIRST (same device re-pairing after its address
      // changed), then by ip:port (fresh device on a known address).
      const existing = await db.device.findFirst({
        where: { OR: [{ apiKey: String(apiKey) }, { ip: String(ip), port: Number(port) }] },
      });
      let device;
      if (existing) {
        // Heal the address too (not just name/key/status): a device whose
        // ip/port drifted since its last registration would otherwise stay
        // pinned to a dead address and show offline forever.
        device = await db.device.update({
          where: { id: existing.id },
          data: { name: String(name), apiKey: String(apiKey), ip: String(ip), port: Number(port), status: 'online', lastSeen: new Date() },
        });
      } else {
        device = await db.device.create({
          data: {
            name: String(name),
            ip: String(ip),
            port: Number(port),
            apiKey: String(apiKey),
            status: 'online',
          },
        });
        // Only log when a NEW device was registered — re-registrations
        // (agent reconnects, key rotation) would spam the feed otherwise.
        logActivity({
          type: 'pair',
          level: 'success',
          message: `Device '${device.name}' registered`,
          deviceId: device.id,
          deviceName: device.name,
          detail: `${device.ip}:${device.port}`,
        });
      }
      // The code stays valid until expiry so several devices can join with
      // the same code within the 5-minute window.

      // Mutual pairing, two halves:
      //   1) hand our own agent's coordinates (peer) to the joiner so BOTH
      //      dashboards end up with a device row for the other side;
      //   2) point OUR agent's heartbeat at the JOINER's advertised
      //      dashboard URL (body.dashboardUrl) so OUR device row on the
      //      joiner self-heals (ip/port drift) exactly like the joiner's
      //      row here does. ONE join → mutual rows AND mutual heartbeats;
      //      the reverse join becomes unnecessary.
      // Trust note: the joiner already receives peer.apiKey in this very
      // response (the pair code is the trust anchor), so heartbeat-ing at
      // its URL discloses nothing new.
      const me = await detectLocalAgent();
      const peer = await localPeerInfo(me);

      let mutualHeartbeat = false;
      const joinerDashboardUrl = String(body?.dashboardUrl || '').trim().replace(/\/+$/, '');
      if (/^https?:\/\/.+/i.test(joinerDashboardUrl) && me?.apiKey && me.port > 0) {
        try {
          const r = await fetch(`http://127.0.0.1:${me.port}/api/agent/pair-target`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${me.apiKey}`,
            },
            body: JSON.stringify({ dashboardUrl: joinerDashboardUrl }),
            signal: AbortSignal.timeout(3000),
          });
          mutualHeartbeat = r.ok;
        } catch { /* agent not running — persisted config below still arms it at next boot */ }
        if (me.dir) {
          await addPersistedHeartbeatTarget(me.dir, joinerDashboardUrl);
        }
        if (mutualHeartbeat) {
          logActivity({
            type: 'pair',
            level: 'info',
            message: 'Agent heartbeat wired to the joiner (mutual)',
            detail: joinerDashboardUrl,
          });
        }
      }

      return NextResponse.json({
        ok: true,
        deviceId: device.id,
        dashboard: { name: 'Dashboard', registered: true },
        peer,
        mutualHeartbeat,
      });
    }

    if (action === 'join') {
      // This machine joins ANOTHER dashboard's mesh via the web UI.
      const body = await req.json().catch(() => ({}));
      const target = String(body?.target || '').trim().replace(/\/+$/, '');
      const code = String(body?.code || '').trim().toUpperCase();
      if (!target || !/^https?:\/\/.+/i.test(target)) {
        return NextResponse.json({ error: '请输入对方仪表盘地址（如 http://192.168.1.100:3000）' }, { status: 400 });
      }
      if (!code) {
        return NextResponse.json({ error: '请输入对方仪表盘显示的配对码' }, { status: 400 });
      }

      // Local agent coordinates. Explicit manual mode (port + key) is
      // honored as-is; otherwise the agent is ENSURED right here — started
      // when stopped, auto-upgraded when running stale code, spawned with a
      // fresh identity when never started. Joining must not require a
      // separate "start the agent first" step (user request: minimize the
      // number of pairing steps).
      const manualPort = Number(body?.agentPort) || 0;
      const manualKey = String(body?.agentApiKey || '').trim();
      let port: number;
      let apiKey: string;
      let name: string;
      let agentDir: string | null = null;
      let agentStarted = false;
      if (manualPort > 0 && manualKey) {
        port = manualPort;
        apiKey = manualKey;
        name = String(body?.name || '') || os.hostname();
      } else {
        const ensured = await ensureLocalAgent();
        if (!ensured.ok) {
          return NextResponse.json({ error: ensured.error, agentDetected: false }, { status: 400 });
        }
        port = ensured.agent.port;
        apiKey = ensured.agent.apiKey;
        name = ensured.agent.name || os.hostname();
        agentDir = ensured.agent.dir;
        agentStarted = ensured.started;
      }

      // Reported IP: the user can override which address gets advertised
      // (auto-detect ranks LAN ranges first, but VPN / multi-NIC setups may
      // need the explicit choice). Falls back to the ranked best candidate.
      const bodyIp = String(body?.ip || '').trim();
      const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(bodyIp) ? bodyIp : lanIp();

      // Our own dashboard URL, advertised to the target so it can wire ITS
      // agent's heartbeat back at us (mutual pairing from ONE join). The
      // port comes from how the user browses THIS dashboard (Host header),
      // the IP from the same advertised address used for the agent
      // registration.
      const dashPort = dashboardPortFromHost(hostFromReq(req));
      const joinerDashboardUrl = `http://${ip}:${dashPort}`;

      // Pre-flight: fail FAST with an actionable reason when the target is
      // unreachable (firewall / wrong IP / wrong port) instead of a 10s
      // hang followed by a bare TimeoutError. A reachable-but-unknown
      // server (404) falls through — the register call below then reports
      // its own precise error.
      const probe = await probeDashboard(target, 4000);
      if (!probe.reachable) {
        const label = probe.reason === 'timeout' ? '连接超时'
          : probe.reason === 'refused' ? '连接被拒绝'
          : probe.reason === 'dns' ? '域名解析失败'
          : '网络错误';
        return NextResponse.json(
          { error: `无法连接对方仪表盘（${label}）— ${joinFailHint(probe.reason)}`, reason: probe.reason, detail: probe.detail },
          { status: 502 },
        );
      }
      try {
        const res = await fetch(`${target}/api/mesh/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, name, ip, port, apiKey, dashboardUrl: joinerDashboardUrl }),
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          // ---- Mutual pairing ----
          // The target returned its OWN agent coordinates (peer). Mirror it
          // into OUR device list so both sides can see (and fetch projects
          // from) each other — previously the joiner learned nothing about
          // the target, so device lists stayed one-directional.
          let mutual = false;
          let peerSummary: { name: string; ip: string; port: number } | null = null;
          const peer = data?.peer;
          if (peer && peer.apiKey && peer.port) {
            const peerIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(String(peer.ip))
              ? String(peer.ip)
              : lanIp();
            const peerPort = Number(peer.port);
            const existingPeer = await db.device.findFirst({
              where: { OR: [{ apiKey: String(peer.apiKey) }, { ip: peerIp, port: peerPort }] },
            });
            const peerDevice = existingPeer
              ? await db.device.update({
                  where: { id: existingPeer.id },
                  data: {
                    name: String(peer.name || 'Dashboard peer'),
                    ip: peerIp,
                    port: peerPort,
                    apiKey: String(peer.apiKey),
                    status: peer.running ? 'online' : 'offline',
                    lastSeen: new Date(),
                  },
                })
              : await db.device.create({
                  data: {
                    name: String(peer.name || 'Dashboard peer'),
                    ip: peerIp,
                    port: peerPort,
                    apiKey: String(peer.apiKey),
                    status: peer.running ? 'online' : 'offline',
                  },
                });
            mutual = true;
            peerSummary = { name: peerDevice.name, ip: peerIp, port: peerPort };
            logActivity({
              type: 'pair',
              level: 'success',
              message: `Device '${peerDevice.name}' paired (mutual)`,
              deviceId: peerDevice.id,
              deviceName: peerDevice.name,
              detail: `${peerIp}:${peerPort} · target: ${target}`,
            });
            // New peer → drop the sync cache so its projects are fetched
            // on the next list GET instead of a pre-join snapshot.
            invalidateRemoteProjectCache();
          }

          // Wire the LOCAL agent's heartbeat to the target so the remote
          // Device row for THIS machine keeps self-healing (ip/port drift)
          // after restarts. Best-effort: a stopped agent simply keeps its
          // persisted dashboardUrl once started via ensure-agent.
          try {
            await fetch(`http://127.0.0.1:${port}/api/agent/pair-target`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({ dashboardUrl: target }),
              signal: AbortSignal.timeout(3000),
            });
          } catch { /* best-effort only */ }

          // Durable wiring: ALSO persist the heartbeat target into the local
          // agent's agent-config.json. A RUNNING old agent 404s the
          // pair-target call above (that endpoint is new) — but once
          // ensure-agent restarts/upgrades it, the heartbeat arms from this
          // persisted field at boot, so the pairing survives restarts of
          // either side.
          if (agentDir) {
            await addPersistedHeartbeatTarget(agentDir, target);
          }

          logActivity({
            type: 'pair',
            level: 'success',
            message: `Joined '${name}' via pairing code`,
            deviceName: name,
            detail: `target: ${target}${mutual ? ' · mutual' : ''}${agentStarted ? ' · agent auto-started' : ''}`,
          });
          return NextResponse.json({
            ok: true,
            deviceName: name,
            ip,
            port,
            target,
            mutual,
            mutualHeartbeat: !!data?.mutualHeartbeat,
            agentStarted,
            dashboardUrl: joinerDashboardUrl,
            peer: peerSummary,
          });
        }
        const targetErr = data?.error || `对方仪表盘返回 ${res.status}`;
        const codeHint = res.status === 400 && /配对码/.test(String(targetErr))
          ? '（请在对方仪表盘点「重新生成」拿新码 — 旧码可能已被新码取代、已过期、或对方服务重启后失效）'
          : '';
        return NextResponse.json(
          { error: `${targetErr}${codeHint}`, reason: 'target-error' },
          { status: 400 },
        );
      } catch (e) {
        const c = classifyNetError(e);
        return NextResponse.json(
          { error: `无法连接对方仪表盘（${c.detail}）— ${joinFailHint(c.reason)}`, reason: c.reason },
          { status: 502 },
        );
      }
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 404 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const action = url.pathname.split('/').pop();

  // OPEN endpoint — no session. Remote dashboards probe it (via their own
  // /api/mesh/check) to verify "there IS a dashboard at this URL" before
  // attempting a join, so the join dialog can show a precise reason
  // (firewall / wrong port / not a dashboard) instead of a bare timeout.
  if (action === 'ping') {
    return NextResponse.json({ ok: true, dashboard: true, host: os.hostname(), time: Date.now() });
  }

  // Auth guard (Task 11-a): UI status endpoints require an approved session.
  if (action === 'pair' || action === 'local-agent' || action === 'check') {
    const authGuard = await requireApprovedUser(req);
    if (authGuard.error) return authGuard.error;
  }

  if (action === 'check') {
    // Pre-flight reachability check for the join dialog's "测试连接" button.
    const target = (url.searchParams.get('target') || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/.+/i.test(target)) {
      return NextResponse.json({ error: '请输入以 http(s):// 开头的完整地址' }, { status: 400 });
    }
    const probe = await probeDashboard(target, 4000);
    return NextResponse.json(probe);
  }

  if (action === 'pair') {
    for (const [k, v] of pendingPairs) {
      if (v.expiresAt < Date.now()) pendingPairs.delete(k);
    }
    const latest = [...pendingPairs.values()].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    return NextResponse.json({ pending: latest ? { code: latest.code, expiresAt: latest.expiresAt } : null });
  }
  if (action === 'local-agent') {
    const detected = await detectLocalAgent();
    const ips = lanIpCandidates();
    return NextResponse.json({
      agent: detected,
      ip: ips[0] || '127.0.0.1',
      // All routable candidates (VPN fake-IP ranges excluded, LAN ranges
      // first) — the UI shows them so the user can verify the advertised
      // address or override it in manual mode.
      ips,
      hostname: os.hostname(),
    });
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 404 });
}

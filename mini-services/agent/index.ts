/**
 * Dashboard Agent (Cross-Platform — Windows / macOS / Linux)
 *
 * Runs on each remote device and exposes REST API for the Dashboard to manage
 * projects, environments, and processes.
 *
 * Usage:
 *   bun index.ts --port 3100 --apiKey <token>
 *   node index.ts --port 3100 --apiKey <token>
 *
 * Windows:
 *   npx tsx index.ts --port 3100 --apiKey <token>
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { PrismaClient } from '@prisma/client';
import { spawn, ChildProcess, execSync, execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync, mkdirSync, createWriteStream, writeFileSync, statSync, readdirSync } from 'fs';
import { join, resolve, dirname, basename, isAbsolute } from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { hostname, tmpdir, platform, arch, homedir, networkInterfaces } from 'os';

// ======================== PLATFORM DETECTION ========================

const IS_WINDOWS = platform() === 'win32';
const PATH_SEP = IS_WINDOWS ? ';' : ':';

console.log(`[Agent] Platform: ${platform()} ${arch()} (${IS_WINDOWS ? 'Windows' : 'Unix-like'})`);

// ======================== CONFIG ========================

const args = process.argv.slice(2);
function getArg(name: string, defaultValue: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return defaultValue;
}

const PORT = parseInt(getArg('port', '3100'), 10);
// API key resolution: CLI arg > PERSISTED agent-config.json > fresh random.
// Without reading the persisted key back, every restart minted a NEW random
// key, the heartbeat re-register then 400'd ("key unknown to this
// dashboard") and every proxied dashboard call (PUT/GET) died with 401
// Unauthorized (user report: editing a remote project's GitHub link).
const PERSISTED_API_KEY = (() => {
  try {
    const v = JSON.parse(readFileSync(resolve(process.cwd(), 'agent-config.json'), 'utf-8')).apiKey;
    return typeof v === 'string' && v ? v : '';
  } catch { return ''; }
})();
let API_KEY = getArg('apiKey', PERSISTED_API_KEY || randomBytes(32).toString('hex'));
let AGENT_NAME = getArg('name', hostname());
// Identity hygiene: 'remote-device-3101-key' was accidentally committed in
// mini-services/agent-linux/agent-config.json (git-tracked before the
// .gitignore rule — ignore rules don't apply to already-tracked files), so
// every clone adopted the SAME identity and paired machines filtered each
// other out of their device lists ("paired but can't see each other, 0
// projects"). Refuse it even when passed via --apiKey by a stale dashboard:
// regenerate a fresh per-machine key.
if (API_KEY === 'remote-device-3101-key') {
  API_KEY = randomBytes(32).toString('hex');
  if (AGENT_NAME === 'dev-laptop-2') AGENT_NAME = hostname();
  console.warn('[Agent] Refused the repo-committed shared key — fresh per-machine identity generated');
}
const HOST = IS_WINDOWS ? '0.0.0.0' : getArg('host', '0.0.0.0');
const DASHBOARD_URL = getArg('dashboard', '').replace(/\/+$/, '');

console.log(`[Agent] Config: port=${PORT}, name=${AGENT_NAME}, host=${HOST}`);
// Masked on purpose: startup output lands in service logs / terminal
// scrollback — the full key lives in agent-config.json and the pairing UI.
console.log(`[Agent] API Key: ${API_KEY.slice(0, 8)}…${API_KEY.slice(-4)} (full key in agent-config.json)`);

// ======================== MESH PAIRING SUPPORT ========================

// Ranked LAN IP detection v2 — gateway-subnet aware (mirrors the
// dashboard's lanIpCandidates — see src/lib/agent-lifecycle.ts). The
// FIRST non-internal IPv4 is often a VPN / Clash TUN fake-IP (198.18.0.0/15)
// or a stale virtual NIC — and plain range ranking is NOT enough on
// multi-NIC machines: VMware VMnet8 (192.168.253.1) and the real WLAN
// (192.168.101.47) are BOTH 192.168.0.0/16, so the virtual adapter wins
// the tie by enumeration order (user report: the heartbeat kept
// "self-healing" the peer's Device row to a dead VMware address).
// v2 adds: default-gateway-subnet preference + virtual-adapter name demotion.
const VIRTUAL_IFACE_RE =
  /vmware|vmnet|virtualbox|vbox|hyper-?v|vethernet|docker|wsl|tap|tun|tailscale|zerotier|radmin|parallels|vnic|awdl|bridge|loopback|anydesk|clash|surge|wireguard|wg\d|llw/i;

function parseGatewayIp(text: string): string | null {
  const mWin = text.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})/m);
  if (mWin) return mWin[1];
  const mMac = text.match(/gateway:\s*(\d{1,3}(?:\.\d{1,3}){3})/i);
  if (mMac) return mMac[1];
  const mLin = text.match(/via\s+(\d{1,3}(?:\.\d{1,3}){3})/);
  if (mLin) return mLin[1];
  const mLin2 = text.match(/^\s*0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+0\.0\.0\.0\s+UG/m);
  if (mLin2) return mLin2[1];
  return null;
}

let gatewayCache: { ip: string | null; at: number } | null = null;
function defaultGateway(): string | null {
  if (gatewayCache && Date.now() - gatewayCache.at < 60_000) return gatewayCache.ip;
  const run = (cmd: string): string => {
    try { return execSync(cmd, { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
    catch { return ''; }
  };
  let ip: string | null = null;
  try {
    if (IS_WINDOWS) ip = parseGatewayIp(run('route print -4 0.0.0.0'));
    else if (platform() === 'darwin') ip = parseGatewayIp(run('route -n get default'));
    else ip = parseGatewayIp(run('ip route show default')) || parseGatewayIp(run('route -n'));
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

function lanIpCandidates(): string[] {
  const gateway = defaultGateway();
  const scored: Array<{ ip: string; score: number }> = [];
  for (const [name, ifaces] of Object.entries(networkInterfaces())) {
    for (const i of ifaces || []) {
      if (!i || i.family !== 'IPv4' || i.internal) continue;
      const [a, b] = i.address.split('.').map(Number);
      if (a === 198 && (b === 18 || b === 19)) continue; // VPN fake-IP range
      if (a === 169 && b === 254) continue;              // link-local
      if (a === 0) continue;                             // 0.0.0.0 artifact
      let score = 0;
      if (a === 192 && b === 168) score += 4;            // typical home/office LAN
      else if (a === 10) score += 3;                     // larger private nets
      else if (a === 172 && b >= 16 && b <= 31) score += 2;
      else if (a === 100 && b >= 64 && b <= 127) score += 1; // CGNAT
      if (gateway && sameSubnet(i.address, gateway, i.netmask || '255.255.255.0')) score += 100;
      if (VIRTUAL_IFACE_RE.test(name)) score -= 50;      // virtual NIC demotion
      scored.push({ ip: i.address, score });
    }
  }
  return scored.sort((x, y) => y.score - x.score).map((s) => s.ip);
}

// Persist runtime config (port + apiKey + name + dashboardUrl) so the
// dashboard backend can auto-discover this agent (GET /api/mesh/local-agent
// reads agent-config.json) and the heartbeat target survives restarts.
// Merged with any existing file so extra fields survive.
const CONFIG_PATH = resolve(process.cwd(), 'agent-config.json');
function readPersistedConfig(): Record<string, unknown> {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}
function persistConfig(): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({
      ...readPersistedConfig(),
      port: PORT,
      apiKey: API_KEY,
      name: AGENT_NAME,
      ...(DASHBOARD_URL ? { dashboardUrl: DASHBOARD_URL } : {}),
      dbPath: resolve(process.cwd(), 'db', 'agent.db'),
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn(`[Agent] Failed to persist agent-config.json: ${err?.message}`);
  }
}
persistConfig();

// Multi-target heartbeat: one agent may be paired with SEVERAL dashboards
// (A joins B, later C joins A — A's agent must keep BOTH rows fresh, not
// re-point at the latest joiner only). Targets dedupe; capped at 8.
const HEARTBEAT_MAX_TARGETS = 8;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

function normalizeUrl(u: unknown): string {
  return String(u || '').trim().replace(/\/+$/, '');
}

function buildHeartbeatTargets(): string[] {
  const persisted = readPersistedConfig();
  const list = [
    DASHBOARD_URL,                                    // --dashboard CLI arg
    normalizeUrl(persisted.dashboardUrl),             // legacy single-target field
    ...(Array.isArray(persisted.dashboardUrls) ? persisted.dashboardUrls.map(normalizeUrl) : []),
  ].filter((u) => /^https?:\/\/.+/i.test(u));
  return [...new Set(list)].slice(0, HEARTBEAT_MAX_TARGETS);
}

let HEARTBEAT_TARGETS: string[] = buildHeartbeatTargets();

function persistHeartbeatTargets(): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({
      ...readPersistedConfig(),
      dashboardUrl: HEARTBEAT_TARGETS[0] || '', // legacy field (pre-upgrade agents)
      dashboardUrls: HEARTBEAT_TARGETS,
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn(`[Agent] Failed to persist heartbeat targets: ${err?.message}`);
  }
}

// ---- peer-cache relay ----
// Register/heartbeat RESPONSES now carry the dashboard side's own agent
// coordinates + project list (data.peer with data.peer.projects). Caching
// those entries lets our co-located dashboard read them over 127.0.0.1
// (GET /api/agent/peer-cache) — the only network leg guaranteed to work on
// one-way firewalled networks: OUR heartbeat reached the peer, so the
// peer's data came back on the response. Nothing here needs to connect
// inbound to us, which firewalls may block.
interface PeerCacheEntry {
  at: number;
  peer: { name?: string; ip?: string; port?: number; apiKey?: string };
  projects: any[];
}
const PEER_CACHE_MAX = 8; // mirrors HEARTBEAT_MAX_TARGETS
const peerCache = new Map<string, PeerCacheEntry>();

function cachePeerFromRegisterResponse(data: any): void {
  const peer = data && typeof data === 'object' ? data.peer : null;
  const projects = peer && Array.isArray(peer.projects) ? peer.projects : null;
  const key = peer && peer.apiKey ? String(peer.apiKey) : '';
  if (!key || !projects) return;
  peerCache.set(key, {
    at: Date.now(),
    peer: { name: peer.name, ip: peer.ip, port: peer.port, apiKey: key },
    projects,
  });
  // Cap the cache: heartbeat targets are capped at 8 — keep the newest 8.
  if (peerCache.size > PEER_CACHE_MAX) {
    const oldest = [...peerCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) peerCache.delete(oldest[0]);
  }
}

// Re-armable heartbeat scheduler: the pair-target endpoint can point this
// agent at a dashboard AFTER boot (the web-UI join flow does exactly that),
// so the timer must be startable lazily, not only at startup.
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
function armHeartbeat(): void {
  if (HEARTBEAT_TARGETS.length === 0) return;
  if (heartbeatTimer) return; // already armed
  console.log(`[Agent][heartbeat] re-registering with ${HEARTBEAT_TARGETS.length} dashboard(s) every ${HEARTBEAT_INTERVAL_MS / 1000}s`);
  setTimeout(reRegisterWithDashboards, 3000).unref?.();
  heartbeatTimer = setInterval(reRegisterWithDashboards, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

// Heartbeat: re-register with EVERY paired dashboard each cycle so each
// Device row always points at our CURRENT ip:port — self-heals IP drift
// (DHCP / new network) and port drift. POST /api/mesh/register accepts
// {apiKey} WITHOUT a pair code for devices that already paired (key is
// the credential).
async function reRegisterWithDashboards(): Promise<void> {
  await Promise.allSettled(HEARTBEAT_TARGETS.map((t) => reRegisterWithDashboard(t)));
}

async function reRegisterWithDashboard(target: string): Promise<void> {
  const payload: Record<string, unknown> = {
    name: AGENT_NAME,
    ip: lanIpCandidates()[0] || '127.0.0.1',
    port: PORT,
    apiKey: API_KEY,
  };
  // PUSH the project list with every heartbeat: a peer whose firewall
  // blocks INBOUND connections (Windows Defender — outbound still works)
  // records this data and serves it read-only, so one-way networks get
  // project visibility in BOTH directions. A listing failure must not
  // break the row self-heal — push only what we got.
  try {
    payload.projects = await buildPeerProjects();
    // v1.12: co-located DB state — lets the dashboard tell "0 projects
    // because the agent found no dashboard DB" apart from a sync failure.
    payload.agentMeta = dashboardDbState();
  } catch { /* listing failed — heartbeat still updates the row */ }
  try {
    const res = await fetch(`${target}/api/mesh/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data: any = await res.json().catch(() => ({}));
      // Relay: cache the peer's agent coordinates + project list that came
      // back on the heartbeat response (see peerCache above).
      cachePeerFromRegisterResponse(data);
      if (data.addressFixed) {
        console.log(`[Agent][heartbeat] dashboard row healed → ${payload.ip}:${payload.port}`);
      }
      // Update signal (dashboard v1.10+): the newest code sha this dashboard
      // knows of. When our clone is stale → pull + respawn ourselves (v1.10
      // agents; older builds ignore the field).
      scheduleSelfUpdateFromHeartbeat(data?.updateSignal);
      // repoSync overrides (dashboard v1.11+): GitHub links the dashboard
      // cached for OUR projects — set there while this machine was
      // unreachable or firewalled. Write them into the projects' home
      // stores so they propagate to every dashboard (best-effort).
      try { await applyRepoUrlOverrides(data?.repoSync); } catch { /* best-effort */ }
    } else if (res.status !== 400) {
      // 400 = key unknown to this dashboard (not ours / DB reset) — skip
      console.warn(`[Agent][heartbeat] dashboard ${target} responded ${res.status}`);
    }
  } catch { /* dashboard unreachable — retry next cycle */ }
}

// ======================== DATABASE ========================

const dbPath = resolve(process.cwd(), 'db', 'agent.db');
const db = new PrismaClient({
  datasources: { db: { url: `file:${dbPath}` } },
});

// ======================== CO-LOCATED DASHBOARD DB ========================

// Machines running the FULL dashboard keep their projects in the dashboard's
// SQLite. This agent's own DB starts EMPTY — so on dashboard machines,
// remote peers saw ZERO projects even though the local UI listed them (user
// report: the peer dashboard showed the machine "online" with 0 projects).
// When a co-located dashboard DB is found, project reads AND control
// operations resolve against it:
//   * listings serve the dashboard's OWN projects (deviceId IS NULL).
//     Rows the remote side mirrored back (deviceId set) are excluded —
//     that's what keeps the mesh mirror loop-free.
//   * status/pid writes land in the same rows the local dashboard reads,
//     so both views stay consistent.
//   * standalone agent-DB projects are still listed and controlled.
// Override: --dashboardDb <path> (or "dashboardDb" in agent-config.json).
//
// v1.12 detection hardening — the DB lives wherever the co-located
// dashboard's DATABASE_URL points, and the old probe (cwd/../../db only)
// missed two real-world cases:
//   1. .env with a RELATIVE SQLite URL: Prisma resolves it against the
//      SCHEMA directory, so DATABASE_URL=file:./db/custom.db actually
//      puts the file at <repo>/prisma/db/custom.db — a perfectly working
//      dashboard whose agent stays blind and serves [] to every peer
//      ("device online, 0 projects" on the other machines).
//   2. Boot order: the agent started before the dashboard's first run
//      created the file, and the boot-time probe result was cached
//      forever.
// Detection is therefore (a) multi-candidate — explicit arg > .env-derived
// > __dirname-anchored > cwd-anchored — and (b) LAZY: a miss is re-probed
// at most once a minute so a DB created later is adopted without a restart.
// Candidates are derived from this file's own location (__dirname), immune
// to whatever cwd the process was spawned with.
const DASHBOARD_DB_ARG = getArg('dashboardDb', '');
const AGENT_REPO_ROOT = resolve(__dirname, '..', '..');

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** Candidate co-located dashboard DB locations, most-trusted first. */
function dashboardDbCandidates(): string[] {
  const out: string[] = [];
  const push = (p?: string) => { if (p) { const r = resolve(p); if (!out.includes(r)) out.push(r); } };
  // 1) explicit overrides
  push(DASHBOARD_DB_ARG || undefined);
  push(String(readPersistedConfig().dashboardDb || '') || undefined);
  // 2) the co-located dashboard's OWN configuration: .env DATABASE_URL.
  //    Absolute URLs are used as-is; relative ones are probed against BOTH
  //    the repo root and the prisma/ schema dir (Prisma resolves relative
  //    SQLite paths against the schema file's location, not the cwd).
  try {
    const envTxt = readFileSync(join(AGENT_REPO_ROOT, '.env'), 'utf-8');
    const m = envTxt.match(/^\s*DATABASE_URL\s*=\s*file:(\S+?)\s*$/m);
    const raw = m?.[1]?.replace(/^["']|["']$/g, '');
    if (raw) {
      if (isAbsolute(raw)) push(raw);
      else {
        push(join(AGENT_REPO_ROOT, raw));
        push(join(AGENT_REPO_ROOT, 'prisma', raw));
      }
    }
  } catch { /* no .env here — fall through to the conventional spots */ }
  // 3) conventional locations (cwd-independent first, legacy last)
  push(join(AGENT_REPO_ROOT, 'db', 'custom.db'));
  push(join(process.cwd(), '..', '..', 'db', 'custom.db'));
  push(join(process.cwd(), 'db', 'custom.db')); // started from the repo root
  return out;
}

function detectDashboardDb(): string | null {
  for (const c of dashboardDbCandidates()) {
    if (isFile(c)) return c;
  }
  return null;
}

let coDashPath: string | null = detectDashboardDb();
let coDashClient: PrismaClient | null = coDashPath
  ? new PrismaClient({ datasources: { db: { url: `file:${coDashPath}` } } })
  : null;
let coDashProbeAt = 0;

/** The co-located dashboard DB client, or null while none is detected.
 *  NOTE: only raw queries ($queryRawUnsafe / $executeRawUnsafe) run against
 *  it — the generated client schema doesn't know the dashboard's deviceId
 *  column, and raw SQL bypasses that entirely. */
function getDashDb(): PrismaClient | null {
  if (coDashClient) return coDashClient;
  if (Date.now() < coDashProbeAt) return null;
  coDashProbeAt = Date.now() + 60_000;
  const found = detectDashboardDb();
  if (found) {
    coDashPath = found;
    coDashClient = new PrismaClient({ datasources: { db: { url: `file:${found}` } } });
    dashColumnsProbed = false; // re-probe schema capabilities for the new DB
    console.log(`[Agent] Co-located dashboard DB detected (late): ${found}`);
    console.log('[Agent] Serving its local (deviceId IS NULL) projects to remote peers');
  }
  return coDashClient;
}

/** Live co-located-DB state, reported to peers via the heartbeat payload and
 *  /api/agent/projects meta — lets a dashboard tell "0 projects because
 *  the agent found no dashboard DB" apart from a sync failure. */
function dashboardDbState(): { dashboardDbFound: boolean; dashboardDbPath: string | null } {
  const client = getDashDb();
  return { dashboardDbFound: !!client, dashboardDbPath: client ? coDashPath : null };
}

if (coDashClient && coDashPath) {
  console.log(`[Agent] Co-located dashboard DB: ${coDashPath}`);
  console.log('[Agent] Serving its local (deviceId IS NULL) projects to remote peers');
}

/** Apply repoSync overrides that arrived on a heartbeat RESPONSE (dashboard
 *  v1.11+): GitHub links a peer dashboard cached for OUR projects — set
 *  there while this machine was unreachable, or over a one-way-firewalled
 *  network. Write each link into whichever store owns the project (the
 *  co-located dashboard DB row first, this agent's own DB row second) so it
 *  propagates to EVERY dashboard including the project's home machine.
 *  Empty-only fill (repoUrl = ''): a link the home machine already set (or
 *  cleared) always wins on its own rows — we only ever FILL gaps. */
async function applyRepoUrlOverrides(entries: any): Promise<void> {
  if (!Array.isArray(entries) || entries.length === 0) return;
  let applied = 0;
  for (const e of entries.slice(0, 50)) {
    if (!e || typeof e !== 'object') continue;
    const repoUrl = normalizeRepoUrl(e.repoUrl);
    const id = String(e.id || '');
    if (!repoUrl || !id) continue;
    // 1) The project's home store: the co-located dashboard DB row
    //    (deviceId IS NULL keeps the mesh mirror loop-free; empty-only fill).
    if (getDashDb()) {
      try {
        const cols = await ensureDashColumns();
        if (cols.has('repoUrl')) {
          const n = await getDashDb().$executeRawUnsafe(
            'UPDATE "Project" SET "repoUrl" = ?, "updatedAt" = ? WHERE "id" = ? AND "deviceId" IS NULL AND "repoUrl" = \'\'',
            repoUrl, Date.now(), id,
          );
          if (n > 0) { applied++; continue; }
        }
      } catch { /* dashboard schema lacks the column / db busy — fall through */ }
    }
    // 2) This agent's own DB (standalone agent-DB projects). Empty-only
    //    fill, same rule.
    try {
      const row = await db.project.findUnique({ where: { id } });
      if (row && !String(row.repoUrl || '').trim()) {
        await db.project.update({ where: { id }, data: { repoUrl } });
        applied++;
      }
    } catch { /* unknown id — skip */ }
  }
  if (applied > 0) {
    console.log(`[Agent][repoSync] applied ${applied} GitHub link(s) received from a peer dashboard`);
  }
}

// Dashboard-schema capability probe (run once, lazily): older co-located
// dashboards lack the repoUrl/notes columns — SQL touching them would throw
// and take the whole listing down. Probe PRAGMA table_info and expose
// "does the home dashboard know this column?".
const dashColumns = new Set<string>();
let dashColumnsProbed = false;
async function ensureDashColumns(): Promise<Set<string>> {
  if (!getDashDb() || dashColumnsProbed) return dashColumns;
  dashColumnsProbed = true;
  try {
    const rows = await getDashDb().$queryRawUnsafe('PRAGMA table_info("Project")') as any[];
    for (const r of rows) if (r && typeof r.name === 'string') dashColumns.add(r.name);
  } catch { /* unreadable — assume the legacy column set */ }
  return dashColumns;
}
/** Listing column list: base columns + repoUrl/notes when the home
 *  dashboard's schema has them (so remote peers can sync the GitHub link). */
async function projectCols(): Promise<string> {
  const cols = await ensureDashColumns();
  const extra = [
    cols.has('repoUrl') ? '"repoUrl"' : '',
    cols.has('notes') ? '"notes"' : '',
  ].filter(Boolean);
  return `"id","name","path","description","icon","tags","order","createdAt","updatedAt"${extra.length ? ',' + extra.join(',') : ''}`;
}

/** Normalize a repo URL: https-only, credentials stripped, '' clears.
 *  Identical to the dashboard's normalizeRepoUrl so both sides agree. */
function normalizeRepoUrl(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  if (!/^https:\/\/[\w.-]+\//i.test(s) && !/^https:\/\/[^/\s]+$/i.test(s)) return '';
  try {
    const u = new URL(s);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}
/** Tags arrive as an ARRAY from the dashboard's edit form but the column is
 *  a JSON STRING — normalize exactly like the dashboard's own route. */
function normalizeTagsValue(raw: unknown): string | undefined {
  if (Array.isArray(raw)) return JSON.stringify(raw.filter((t) => typeof t === 'string'));
  if (typeof raw === 'string') return raw;
  return undefined;
}

// ---- raw-row mappers (SQLite dates come back as numbers/strings) ----
function toDate(v: any): Date { return v instanceof Date ? v : new Date(Number(v) || String(v)); }
function toInt(v: any, fallback = 0): number { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function toPid(v: any): number | null { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

// Base listing columns — the async projectCols() adds repoUrl/notes when
// the co-located dashboard's schema has them.
const PROJECT_COLS = '"id","name","path","description","icon","tags","order","createdAt","updatedAt"';
const ENV_COLS = '"id","projectId","name","cmd","port","envVars","status","pid","createdAt","updatedAt"';

function mapEnvRow(e: any) {
  return {
    id: e.id,
    projectId: e.projectId,
    name: e.name,
    cmd: e.cmd,
    port: toInt(e.port),
    envVars: typeof e.envVars === 'string' ? e.envVars : JSON.stringify(e.envVars || {}),
    status: e.status || 'stopped',
    pid: toPid(e.pid),
    createdAt: toDate(e.createdAt),
    updatedAt: toDate(e.updatedAt),
  };
}

function mapProjectRow(p: any, envs: any[]) {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    description: p.description ?? '',
    icon: p.icon ?? 'folder',
    tags: typeof p.tags === 'string' ? p.tags : JSON.stringify(p.tags || []),
    // Present only when the home dashboard's schema carries them (dynamic
    // column list) — undefined keeps older peers' locally-set values alive.
    ...(p.repoUrl !== undefined && p.repoUrl !== null && { repoUrl: String(p.repoUrl) }),
    ...(p.notes !== undefined && p.notes !== null && { notes: String(p.notes) }),
    order: toInt(p.order),
    createdAt: toDate(p.createdAt),
    updatedAt: toDate(p.updatedAt),
    environments: envs,
  };
}

async function dashEnvsFor(projectIds: string[]): Promise<Map<string, any[]>> {
  const byProject = new Map<string, any[]>();
  if (!getDashDb() || projectIds.length === 0) return byProject;
  const rows: any[] = await getDashDb().$queryRawUnsafe(
    `SELECT ${ENV_COLS} FROM "Environment" WHERE "projectId" IN (${projectIds.map(() => '?').join(',')})`,
    ...projectIds,
  );
  for (const e of rows) {
    const mapped = mapEnvRow(e);
    const list = byProject.get(mapped.projectId) || [];
    list.push(mapped);
    byProject.set(mapped.projectId, list);
  }
  return byProject;
}

/** All of THIS machine's own dashboard projects (loop-safe filter). */
async function listDashProjects(): Promise<any[]> {
  if (!getDashDb()) return [];
  try {
    const rows: any[] = await getDashDb().$queryRawUnsafe(
      `SELECT ${await projectCols()} FROM "Project" WHERE "deviceId" IS NULL ORDER BY "order" ASC, "updatedAt" DESC`
    );
    const envs = await dashEnvsFor(rows.map((r) => r.id));
    return rows.map((r) => mapProjectRow(r, envs.get(r.id) || []));
  } catch (err: any) {
    console.warn(`[Agent] dashboard DB listing failed: ${err?.message}`);
    return [];
  }
}

/** Minimal {id, path} rows of the co-located dashboard's own projects —
 *  feeds /api/agent/versions so dash-managed rows (served in listings via
 *  buildPeerProjects) get version chips too, not just agent-DB rows. */
async function listDashProjectPaths(): Promise<{ id: string; path: string }[]> {
  if (!getDashDb()) return [];
  try {
    return await getDashDb().$queryRawUnsafe('SELECT "id", "path" FROM "Project" WHERE "deviceId" IS NULL');
  } catch { return []; }
}

async function getDashProject(id: string): Promise<any | null> {
  if (!getDashDb()) return null;
  try {
    const rows: any[] = await getDashDb().$queryRawUnsafe(
      `SELECT ${await projectCols()} FROM "Project" WHERE "id" = ? AND "deviceId" IS NULL`, id
    );
    if (rows.length === 0) return null;
    const envs = await dashEnvsFor([id]);
    return mapProjectRow(rows[0], envs.get(id) || []);
  } catch { return null; }
}

/** Env + owning project path from the dashboard DB, or null. */
async function getDashEnvFull(projectId: string, envId: string): Promise<{ env: any; projectPath: string } | null> {
  if (!getDashDb()) return null;
  try {
    const rows: any[] = await getDashDb().$queryRawUnsafe(
      `SELECT e."id", e."projectId", e."name", e."cmd", e."port", e."envVars", e."status", e."pid", e."createdAt", e."updatedAt", p."path" AS "projectPath"
       FROM "Environment" e JOIN "Project" p ON p."id" = e."projectId"
       WHERE e."id" = ? AND e."projectId" = ? AND p."deviceId" IS NULL`,
      envId, projectId,
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    const projectPath = r.projectPath;
    const env = mapEnvRow(r);
    return { env, projectPath };
  } catch { return null; }
}

/** Update status/pid on a dashboard env row (process control writes). */
async function setDashEnvState(envId: string, data: { status?: string; pid?: number | null }): Promise<void> {
  if (!getDashDb()) return;
  const sets: string[] = [];
  const params: any[] = [];
  if (data.status !== undefined) { sets.push('"status" = ?'); params.push(data.status); }
  if (data.pid !== undefined) { sets.push('"pid" = ?'); params.push(data.pid); }
  if (sets.length === 0) return;
  sets.push('"updatedAt" = ?'); params.push(Date.now());
  params.push(envId);
  await getDashDb().$executeRawUnsafe(`UPDATE "Environment" SET ${sets.join(', ')} WHERE "id" = ?`, ...params);
}

/** Env resolution across BOTH stores: dashboard DB first, agent DB second. */
async function resolveEnv(projectId: string, envId: string): Promise<{ env: any; projectPath: string; fromDash: boolean } | null> {
  if (getDashDb()) {
    const dashHit = await getDashEnvFull(projectId, envId);
    if (dashHit) return { ...dashHit, fromDash: true };
  }
  const env = await db.environment.findUnique({ where: { id: envId }, include: { project: true } });
  if (!env || env.projectId !== projectId) return null;
  return { env, projectPath: (env as any).project.path, fromDash: false };
}

/** Write a start/stop outcome back to whichever store owns the env. */
async function persistEnvState(envId: string, fromDash: boolean, data: { status: string; pid?: number | null }): Promise<void> {
  if (fromDash) {
    await setDashEnvState(envId, data).catch(() => {});
  } else {
    await db.environment.update({ where: { id: envId }, data: { status: data.status, pid: data.pid ?? null } }).catch(() => {});
  }
}

// ---- agent-DB bootstrap ----
// A fresh clone (or a machine where nobody ran `prisma db push` in
// mini-services/agent) has an agent.db WITHOUT tables — every prisma call
// then fails with P2021, /api/agent/projects returns 500, and remote
// dashboards mark the device OFFLINE (real-world report: "paired but
// devices can't see each other / no remote projects"). The agent creates
// its own tables at boot instead of depending on a manual push.
const AGENT_DDL = [
  'CREATE TABLE IF NOT EXISTS "Project" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "path" TEXT NOT NULL, "description" TEXT NOT NULL DEFAULT \'\', "icon" TEXT NOT NULL DEFAULT \'folder\', "tags" TEXT NOT NULL DEFAULT \'[]\', "repoUrl" TEXT NOT NULL DEFAULT \'\', "notes" TEXT NOT NULL DEFAULT \'\', "order" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL)',
  'CREATE UNIQUE INDEX IF NOT EXISTS "Project_path_key" ON "Project"("path")',
  'CREATE TABLE IF NOT EXISTS "Environment" ("id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL, "name" TEXT NOT NULL, "cmd" TEXT NOT NULL, "port" INTEGER NOT NULL, "envVars" TEXT NOT NULL DEFAULT \'{}\', "status" TEXT NOT NULL DEFAULT \'stopped\', "pid" INTEGER, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL, CONSTRAINT "Environment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE)',
  'CREATE INDEX IF NOT EXISTS "Environment_projectId_idx" ON "Environment"("projectId")',
  // ---- column migrations for PRE-repoUrl agent.db files ----
  // CREATE TABLE IF NOT EXISTS never upgrades an EXISTING table: an agent.db
  // created before repoUrl/notes existed keeps the old schema, while the
  // regenerated Prisma client SELECTs the new columns on every project
  // query — each one then fails with "The column `repoUrl` does not exist
  // in the current database" (listing degrades to [], PUT/pull 500 with a
  // Prisma dump). The ALTERs below upgrade old files IN PLACE at boot; on
  // already-migrated (or fresh) databases they fail with a harmless
  // "duplicate column" that the loop below deliberately swallows.
  'ALTER TABLE "Project" ADD COLUMN "repoUrl" TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE "Project" ADD COLUMN "notes" TEXT NOT NULL DEFAULT \'\'',
  // deviceId: the agent's own schema has no such field, but when the agent
  // resolves @prisma/client from the REPO ROOT (no per-agent node_modules —
  // e.g. `bun mini-services/agent/index.ts` straight after a root install),
  // the ROOT generated client SELECTs Project.deviceId on every query — a
  // missing column took down every agent-own-DB project operation (500 on
  // create, listing degraded to []). Nullable, no default.
  'ALTER TABLE "Project" ADD COLUMN "deviceId" TEXT',
];

async function ensureAgentDb(): Promise<void> {
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch { /* read-only fs — prisma will surface a clear error later */ }
  for (const ddl of AGENT_DDL) {
    try { await db.$executeRawUnsafe(ddl); } catch (err: any) {
      // "duplicate column" = the table already has it (fresh CREATE or an
      // earlier migration) — expected, stay silent. Anything else is real.
      if (!/duplicate column/i.test(String(err?.message || ''))) {
        console.warn(`[Agent] bootstrap DDL failed: ${err?.message}`);
      }
    }
  }
}

/** Agent-DB listing that NEVER throws — a broken/missing agent DB must not
 *  take down the (working) dashboard-DB projects listing. */
async function safeAgentProjects(): Promise<any[]> {
  try {
    return await db.project.findMany({
      include: { environments: true },
      orderBy: [{ order: 'asc' }, { updatedAt: 'desc' }],
    });
  } catch (err: any) {
    console.warn(`[Agent] agent-DB listing unavailable: ${err?.message}`);
    return [];
  }
}

/**
 * The project list served to peers — GET /api/agent/projects AND every
 * heartbeat push (one source of truth). Co-located dashboard projects
 * (deviceId IS NULL) merged with standalone agent-DB projects, each env
 * status refreshed from the live port state.
 *
 * DUAL-STORE MERGE (by path): a machine can hold the SAME project in BOTH
 * stores — the dashboard row (created via the web UI, carries repoUrl) AND
 * an older standalone agent-DB row (repoUrl ''). Serving both made the
 * peer's dedupe drop the dashboard row's GitHub link (the card showed no
 * repo chip) while the pull resolved the agent row and failed with
 * "No 'origin' remote is configured". One row per path now: the row with
 * the richer environment list is the base; repoUrl/notes come from
 * whichever store actually has them.
 */
function mergeRepoField(a: unknown, b: unknown): string | undefined {
  const av = typeof a === 'string' ? a.trim() : '';
  const bv = typeof b === 'string' ? b.trim() : '';
  if (av) return av;
  if (bv) return bv;
  return undefined; // neither store knows — omit the key entirely
}

function normalizePathKey(p: unknown): string {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

async function buildPeerProjects(): Promise<any[]> {
  const [dashProjects, agentProjects] = await Promise.all([
    listDashProjects(),
    safeAgentProjects(),
  ]);

  // One row per path — see the dual-store merge note above.
  const byPath = new Map<string, any>();
  for (const project of [...dashProjects, ...agentProjects]) {
    const key = normalizePathKey(project.path);
    const existing = byPath.get(key);
    if (!existing) {
      byPath.set(key, project);
      continue;
    }
    const existingEnvs = existing.environments?.length ?? 0;
    const incomingEnvs = project.environments?.length ?? 0;
    const base = incomingEnvs > existingEnvs ? project : existing;
    const other = base === existing ? project : existing;
    const mergedRepoUrl = mergeRepoField(base.repoUrl, other.repoUrl);
    const mergedNotes = mergeRepoField(base.notes, other.notes);
    byPath.set(key, {
      ...base,
      ...(mergedRepoUrl !== undefined && { repoUrl: mergedRepoUrl }),
      ...(mergedNotes !== undefined && { notes: mergedNotes }),
    });
  }
  const projects: any[] = Array.from(byPath.values());

  const allPorts = projects.flatMap(p => p.environments.map(e => e.port));
  const portChecks = await Promise.all(allPorts.map(p => checkPortStatus(p).then(ok => [p, ok] as const)));
  const activePorts = new Map(portChecks);

  return projects.map(project => ({
    ...project,
    environments: project.environments.map(env => ({
      ...env,
      status: activePorts.get(env.port) ? 'running' : 'stopped',
    })),
  }));
}

// ======================== LOG DIRECTORY (Cross-Platform) ========================

// Windows: %APPDATA%\dashboard-agent-logs  or  %TEMP%\dashboard-agent-logs
// Unix:    /tmp/dashboard-agent-logs
const LOG_DIR = IS_WINDOWS
  ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'dashboard-agent-logs')
  : join(tmpdir(), 'dashboard-agent-logs');

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}
console.log(`[Agent] Log directory: ${LOG_DIR}`);

// ======================== PROCESS MANAGER ========================

const runningProcesses = new Map<string, ChildProcess>();

function getProcessKey(projectId: string, envName: string): string {
  return `${projectId}:${envName}`;
}

/**
 * Strip shell prologues the dashboard's LLM agent (dsh) emits before the
 * real command: VAR=value assignments, `unset NAME [&&]` guards (stray
 * PORT/TURBOPACK leaks interfered with the server under test),
 * `export VAR=value [&&]`, and stray '&&' separators. Mirrors
 * src/lib/cmd-allowlist.ts on the dashboard side.
 */
function stripShellPrologue(cmdStr) {
  let s = String(cmdStr || '').trim();
  for (let i = 0; i < 8; i++) {
    const next = s
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+(?=\S)/, '')
      .replace(/^unset\s+[A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*)*\s*(?:&&\s*)?/i, '')
      .replace(/^export\s+[A-Za-z_][A-Za-z0-9_]*=\S*\s*(?:&&\s*)?/i, '')
      .replace(/^&&\s*/, '')
      .trimStart();
    if (next === s) break;
    s = next;
  }
  return s;
}

function isCommandSafe(cmd: string): boolean {
  // Block dangerous commands
  const blocked = [
    /rm\s+-rf\s+\//, /fork\s*\(/, /:()\s*{\s*:\s*\|\s*:&\s*}/,
    /dd\s+if=/, /mkfs/, /chmod\s+777/,
    /curl.*\|\s*(ba)?sh/, /wget.*\|\s*(ba)?sh/,
    /del\s+\/[sS]\s+\\/, /format\s+[a-zA-Z]:/, /rd\s+\/[sS]\s+\/[qQ]\s+\\/  // Windows dangerous
  ];
  for (const pattern of blocked) {
    if (pattern.test(cmd)) return false;
  }

  const allowed = [
    'npm', 'npx', 'yarn', 'pnpm', 'bun', 'node',
    'python', 'python3', 'py',
    'go', 'cargo', 'dotnet', 'java', 'ruby', 'rails',
    'docker', 'docker-compose', 'make', 'gradle',
    'cmd', 'powershell', 'pwsh',  // Windows common
    'npm.cmd', 'npx.cmd', 'yarn.cmd', 'pnpm.cmd',  // Windows npm wrappers
  ];
  // First REAL command word — after stripping the shell prologue
  // (VAR=value / `unset NAME &&` / `export VAR=… &&`) the LLM prepends.
  const first = stripShellPrologue(cmd).split(/\s+/)[0];
  const base = first.split(/[/\\]/).pop() || '';
  return allowed.some(a => base === a || base.startsWith(a));
}

/**
 * Kill a process cross-platform
 * - Unix: SIGTERM, then SIGKILL after timeout
 * - Windows: taskkill /PID /T /F (tree kill)
 */
function killProcess(pid: number, force: boolean = false): boolean {
  try {
    if (IS_WINDOWS) {
      // Windows: use taskkill for tree-kill (kills child processes too)
      const forceFlag = force ? '/F' : '';
      execSync(`taskkill /PID ${pid} /T ${forceFlag}`, { stdio: 'pipe', timeout: 5000 });
      return true;
    } else {
      // Unix: use signal-based kill
      const signal = force ? 'SIGKILL' : 'SIGTERM';
      process.kill(pid, signal);
      return true;
    }
  } catch {
    return false;
  }
}

/** Explain an immediate exit with enough context to act on: exit code,
 *  common PATH/permission meanings, the command's own dying output and
 *  where the full log lives. A bare "Process exited immediately" gave the
 *  user no way to tell a missing bun (service PATH) from a port clash from
 *  a crashed app (real user report: some remote projects fail, one works).
 *  Windows services/launchd agents see a MINIMAL PATH — exit 127/9009 with
 *  an empty log is the classic signature. */
function describeImmediateExit(
  code: number | null,
  cmd: string,
  output: string,
  logFile: string
): { error: string; detail: string; logFile: string } {
  const codeNo = code === null ? -1 : code;
  const hints: Record<string, string> = {
    '127': 'command not found — the start command is not on the AGENT\'s PATH (if the agent runs as a service/launchd it sees a different PATH than your shell; use an absolute path)',
    '126': 'command found but not executable (permission denied)',
    '9009': 'Windows: command not recognized — not on the AGENT\'s PATH (agents running as a Windows service see a minimal PATH; use an absolute path, e.g. C:\\Users\\<you>\\.bun\\bin\\bun.exe)',
  };
  const hint = hints[String(codeNo)] || '';
  const tail = (output || '').trim().slice(-1200);
  return {
    error: `Process exited immediately (exit code ${codeNo}${hint ? ' — ' + hint : ''})`,
    detail: [
      `command: ${cmd}`,
      tail || '(no output captured before exit)',
      `full log on this machine: ${logFile}`,
    ].join('\n'),
    logFile,
  };
}

/** Strip Next.js-internal env vars from an env object (mutates + returns
 * it). Used wherever the agent spawns a CHILD process for a user project:
 * inherited TURBOPACK=1 / NEXT_RUNTIME / __NEXT_PRIVATE_* collide with the
 * child's own bundler choice ("Multiple bundler flags set: TURBOPACK=1,
 * --webpack" → instant exit 0) and its NODE_ENV checks. */
function stripNextInternals(env: Record<string, string>): Record<string, string> {
  delete env.TURBOPACK;
  delete env.NEXT_RUNTIME;
  delete env.NEXT_DEPLOYMENT_ID;
  delete env.__NEXT_PROCESSED_ENV;
  for (const k of Object.keys(env)) {
    if (typeof k === 'string' && k.indexOf('__NEXT_PRIVATE_') === 0) delete env[k];
  }
  return env;
}

async function startProcess(
  projectId: string,
  envName: string,
  cmd: string,
  projectPath: string,
  envVars: Record<string, string>,
  port: number
): Promise<{ success: boolean; pid?: number; error?: string; detail?: string; logFile?: string }> {
  if (!isCommandSafe(cmd)) {
    return { success: false, error: `Command not allowed: ${cmd}` };
  }

  const key = getProcessKey(projectId, envName);

  // Kill existing process if running
  if (runningProcesses.has(key)) {
    const existing = runningProcesses.get(key)!;
    try {
      if (existing.pid) killProcess(existing.pid);
    } catch {}
    runningProcesses.delete(key);
  }

  const logFile = join(LOG_DIR, `${key.replace(/[:\\]/g, '_')}.log`);

  try {
    const env = {
      ...process.env,
      ...envVars,
      PORT: String(port),
      NODE_ENV: envVars.NODE_ENV || 'production',
    } as Record<string, string>;

    // Sanitize env — remove agent-specific vars AND the Next.js internals
    // this agent's own parent may have exported. Agents frequently run
    // INSIDE a dashboard `next dev` process tree (spawned by the
    // instrumentation hook): next-server exports TURBOPACK=1 to its
    // children, the agent inherits it and then leaks it into EVERY project
    // it starts — a child whose dev script pins --webpack dies instantly
    // with "Multiple bundler flags set: TURBOPACK=1, --webpack" (exit 0,
    // the #1 remote-start failure). A started project is an independent
    // process: it must pick its bundler from its OWN scripts, not ours.
    delete env.DATABASE_URL;
    delete env.__NEXT_PRIVATE_ROOT_RENDER_ID;
    stripNextInternals(env);

    // NODE_ENV must be a value the child's Next.js accepts — `next dev`
    // warns on non-standard values AND on 'production' for dev servers.
    // Configured standard values pass through; anything else (missing or
    // custom) is inferred from the environment's own name.
    const cfgNodeEnv = String((envVars && envVars.NODE_ENV) || '');
    if (cfgNodeEnv !== 'development' && cfgNodeEnv !== 'production' && cfgNodeEnv !== 'test') {
      env.NODE_ENV = /dev/i.test(String(envName || '')) ? 'development' : 'production';
    }

    // Add node_modules/.bin to PATH (cross-platform separator)
    const nodeBin = join(projectPath, 'node_modules', '.bin');
    if (existsSync(nodeBin)) {
      env.PATH = `${nodeBin}${PATH_SEP}${env.PATH}`;
    }

    // On Windows, use cmd.exe for shell if needed
    const spawnOptions: any = {
      cwd: projectPath,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    // On Unix, detach so child survives parent exit
    // On Windows, detached + unref has different semantics but still useful
    if (!IS_WINDOWS) {
      spawnOptions.detached = true;
    }

    const child = spawn(cmd, [], spawnOptions);

    // Log stdout and stderr — ALSO tap into an in-memory tail buffer: the
    // write stream may not have flushed when the immediate-exit check below
    // reads it, but the buffer is synchronous and always current.
    const logStream = createWriteStream(logFile, { flags: 'a' });

    // Write timestamp header
    logStream.write(`\n[${new Date().toISOString()}] === Process started: ${cmd} (port=${port}) ===\n`);

    let recentOut = '';
    const tap = (data: Buffer) => {
      recentOut = (recentOut + data.toString()).slice(-2048);
      logStream.write(data);
    };

    child.stdout?.on('data', tap);
    child.stderr?.on('data', tap);

    child.on('exit', (code) => {
      logStream.write(`\n[${new Date().toISOString()}] === Process exited with code ${code} ===\n`);
      runningProcesses.delete(key);
      try { logStream.end(); } catch {}
    });

    child.on('error', (err) => {
      console.error(`[Agent] Process error for ${key}:`, err.message);
      logStream.write(`\n[${new Date().toISOString()}] === Process error: ${err.message} ===\n`);
    });

    // On Unix, unref so child survives parent exit
    if (!IS_WINDOWS) {
      child.unref();
    }

    runningProcesses.set(key, child);

    // Wait and verify
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (child.exitCode !== null) {
      return { success: false, ...describeImmediateExit(child.exitCode, cmd, recentOut, logFile) };
    }

    return { success: true, pid: child.pid || undefined };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function stopProcess(
  projectId: string,
  envName: string,
  port: number
): Promise<{ success: boolean; error?: string }> {
  const key = getProcessKey(projectId, envName);

  const child = runningProcesses.get(key);
  if (child && child.pid) {
    try {
      killProcess(child.pid);
      // Wait for exit
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          // Force kill after timeout
          try { killProcess(child.pid!, true); } catch {}
          resolve();
        }, 3000);
        child.on('exit', () => { clearTimeout(timeout); resolve(); });
        // If already exited
        if (child.exitCode !== null) { clearTimeout(timeout); resolve(); }
      });
      runningProcesses.delete(key);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  // Try finding PID on port
  const pid = findPidOnPort(port);
  if (pid && pid !== process.pid) {
    try {
      killProcess(pid);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch {}
    return { success: true };
  }

  return { success: true };
}

/**
 * Find PID listening on a port — cross-platform
 * - Windows: netstat -ano | findstr :PORT | findstr LISTENING
 * - Unix: lsof or ss
 */
function findPidOnPort(port: number): number | null {
  try {
    if (IS_WINDOWS) {
      // Windows: netstat -ano
      const output = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      // Output format: "  TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    12345"
      const match = output.match(/LISTENING\s+(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    } else {
      // Unix: try lsof first, then ss
      try {
        const lsofOut = execSync(
          `lsof -t -i :${port} -sTCP:LISTEN 2>/dev/null`,
          { encoding: 'utf-8', timeout: 5000 }
        ).trim();
        if (lsofOut) return parseInt(lsofOut.split('\n')[0], 10);
      } catch {}

      try {
        const ssOut = execSync(
          `ss -tlnp 'sport = :${port}' 2>/dev/null`,
          { encoding: 'utf-8', timeout: 5000 }
        ).trim();
        const match = ssOut.match(/pid=(\d+)/);
        if (match) return parseInt(match[1], 10);
      } catch {}

      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Check if a port has an active listener — cross-platform
 */
async function checkPortStatus(port: number): Promise<boolean> {
  try {
    if (IS_WINDOWS) {
      const output = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      return output.length > 0;
    } else {
      const output = execSync(
        `ss -tlnp 'sport = :${port}' 2>/dev/null || lsof -t -i :${port} -sTCP:LISTEN 2>/dev/null`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      return output.length > 0;
    }
  } catch {
    return false;
  }
}

function getLogs(projectId: string, envName: string): string[] {
  const key = getProcessKey(projectId, envName).replace(/[:\\]/g, '_');
  const logFile = join(LOG_DIR, `${key}.log`);
  if (!existsSync(logFile)) return [];

  try {
    const content = readFileSync(logFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    return lines.slice(-200);
  } catch {
    return [];
  }
}

// ======================== AUTH MIDDLEWARE ========================

// ======================== GIT VERSION + ONE-CLICK PULL ========================
// Serves the dashboard cards' "branch @ sha · 3h ago" chip and the proxied
// one-click pull. Same response shape across every agent variant AND the
// dashboard's own src/lib/git-version.ts.

const execFileAsync = promisify(execFile);

async function readGitVersion(path: string): Promise<any> {
  if (!path || !existsSync(path) || !existsSync(join(path, '.git'))) return null;
  const v: any = { branch: null, sha: null, dirty: null, committedAt: null };
  try {
    // branch + short sha via rev-parse — `--format=%h` swallows --decorate.
    const [branchOut, shaOut] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path, timeout: 15000, maxBuffer: 64 * 1024 }),
      execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: path, timeout: 15000, maxBuffer: 64 * 1024 }),
    ]);
    v.branch = branchOut.stdout.trim() || null;
    v.sha = shaOut.stdout.trim() || null;
  } catch { return { ...v, error: 'git error' }; }
  try { v.committedAt = (await execFileAsync('git', ['log', '-1', '--format=%cI', 'HEAD'], { cwd: path, timeout: 15000, maxBuffer: 64 * 1024 })).stdout.trim() || null; } catch {}
  try { v.dirty = (await execFileAsync('git', ['status', '--porcelain'], { cwd: path, timeout: 15000, maxBuffer: 512 * 1024 })).stdout.split('\n').filter((l: string) => l.trim().length > 0).length; } catch {}
  return v;
}

/** An https repoUrl we are willing to auto-wire as 'origin' — https only
 *  (no ssh/file URLs: no interactive auth prompts, no local paths). */
function isHealableRepoUrl(u: unknown): u is string {
  return typeof u === 'string' && /^https:\/\/[^\s]+$/i.test(u.trim());
}

/** Cross-store repoUrl lookup for the pull route: the SAME path may exist
 *  in the co-located dashboard DB (repoUrl set via the web UI) AND in this
 *  agent's own DB (repoUrl ''). buildPeerProjects merges the stores for
 *  listings; pull resolves ONE row — when that row carries no healable
 *  repoUrl, this finds the link at the same path in either store. */
async function findRepoUrlByPath(projectPath: string, excludeId: string): Promise<string | null> {
  const key = normalizePathKey(projectPath);
  if (getDashDb()) {
    try {
      const cols = await ensureDashColumns();
      if (cols.has('repoUrl')) {
        const rows: any[] = await getDashDb().$queryRawUnsafe(
          'SELECT "id", "path", "repoUrl" FROM "Project" WHERE "deviceId" IS NULL',
        );
        for (const r of rows) {
          if (String(r?.id) === excludeId) continue;
          if (normalizePathKey(r?.path) === key && isHealableRepoUrl(r?.repoUrl)) {
            return String(r.repoUrl).trim();
          }
        }
      }
    } catch { /* dash DB unavailable */ }
  }
  try {
    const rows = await db.project.findMany({ select: { id: true, path: true, repoUrl: true } });
    for (const r of rows) {
      if (r.id === excludeId) continue;
      if (normalizePathKey(r.path) === key && isHealableRepoUrl(r.repoUrl)) {
        return String(r.repoUrl).trim();
      }
    }
  } catch { /* agent DB unavailable */ }
  return null;
}

/** Make sure the repo at projectPath has an 'origin' remote. Copied/zipped
 *  checkouts often carry .git but NO origin — `git pull` then dies with the
 *  cryptic "fatal: 'origin' does not appear to be a git repository". When
 *  the project row carries an https repoUrl, wire it up automatically. */
async function ensureOriginRemote(
  projectPath: string,
  repoUrl: string | null | undefined,
): Promise<{ originUrl: string | null; added?: boolean; error?: string; hint?: string }> {
  let originUrl: string | null = null;
  try {
    originUrl = ((await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: projectPath, timeout: 15000 })).stdout || '').trim() || null;
  } catch { /* no origin remote configured */ }
  if (originUrl) return { originUrl };
  if (!isHealableRepoUrl(repoUrl)) {
    return {
      originUrl: null,
      error: "No 'origin' remote is configured for this repository",
      hint: "Save the project's GitHub URL (https://…) so pull can wire it up — or on this machine run: git remote add origin <url>",
    };
  }
  const url = repoUrl.trim();
  await execFileAsync('git', ['remote', 'add', 'origin', url], { cwd: projectPath, timeout: 15000 });
  return { originUrl: url, added: true };
}

/** Validate a repoUrl that arrived in a REQUEST BODY (pull proxy from the
 *  calling dashboard): https-only, no whitespace, bounded length, any
 *  embedded credentials stripped. This is UNTRUSTED input that reaches
 *  `git remote add origin <url>` — normalize before it goes anywhere near
 *  git argv. Returns null when unusable (caller falls back to local rows). */
function normalizeBodyRepoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!isHealableRepoUrl(s) || s.length > 500) return null;
  try {
    const u = new URL(s);
    u.username = '';
    u.password = '';
    const out = u.toString().replace(/\/+$/, '');
    return isHealableRepoUrl(out) ? out : null;
  } catch { return null; }
}

// ---- Agent self-update (v1.10) ----
//
// The "zero manual maintenance" agent half: paired dashboards advertise the
// newest code sha on every heartbeat RESPONSE (updateSignal), and this agent
// pulls its own clone of the repo and respawns itself when stale. Works
// together with the dashboard-side supervisor (respawns the co-located
// agent after ITS machine pulls) — remote machines no longer need a human
// to `git pull` + restart the agent by hand.

/** Repo root of this agent's codebase (cwd = mini-services/<dir>, the repo
 *  root sits two levels up — resolve via git itself). null when the agent
 *  runs from a non-git distribution (zip) → self-update unavailable. */
async function agentRepoRoot(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(), timeout: 15_000, maxBuffer: 64 * 1024,
    });
    return stdout.trim() || null;
  } catch { return null; }
}

let selfUpdateBusy = false;
let lastSelfUpdateAt = 0;
const SELF_UPDATE_MIN_INTERVAL_MS = 3 * 60 * 1000;

/** Spawn a detached replacement process (waits for our port release, then
 *  re-execs this agent with the SAME argv) and exit shortly after — the
 *  delay lets the in-flight HTTP response flush. When the spawn itself
 *  fails we stay alive: the co-located dashboard's supervisor (or a human)
 *  can still restart us. */
function respawnSelf(reason: string): void {
  // Absolute entry when argv[1] was absolute (agent launched as
  // `bun /path/to/index.ts` from an arbitrary cwd — schedulers, services,
  // tests). A bare basename would then resolve against the WRONG cwd and
  // the respawn dies with `Module not found "index.ts"` (observed live).
  const rawEntry = process.argv[1] || 'index.ts';
  const entry = isAbsolute(rawEntry) ? rawEntry : basename(rawEntry);
  const argv = process.argv.slice(2).map((a) => `"${String(a).replace(/"/g, '')}"`).join(' ');
  const cwd = process.cwd().replace(/"/g, '');
  const exe = process.execPath.replace(/"/g, '');
  console.log(`[Agent][self-update] ${reason} — respawning (${exe} ${entry} ${argv})`);
  try {
    if (IS_WINDOWS) {
      // `timeout /t` needs an interactive stdin in detached cmd — the
      // classic ping-based sleep works headless. 2s is enough for the port
      // to be released by our exit below.
      spawn('cmd.exe', [
        '/c', `ping -n 3 127.0.0.1 >nul & cd /d "${cwd}" & "${exe}" "${entry}" ${argv}`,
      ], { detached: true, stdio: 'ignore', windowsHide: true });
    } else {
      const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      spawn('/bin/sh', ['-c',
        `sleep 2; cd ${q(cwd)} && exec ${q(exe)} ${q(entry)} ${argv} >> /tmp/dashboard-agent.log 2>&1`,
      ], { detached: true, stdio: 'ignore' });
    }
  } catch (e: any) {
    console.error('[Agent][self-update] respawn spawn failed — staying alive:', e?.message || e);
    return;
  }
  setTimeout(() => process.exit(0), 800);
}

/** Pull this agent's repo when SAFE and actually behind, then respawn.
 *  `signal` (optional, from a heartbeat response): { repoUrl, remoteSha } —
 *  repoUrl wires a missing 'origin'; remoteSha short-circuits the pull when
 *  we are already current. Guards: clean tree only, ff-only, busy lock,
 *  3-min floor between restarts (crash-loop guard). Never throws. */
async function performSelfUpdate(signal?: {
  repoUrl?: unknown; remoteSha?: unknown;
}): Promise<{ ok: boolean; action: string; detail?: string }> {
  if (selfUpdateBusy) return { ok: false, action: 'busy', detail: 'another self-update is in flight' };
  if (Date.now() - lastSelfUpdateAt < SELF_UPDATE_MIN_INTERVAL_MS) {
    return { ok: false, action: 'throttled', detail: 'self-updated less than 3 minutes ago' };
  }
  selfUpdateBusy = true;
  try {
    const root = await agentRepoRoot();
    if (!root) return { ok: false, action: 'skip', detail: 'agent code is not inside a git repository' };

    // origin remote — self-heal from the signal's https URL when missing.
    let origin: string | null = null;
    try {
      origin = (await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: root, timeout: 15_000 })).stdout.trim() || null;
    } catch { /* no origin */ }
    const sigUrl = typeof signal?.repoUrl === 'string' && isHealableRepoUrl(signal.repoUrl) ? signal.repoUrl.trim() : null;
    if (!origin && sigUrl) {
      await execFileAsync('git', ['remote', 'add', 'origin', sigUrl], { cwd: root, timeout: 15_000 });
      origin = sigUrl;
    }
    if (!origin) return { ok: false, action: 'skip', detail: "no 'origin' remote (and the update signal carried no https URL)" };

    // Fast path FIRST (no tree inspection): already at the advertised
    // commit → nothing to do. Heartbeats arrive every 60s and are almost
    // always current — this keeps the hot path at one rev-parse.
    const before = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 15_000 })).stdout.trim();
    const wantSha = typeof signal?.remoteSha === 'string' && /^[0-9a-f]{40}$/i.test(signal.remoteSha)
      ? signal.remoteSha.toLowerCase() : null;
    if (wantSha && before.toLowerCase() === wantSha) {
      return { ok: true, action: 'current', detail: 'already at the advertised commit' };
    }

    // Never pull over uncommitted local work.
    try {
      const { stdout: dirty } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: root, timeout: 30_000, maxBuffer: 512 * 1024,
      });
      if (dirty.trim().length > 0) {
        const n = dirty.trim().split('\n').length;
        return { ok: false, action: 'skip', detail: `working tree not clean (${n} changed file${n > 1 ? 's' : ''}) — pull skipped` };
      }
    } catch (e: any) {
      return { ok: false, action: 'skip', detail: `git status failed: ${String(e?.message || e).slice(0, 120)}` };
    }

    await execFileAsync('git', ['fetch', 'origin', '--prune'], { cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024 });
    await execFileAsync('git', ['pull', '--ff-only'], { cwd: root, timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 });
    const after = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 15_000 })).stdout.trim();
    if (after === before) {
      return { ok: true, action: 'current', detail: 'already up to date' };
    }
    lastSelfUpdateAt = Date.now();
    respawnSelf(`self-update ${before.slice(0, 7)} → ${after.slice(0, 7)}`);
    return { ok: true, action: 'restarting', detail: `${before.slice(0, 7)} → ${after.slice(0, 7)}` };
  } catch (e: any) {
    return { ok: false, action: 'error', detail: String(e?.stderr || e?.stdout || e?.message || e).slice(0, 300) };
  } finally {
    selfUpdateBusy = false;
  }
}

/** Heartbeat-response entry: fire-and-forget, rate-limited (the dashboard
 *  heartbeats every 60s — one real check per 5 min is plenty). */
let lastSignalProcessedAt = 0;
function scheduleSelfUpdateFromHeartbeat(signal: unknown): void {
  if (!signal || typeof signal !== 'object') return;
  if (Date.now() - lastSignalProcessedAt < 5 * 60 * 1000) return;
  lastSignalProcessedAt = Date.now();
  performSelfUpdate(signal as any)
    .then((r) => {
      if (r.action !== 'current') {
        console.log(`[Agent][self-update] ${r.action}${r.detail ? `: ${r.detail}` : ''}`);
      }
    })
    .catch(() => { /* never break the heartbeat path */ });
}

// ---- Branch support (switch-branch pull, mirror of src/lib/git-branches.ts) ----

/** Conservative branch-name guard for API-supplied values that reach git argv. */
function isValidBranchName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (name.startsWith('-') || name.startsWith('.')) return false;
  if (name.includes('..') || name.includes(' ') || name.includes('~') || name.includes('^') || name.includes(':')
    || name.includes('?') || name.includes('*') || name.includes('[') || name.includes('\\')) return false;
  if (name.endsWith('.lock') || name.endsWith('/')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

/** List local + origin/* branches for the switch-branch picker (GET
 *  /api/agent/projects/:id/branches). `fetch` runs git fetch --prune first
 * so freshly pushed branches show up. Never throws. */
async function listGitBranches(path: string, fetch = false): Promise<any> {
  if (!path || !existsSync(path) || !existsSync(join(path, '.git'))) {
    return { current: null, branches: [], error: 'not a git repository' };
  }
  try {
    if (fetch) {
      await execFileAsync('git', ['fetch', 'origin', '--prune'], { cwd: path, timeout: 60_000, maxBuffer: 512 * 1024 }).catch(() => {});
    }
    const { stdout } = await execFileAsync(
      'git',
      ['for-each-ref', '--format=%(HEAD)%00%(refname)%00%(refname:short)', 'refs/heads', 'refs/remotes'],
      { cwd: path, timeout: 15_000, maxBuffer: 1024 * 1024 },
    );
    const current = stdout.split('\n').find((l: string) => l.startsWith('*'))?.split('\0')[2]?.trim() ?? null;
    const byName = new Map<string, any>();
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [mark, fullRef, shortRef] = line.split('\0');
      if (!fullRef || !shortRef) continue;
      // refs/remotes/origin/HEAD's SHORT name resolves to just "origin" —
      // skip via the FULL refname or a phantom "origin" branch leaks in.
      if (fullRef.endsWith('/HEAD')) continue;
      const name = shortRef.trim();
      const isRemote = name.includes('/');
      const short = isRemote && name.startsWith('origin/') ? name.slice('origin/'.length) : null;
      if (isRemote && !short) continue; // other remotes (upstream/*) — skip
      const display = short ?? name;
      if (!display || !isValidBranchName(display)) continue;
      const isCurrent = mark.trim() === '*';
      const existing = byName.get(display);
      if (existing) {
        if (!isRemote) existing.remote = false;
        existing.current = existing.current || isCurrent;
      } else {
        byName.set(display, { name: display, current: isCurrent, remote: isRemote });
      }
    }
    if (current && !byName.has(current) && isValidBranchName(current)) {
      byName.set(current, { name: current, current: true, remote: false });
    }
    const branches = [...byName.values()].sort((a: any, b: any) =>
      Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
    return { current, branches };
  } catch (e: any) {
    return { current: null, branches: [], error: String(e?.message || e).slice(0, 200) };
  }
}

/** Switch a checkout to `branch` (checkout / checkout -b tracking origin).
 *  Local uncommitted changes are never touched — git refuses clobbering
 *  checkouts and that error is surfaced verbatim. */
async function switchGitBranch(path: string, branch: string): Promise<{ ok: boolean; note: string; error?: string }> {
  if (!isValidBranchName(branch)) return { ok: false, note: '', error: `invalid branch name: ${branch}` };
  let localExists = false;
  let remoteExists = false;
  try {
    await execFileAsync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: path, timeout: 15_000, maxBuffer: 64 * 1024 });
    localExists = true;
  } catch {}
  try {
    await execFileAsync('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], { cwd: path, timeout: 15_000, maxBuffer: 64 * 1024 });
    remoteExists = true;
  } catch {}
  try {
    if (localExists) {
      await execFileAsync('git', ['checkout', branch], { cwd: path, timeout: 15_000, maxBuffer: 512 * 1024 });
      return { ok: true, note: `switched to branch '${branch}'` };
    }
    if (remoteExists) {
      await execFileAsync('git', ['checkout', '-b', branch, `origin/${branch}`], { cwd: path, timeout: 15_000, maxBuffer: 512 * 1024 });
      return { ok: true, note: `created local branch '${branch}' tracking origin/${branch}` };
    }
    return { ok: false, note: '', error: `branch '${branch}' not found locally or on origin` };
  } catch (e: any) {
    const errText = String(e?.stderr || e?.stdout || e?.message || '').trim();
    return { ok: false, note: '', error: errText.slice(0, 400) || `git checkout ${branch} failed` };
  }
}

/** Run `git pull --ff-only` (with upstream fallback) in a project dir.
 *  repoUrl (optional, from the project row) self-heals a missing/broken
 *  'origin' remote — see ensureOriginRemote. `branch` (optional) switches
 *  the checkout first (see switchGitBranch). Pre-flight failures return
 *  {ok:false} instead of throwing so the route can answer 4xx-style. */
async function gitPull(projectPath: string, repoUrl?: string | null, branch?: string): Promise<any> {
  const ensured = await ensureOriginRemote(projectPath, repoUrl);
  if (ensured.error) return { ok: false, error: ensured.error, hint: ensured.hint };

  // Optional branch switch BEFORE the pull. Uncommitted local changes are
  // never stashed or overwritten — git itself refuses a clobbering checkout.
  let switchedTo = '';
  if (branch) {
    let currentBranch = '';
    try {
      currentBranch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath, timeout: 15_000 })).stdout.trim();
    } catch { /* detached HEAD */ }
    if (currentBranch !== branch) {
      await execFileAsync('git', ['fetch', 'origin', '--prune'], { cwd: projectPath, timeout: 60_000, maxBuffer: 512 * 1024 }).catch(() => {});
      const sw = await switchGitBranch(projectPath, branch);
      if (!sw.ok) {
        return { ok: false, error: `git checkout ${branch} failed`, detail: sw.error };
      }
      switchedTo = branch;
    }
  }

  let before = '';
  try { before = (await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectPath, timeout: 15000 })).stdout.trim(); } catch {}

  const buildPullArgs = async (): Promise<string[]> => {
    const pullArgs = ['pull', '--ff-only'];
    try {
      await execFileAsync('git', ['rev-parse', '--abbrev-ref', '@{u}'], { cwd: projectPath, timeout: 15000 });
    } catch {
      try {
        const branch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath, timeout: 15000 })).stdout.trim();
        if (branch && branch !== 'HEAD') pullArgs.push('origin', branch);
      } catch { /* detached HEAD */ }
    }
    return pullArgs;
  };

  let repairedOrigin = ensured.added ? "wired up 'origin' (it was missing)" : '';
  let pullResult: { stdout: string; stderr: string } | null = null;
  let pullError: any = null;
  try {
    pullResult = await execFileAsync('git', await buildPullArgs(), { cwd: projectPath, timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 });
  } catch (e: any) {
    // 'origin' exists but is unreadable (dead local path from a copied
    // repo, wrong URL…) AND the project carries a different, valid https
    // repoUrl → repoint once and retry. A WORKING origin is never touched.
    const errText = String(e?.stderr || e?.stdout || e?.message || '');
    const wantUrl = isHealableRepoUrl(repoUrl) ? repoUrl.trim() : null;
    if (wantUrl && ensured.originUrl !== wantUrl &&
        /does not appear to be a git repository|Could not read from remote repository|Repository not found/i.test(errText)) {
      try {
        try {
          await execFileAsync('git', ['remote', 'set-url', 'origin', wantUrl], { cwd: projectPath, timeout: 15000 });
        } catch {
          await execFileAsync('git', ['remote', 'add', 'origin', wantUrl], { cwd: projectPath, timeout: 15000 });
        }
        repairedOrigin = "repointed 'origin' (its old URL was unreadable)";
        pullResult = await execFileAsync('git', await buildPullArgs(), { cwd: projectPath, timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 });
      } catch (e2: any) {
        // Surface BOTH the original failure and the retry failure.
        const merged: any = new Error(String(e2?.stderr || e2?.stdout || e2?.message || '').trim() || 'git pull failed');
        merged.stderr = [
          String(e?.stderr || e?.stdout || e?.message || ''),
          String(e2?.stderr || e2?.stdout || e2?.message || ''),
        ].filter(Boolean).join('\n').slice(0, 400);
        pullError = merged;
      }
    } else {
      pullError = e;
    }
  }
  if (pullError) throw pullError;

  let after = '';
  try { after = (await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectPath, timeout: 15000 })).stdout.trim(); } catch {}
  const output = ((pullResult && (pullResult.stdout || pullResult.stderr)) || '').trim();
  const upToDate = /Already up to date/i.test(output) || (before !== '' && before === after);
  const notes = [
    switchedTo ? `[agent] switched to branch '${switchedTo}'` : '',
    repairedOrigin ? `[agent] ${repairedOrigin} → ${ensured.originUrl}` : '',
  ].filter(Boolean).map((l) => l + '\n').join('');
  return {
    ok: true, upToDate, before, after,
    ...(switchedTo ? { switchedTo } : {}),
    summary: (upToDate ? 'Already up to date' : before || after ? `${before} → ${after}` : 'done')
      + (switchedTo ? ` @ ${switchedTo}` : ''),
    output: (notes + output).slice(0, 4000),
  };
}

function verifyAuth(req: IncomingMessage): boolean {
  const auth = req.headers['authorization'];
  if (!auth) return false;
  const token = auth.replace('Bearer ', '');
  return token === API_KEY;
}

// ======================== ROUTE HELPERS ========================

function sendJSON(res: ServerResponse, status: number, data: any) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
  });
}

// ======================== AUTO-DEBUG ANALYZE ENGINE ========================
// Lightweight LLM-driven loop used on remote devices (no dsh required):
//   files → LLM JSON config → start → verify port → feed errors back → retry.
// The dashboard supplies the LLM endpoint (its llm-gateway) so remote devices
// need no LLM credentials of their own — the dashboard is the mesh's brain.
// (Ported from the JS package variants: the TS reference agent used to 404
// /api/agent/analyze-project, which surfaced as a bare "Not found" toast in
// the dashboard's Add-Remote-Project dialog.)

interface AnalyzeJob {
  id: string;
  path: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
  progress: { ts: number; kind: string; text: string }[];
  result: any;
  error: string | null;
}

const analyzeJobs = new Map<string, AnalyzeJob>();

function jobProgress(job: AnalyzeJob, kind: string, text: string): void {
  job.progress.push({ ts: Date.now(), kind, text });
  if (job.progress.length > 300) job.progress.splice(0, job.progress.length - 300);
  job.updatedAt = Date.now();
}

/** Read a project directory into a compact file digest for the LLM. */
function readProjectDigest(dir: string): string {
  const interesting = ['package.json', 'bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock',
    'README.md', 'next.config.js', 'next.config.ts', 'next.config.mjs', 'vite.config.js',
    'vite.config.ts', 'nuxt.config.ts', 'requirements.txt', 'pyproject.toml', 'Makefile',
    'Dockerfile', 'docker-compose.yml', 'go.mod', 'Cargo.toml', '.env.example'];
  const parts: string[] = [];
  for (const name of interesting) {
    const f = join(dir, name);
    if (!existsSync(f)) continue;
    try {
      const content = readFileSync(f, 'utf-8').split('\n').slice(0, 60).join('\n');
      parts.push(`=== ${name} ===\n${content}`);
    } catch { /* unreadable */ }
  }
  try {
    const sub = readdirSync(dir).filter(e => {
      try { return statSync(join(dir, e)).isDirectory() && !e.startsWith('.') && e !== 'node_modules'; } catch { return false; }
    }).slice(0, 15).join(', ');
    parts.push(`=== top-level dirs ===\n${sub || '(none)'}`);
  } catch { /* unreadable dir */ }
  return parts.join('\n\n').slice(0, 12000);
}

/** Call an OpenAI-compatible chat endpoint (the dashboard's in-process
 * llm-gateway — reached over the LAN with the shared key). */
async function llmChat(llmBaseUrl: string, messages: { role: string; content: string }[], retries = 3): Promise<string> {
  const url = llmBaseUrl.replace(/\/$/, '') + '/chat/completions';
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 120000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-gateway-key' },
          body: JSON.stringify({ messages, temperature: 0.2 }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          if ((res.status === 429 || res.status >= 500) && i < retries) {
            await new Promise(r => setTimeout(r, 4000 * (i + 1)));
            continue;
          }
          throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
        }
        const data: any = await res.json();
        return data.choices?.[0]?.message?.content || '';
      } finally {
        clearTimeout(to);
      }
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 3000 * (i + 1)));
    }
  }
  return '';
}

/** Extract the {projectName, environments[]} config object from an LLM reply. */
function parseConfigFromText(text: string): any {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try {
    const obj = JSON.parse(t.slice(s, e + 1));
    if (!Array.isArray(obj.environments) || obj.environments.length === 0) return null;
    const valid = (obj.environments as any[]).filter(env => env && env.cmd && Number(env.port) > 0 && Number(env.port) !== 3000);
    if (valid.length === 0) return null;
    obj.environments = valid.map(env => ({
      name: String(env.name || 'dev').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || 'dev',
      cmd: String(env.cmd).slice(0, 500),
      port: Number(env.port),
      envVars: (env.envVars && typeof env.envVars === 'object') ? env.envVars : {},
    }));
    return obj;
  } catch { return null; }
}

/** HTTP check via curl when available (validates an actual response, not
 * just an open socket — some servers accept TCP then never answer). */
function curlCheck(port: number): string {
  try {
    const out = execSync(`curl -s -o /dev/null -w "%{http_code}" --max-time 4 http://127.0.0.1:${port}/ || true`, { encoding: 'utf-8', timeout: 6000 });
    return out.trim();
  } catch { return '000'; }
}

/** Kill the verification child AND its grandchildren (npm → node under the
 * shell). The analyze verification spawns a DETACHED shell, so on Unix the
 * whole process group must go — killing only the shell pid would leak the
 * actual dev server it started. */
function killAnalyzeChild(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (IS_WINDOWS) {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe', timeout: 5000 });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ } }
    }
  } catch { /* already dead */ }
}

async function runAutoDebugAnalyze(job: AnalyzeJob, llmBaseUrl: string | null, usedPorts: number[]): Promise<void> {
  try {
    if (!llmBaseUrl) {
      job.status = 'failed';
      job.error = 'No LLM endpoint provided (llmBaseUrl) — remote analysis must be started from the dashboard';
      return;
    }
    jobProgress(job, 'note', `Project: ${job.name} (${job.path})`);

    const digest = readProjectDigest(job.path);
    jobProgress(job, 'file', 'Reading project files (package.json / configs / README)');

    let feedback: string | null = null;
    const MAX_ROUNDS = 4;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      jobProgress(job, 'start', `Round ${round}/${MAX_ROUNDS}: generating startup config (LLM)`);
      const prompt = `You are a DevOps expert. Analyze this project and generate a startup configuration.

Project path: ${job.path}
Ports already in use (NEVER use these): ${(usedPorts || []).join(', ')}

Project files:
${digest}
${feedback ? `\nA previous startup attempt FAILED. Fix the issue and produce an updated configuration.\nFailure details:\n${feedback}` : ''}

Reply with ONLY a JSON object:
{"projectName":"...","description":"one sentence","icon":"one of folder,globe,code,database,smartphone,terminal,rocket,server,package,zap,cloud","summary":"what you did / fixed","environments":[{"name":"dev","cmd":"single shell command","port":NUMBER,"envVars":{"KEY":"value"}}]}

Rules:
- The cmd must actually start the service from the project directory (install deps first with && if needed, e.g. "npm install && npm start").
- Choose a free port (never 3000 or the used list).
- envVars values must be strings (include PORT and HOST=0.0.0.0 when the server needs them).`;

      const text = await llmChat(llmBaseUrl, [
        { role: 'system', content: 'You are a DevOps expert. Always respond with valid JSON only.' },
        { role: 'user', content: prompt },
      ]);
      const config = parseConfigFromText(text);
      if (!config) {
        jobProgress(job, 'error', 'LLM did not return a valid configuration, retrying…');
        feedback = 'The previous reply was not valid JSON with environments[].';
        continue;
      }

      const env = config.environments[0];
      jobProgress(job, 'command', `Verifying: ${env.cmd} (:${env.port})`);

      // ---- start & verify ----
      const envVars: Record<string, string> = { ...env.envVars };
      if (!Object.keys(envVars).some(k => k.toUpperCase() === 'PORT')) envVars.PORT = String(env.port);
      // `as any` on the options mirrors the existing startProcess pattern —
      // the repo-level ProcessEnv augmentation (NODE_ENV required via
      // next-env.d.ts) otherwise rejects a plain Record<string, string> env.
      const child = spawn(IS_WINDOWS ? 'cmd' : 'sh',
        IS_WINDOWS ? ['/c', env.cmd] : ['-c', env.cmd],
        { cwd: job.path, env: stripNextInternals({ ...process.env, ...envVars } as Record<string, string>), detached: true, stdio: ['ignore' as const, 'pipe' as const, 'pipe' as const] } as any);
      child.unref?.();
      let output = '';
      child.stdout?.on('data', (c: Buffer) => { output += c.toString(); if (output.length > 8000) output = output.slice(-8000); });
      child.stderr?.on('data', (c: Buffer) => { output += c.toString(); if (output.length > 8000) output = output.slice(-8000); });

      let verified = false;
      const waitStart = Date.now();
      while (Date.now() - waitStart < 45000) {
        await new Promise(r => setTimeout(r, 2500));
        const httpCode = curlCheck(env.port);
        if (httpCode !== '000' && httpCode !== '') { verified = true; break; }
        if (child.pid) { try { process.kill(child.pid, 0); } catch { break; } } // exited early
      }

      // ---- stop the verification process (whole tree) ----
      killAnalyzeChild(child.pid);
      await new Promise(r => setTimeout(r, 1000));

      if (verified) {
        job.status = 'completed';
        job.result = { ...config, attempts: round, verified: true, finishedAt: Date.now() };
        jobProgress(job, 'result', `Verified in ${round} round(s): ${env.cmd} → :${env.port} is responding`);
        return;
      }
      feedback = `Startup command "${env.cmd}" on port ${env.port} did not respond within 45s. Process output:\n${output.slice(-1500) || '(no output)'}`;
      jobProgress(job, 'error', `No response on port ${env.port} — feeding output back for the next round…`);
    }

    job.status = 'failed';
    job.error = `Auto-debug did not succeed within ${MAX_ROUNDS} rounds. Last feedback: ${(feedback || '').slice(0, 400)}`;
  } catch (e: any) {
    job.status = 'failed';
    job.error = String(e?.message || e);
  } finally {
    // GC the job after 1h
    const t = setTimeout(() => analyzeJobs.delete(job.id), 60 * 60 * 1000);
    t.unref?.();
  }
}

// ======================== HTTP SERVER ========================

const startTime = Date.now();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      sendJSON(res, 200, {});
      return;
    }

    // Health endpoint (no auth required)
    if (pathname === '/api/agent/health') {
      const dashState = dashboardDbState();
      sendJSON(res, 200, {
        status: 'ok',
        name: AGENT_NAME,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        version: '1.14.0',
        platform: platform(),
        arch: arch(),
        // Whether this agent serves a co-located dashboard's projects
        // (dashboards use it to explain what the listing contains) + WHERE
        // the DB was found (diagnostics for the "0 projects" case).
        dashboardDb: dashState.dashboardDbFound,
        dashboardDbPath: dashState.dashboardDbPath,
        // Feature markers for the dashboard's auto-upgrade check: a MISSING
        // field means the process is executing pre-upgrade code and gets
        // respawned by ensureLocalAgent (git pull cannot hot-reload a
        // spawned agent process).
        pushProjects: true, // heartbeat pushes the project list
        smartIp: true,      // gateway-subnet-aware LAN IP detection
        envSanitize: true,  // child-process env sanitization (TURBOPACK leak) + pull origin self-heal
        peerRelay: true,    // caches register-response peer projects; serves them at /api/agent/peer-cache
        repoMerge: true,    // dual-store listing merge (repoUrl/notes by path) + pull cross-store repoUrl heal
        branchSwitch: true, // GET /projects/:id/branches + switch-branch pull (git checkout + pull)
        pullRepoUrl: true,  // pull body { repoUrl } from the calling dashboard wires up a missing 'origin' (cross-machine GitHub link)
        selfUpdate: true,   // heartbeat updateSignal → pull own repo + self-respawn (zero-touch agent upgrades)
        repoSync: true,     // heartbeat-response repoSync overrides → links edited on a peer dashboard land in the projects' home stores
        dashDbLazy: true,   // multi-candidate dashboard-DB detection (.env-aware, __dirname-anchored) + lazy re-probe + agentMeta reporting
        restart: true,      // POST /api/agent/restart — dashboard-triggered respawn (stale-process heal without a code pull)
        autoDebug: true,     // POST /api/agent/analyze-project — LLM-driven remote project analysis (dashboard supplies the LLM endpoint)
      });
      return;
    }

    // Auth check
    if (!verifyAuth(req)) {
      sendJSON(res, 401, { error: 'Unauthorized' });
      return;
    }

    // GET /api/agent/versions — batch git snapshot for every project
    // (feeds the dashboard cards' version chips; one call per device).
    // BOTH stores: agent-DB rows AND dash-managed rows — the listing serves
    // both, so resolving only the agent DB silently dropped version badges
    // for exactly the dash-managed projects.
    if (pathname === '/api/agent/versions' && req.method === 'GET') {
      const [agentRows, dashRows] = await Promise.all([
        db.project.findMany({ select: { id: true, path: true } }),
        listDashProjectPaths(),
      ]);
      const versions: Record<string, any> = {};
      await Promise.all([...agentRows, ...dashRows].map(async (p) => {
        versions[p.id] = await readGitVersion(p.path);
      }));
      sendJSON(res, 200, { versions });
      return;
    }

    // POST /api/agent/restart — respawn this agent process on request from
    // the dashboard's per-device "Restart Agent" button. No code pull: this
    // is the fix for the stale-process class of issues (a `git pull` on the
    // machine hot-reloads the dashboard but NOT the already-spawned agent).
    // The 200 below flushes synchronously; respawnSelf then exits ~800ms
    // later, and the detached replacement re-binds the same port ~2s after.
    if (pathname === '/api/agent/restart' && req.method === 'POST') {
      sendJSON(res, 200, { ok: true, action: 'restarting', detail: 'agent respawn triggered by dashboard' });
      respawnSelf('restart requested by dashboard');
      return;
    }

    // POST /api/agent/self-update — pull this agent's repo (when safe) and
    // respawn onto the new code. Same logic the heartbeat updateSignal
    // triggers; exposed for dashboards/tests to invoke directly. Optional
    // body { repoUrl, remoteSha } mirrors the heartbeat signal.
    if (pathname === '/api/agent/self-update' && req.method === 'POST') {
      const body = await getBody(req).catch(() => ({}));
      const r = await performSelfUpdate(
        body && typeof body === 'object' ? { repoUrl: body.repoUrl, remoteSha: body.remoteSha } : undefined,
      );
      sendJSON(res, r.ok ? 200 : 409, { ...r, version: '1.10.0' });
      return;
    }

    // GET /api/agent/projects/:id/branches — branch list for the dashboard's
    // switch-branch picker (?fetch=1 → git fetch --prune first). Same
    // two-store row resolution as pull below.
    const branchesMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/branches$/);
    if (branchesMatch && req.method === 'GET') {
      let project: any = null;
      try {
        project = await db.project.findUnique({ where: { id: branchesMatch[1] } });
      } catch { /* schema drift — fall through to dash rows */ }
      if (!project) project = await getDashProject(branchesMatch[1]);
      if (!project) { sendJSON(res, 404, { error: 'Project not found' }); return; }
      if (!(existsSync(project.path) && existsSync(join(project.path, '.git')))) {
        sendJSON(res, 400, { error: `Not a git repository: ${project.path}` });
        return;
      }
      const doFetch = new URL(req.url || '', 'http://localhost').searchParams.get('fetch') === '1';
      const list = await listGitBranches(project.path, doFetch);
      if (list.error && (!list.branches || list.branches.length === 0)) {
        sendJSON(res, 400, { error: list.error });
        return;
      }
      sendJSON(res, 200, list);
      return;
    }

    // POST /api/agent/projects/:id/pull — one-click git pull on THIS machine
    // (optional body { branch } switches the checkout first)
    const pullMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/pull$/);
    if (pullMatch && req.method === 'POST') {
      // Schema-drift guard: if this agent.db predates the repoUrl/notes
      // columns AND the migration above could not run (read-only fs, ancient
      // process), findUnique itself explodes with a raw Prisma dump — turn
      // it into the actual fix (restart the agent so it self-migrates).
      let project: any = null;
      try {
        project = await db.project.findUnique({ where: { id: pullMatch[1] } });
      } catch (e: any) {
        sendJSON(res, 500, { error: 'Agent DB schema is out of date — restart this agent so it can self-migrate its database (or run: bunx prisma db push)', detail: String(e?.message || '').slice(0, 300) });
        return;
      }
      // Dash-managed rows are listed to peers (buildPeerProjects) — pull
      // must resolve them too, else the dashboard maps the 404 to a
      // misleading "agent too old" error.
      if (!project) {
        project = await getDashProject(pullMatch[1]);
      }
      if (!project) { sendJSON(res, 404, { error: 'Project not found' }); return; }
      if (!(existsSync(project.path) && existsSync(join(project.path, '.git')))) { sendJSON(res, 400, { error: `Not a git repository: ${project.path}` }); return; }
      // Read the body FIRST: { branch } (optional switch-branch pull) and
      // { repoUrl } (optional — the CALLING dashboard's saved GitHub link).
      const pullBody = await getBody(req);
      let branch = '';
      if (typeof pullBody?.branch === 'string') branch = pullBody.branch.trim();
      if (branch && !isValidBranchName(branch)) {
        sendJSON(res, 400, { error: `Invalid branch name: ${branch.slice(0, 80)}` });
        return;
      }
      // repoUrl priority: REQUEST BODY > this machine's project row >
      // same-path rows in either local store. Remote-project rows live in
      // the CALLING dashboard's DB — the GitHub link the user saved in the
      // web UI often exists ONLY there, so the body value wins (it is also
      // the freshest — just saved in the UI). Body values are untrusted:
      // normalizeBodyRepoUrl enforces https/no-space/no-credentials before
      // anything reaches git argv. Local cross-store heal stays as the
      // fallback for same-machine dashboards that send no repoUrl.
      let repoUrl: string | null = null;
      if (!isHealableRepoUrl(project.repoUrl)) {
        const altRepoUrl = await findRepoUrlByPath(project.path, String(project.id));
        if (altRepoUrl) repoUrl = altRepoUrl;
      } else {
        repoUrl = String(project.repoUrl).trim();
      }
      const bodyRepoUrl = normalizeBodyRepoUrl(pullBody?.repoUrl);
      if (bodyRepoUrl) repoUrl = bodyRepoUrl;
      try {
        const pullResult = await gitPull(project.path, repoUrl, branch || undefined);
        if (pullResult && pullResult.ok === false) {
          sendJSON(res, 400, { error: pullResult.error, hint: pullResult.hint, detail: pullResult.detail });
        } else {
          sendJSON(res, 200, pullResult);
        }
      } catch (e: any) {
        sendJSON(res, 500, { error: 'git pull failed', detail: String(e?.stderr || e?.stdout || e?.message || '').trim().slice(0, 400) });
      }
      return;
    }

    // POST /api/agent/pair-target  {dashboardUrl, remove?}
    // Called by the LOCAL dashboard right after a successful join (joiner
    // side) AND by the remote dashboard's register handler (target side,
    // mutual pairing) — this agent ADDS the dashboard to its heartbeat
    // target list so the remote Device row self-heals on ip/port drift
    // without a manual re-pair. Multi-target: pairing with a third
    // dashboard no longer steals the heartbeat from earlier ones.
    if (pathname === '/api/agent/pair-target' && req.method === 'POST') {
      const body = await getBody(req);
      const url = String(body?.dashboardUrl || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\/.+/i.test(url)) {
        sendJSON(res, 400, { error: 'dashboardUrl must be an http(s) URL' });
        return;
      }
      HEARTBEAT_TARGETS = body?.remove
        ? HEARTBEAT_TARGETS.filter((t) => t !== url)
        : [...new Set([...HEARTBEAT_TARGETS, url])].slice(0, HEARTBEAT_MAX_TARGETS);
      persistHeartbeatTargets();
      armHeartbeat();
      console.log(`[Agent][pair-target] heartbeat targets: ${HEARTBEAT_TARGETS.join(', ')}`);
      sendJSON(res, 200, { ok: true, dashboardUrl: url, targets: HEARTBEAT_TARGETS });
      return;
    }

    // ======================== GET /api/agent/peer-cache ========================

    // Entries cached from register/heartbeat RESPONSES (each paired
    // dashboard hands back its own agent coordinates + project list — see
    // cachePeerFromRegisterResponse). The co-located dashboard polls this
    // over 127.0.0.1 when its direct pull to a peer fails: the relay leg
    // that keeps one-way-network peers' projects visible without either
    // side opening a firewall port.
    if (pathname === '/api/agent/peer-cache' && req.method === 'GET') {
      sendJSON(res, 200, { entries: Array.from(peerCache.values()) });
      return;
    }

    // GET /api/agent/projects
    if (pathname === '/api/agent/projects' && req.method === 'GET') {
      // Dashboard machines: serve the co-located dashboard's OWN projects
      // (deviceId IS NULL) merged with standalone agent-DB projects.
      const enriched = await buildPeerProjects();
      sendJSON(res, 200, { projects: enriched, meta: { ...dashboardDbState(), projectCount: enriched.length } });
      return;
    }

    // Match project-level routes: /api/agent/projects/:id
    const projectMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)$/);

    if (projectMatch && req.method === 'GET') {
      const projectId = projectMatch[1];
      // Dashboard DB first, standalone agent DB second.
      let project: any = await getDashProject(projectId);
      if (!project) {
        project = await db.project.findUnique({
          where: { id: projectId },
          include: { environments: true },
        });
      }
      if (!project) { sendJSON(res, 404, { error: 'Project not found' }); return; }

      const ports = project.environments.map(e => e.port);
      const portChecks = await Promise.all(ports.map(p => checkPortStatus(p).then(ok => [p, ok] as const)));
      const activePorts = new Map(portChecks);

      sendJSON(res, 200, {
        project: {
          ...project,
          environments: project.environments.map(env => ({
            ...env,
            status: activePorts.get(env.port) ? 'running' : 'stopped',
          })),
        },
      });
      return;
    }

    if (projectMatch && req.method === 'PUT') {
      const projectId = projectMatch[1];
      const body = await getBody(req);
      // Dash-managed project → update the dashboard DB row (same data the
      // local UI reads). repoUrl/notes are persisted when the home
      // dashboard's schema has the columns — that's what makes a GitHub
      // link configured on a REMOTE dashboard appear on the project's home
      // machine too.
      if (getDashDb() && (await getDashProject(projectId))) {
        const cols = await ensureDashColumns();
        const sets: string[] = [];
        const params: any[] = [];
        const tagsNorm = normalizeTagsValue(body.tags);
        for (const field of ['name', 'description', 'icon'] as const) {
          if (body[field] !== undefined) {
            sets.push(`"${field}" = ?`);
            params.push(String(body[field]));
          }
        }
        if (tagsNorm !== undefined) { sets.push('"tags" = ?'); params.push(tagsNorm); }
        if (body.repoUrl !== undefined && cols.has('repoUrl')) { sets.push('"repoUrl" = ?'); params.push(normalizeRepoUrl(body.repoUrl)); }
        if (body.notes !== undefined && cols.has('notes')) { sets.push('"notes" = ?'); params.push(String(body.notes).slice(0, 20000)); }
        if (sets.length > 0) {
          sets.push('"updatedAt" = ?');
          params.push(Date.now());
          params.push(projectId);
          await getDashDb().$executeRawUnsafe(`UPDATE "Project" SET ${sets.join(', ')} WHERE "id" = ? AND "deviceId" IS NULL`, ...params);
        }
        sendJSON(res, 200, { project: await getDashProject(projectId) });
        return;
      }
      const tagsNorm = normalizeTagsValue(body.tags);
      const project = await db.project.update({
        where: { id: projectId },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.icon !== undefined && { icon: body.icon }),
          ...(tagsNorm !== undefined && { tags: tagsNorm }),
          ...(body.repoUrl !== undefined && { repoUrl: normalizeRepoUrl(body.repoUrl) }),
          ...(body.notes !== undefined && { notes: String(body.notes).slice(0, 20000) }),
        },
        include: { environments: true },
      });
      sendJSON(res, 200, { project });
      return;
    }

    if (projectMatch && req.method === 'DELETE') {
      const projectId = projectMatch[1];
      // Resolve from either store — envs must be stopped before deleting.
      const dashProject = await getDashProject(projectId);
      const project: any = dashProject || (await db.project.findUnique({
        where: { id: projectId },
        include: { environments: true },
      }));
      if (!project) { sendJSON(res, 404, { error: 'Project not found' }); return; }
      for (const env of project.environments) {
        await stopProcess(projectId, env.name, env.port);
      }
      if (dashProject) {
        // SQLite raw deletes don't run relation cascades reliably — delete
        // children first, then the project (deviceId guard keeps mirrored
        // remote rows safe).
        await getDashDb()!.$executeRawUnsafe('DELETE FROM "Environment" WHERE "projectId" = ?', projectId);
        await getDashDb()!.$executeRawUnsafe('DELETE FROM "Project" WHERE "id" = ? AND "deviceId" IS NULL', projectId);
      } else {
        await db.project.delete({ where: { id: projectId } });
      }
      sendJSON(res, 200, { ok: true });
      return;
    }

    // POST /api/agent/projects/:id/environments/:envId/start
    const startMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/start$/);
    if (startMatch && req.method === 'POST') {
      const [, projectId, envId] = startMatch;
      const resolved = await resolveEnv(projectId, envId);
      if (!resolved) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      const { env, projectPath, fromDash } = resolved;

      let envVars: Record<string, string> = {};
      try { envVars = JSON.parse(env.envVars); } catch {}

      const result = await startProcess(projectId, env.name, env.cmd, projectPath, envVars, env.port);
      if (result.success) {
        await persistEnvState(envId, fromDash, { status: 'running', pid: result.pid ?? null });
        sendJSON(res, 200, { ok: true, pid: result.pid });
      } else {
        await persistEnvState(envId, fromDash, { status: 'stopped', pid: null });
        // detail/logFile carry the immediate-exit diagnosis (exit code +
        // log tail + full log path) so the remote dashboard can show WHY.
        sendJSON(res, 400, { ok: false, error: result.error, detail: result.detail, logFile: result.logFile });
      }
      return;
    }

    // POST /api/agent/projects/:id/environments/:envId/stop
    const stopMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/stop$/);
    if (stopMatch && req.method === 'POST') {
      const [, projectId, envId] = stopMatch;
      const resolved = await resolveEnv(projectId, envId);
      if (!resolved) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      const { env, fromDash } = resolved;

      const result = await stopProcess(projectId, env.name, env.port);
      await persistEnvState(envId, fromDash, { status: 'stopped', pid: null });
      sendJSON(res, 200, { ok: result.success, error: result.error });
      return;
    }

    // POST /api/agent/projects/:id/environments/:envId/restart
    const restartMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/restart$/);
    if (restartMatch && req.method === 'POST') {
      const [, projectId, envId] = restartMatch;
      const resolved = await resolveEnv(projectId, envId);
      if (!resolved) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      const { env, projectPath, fromDash } = resolved;

      await stopProcess(projectId, env.name, env.port);
      await new Promise(r => setTimeout(r, 500));

      let envVars: Record<string, string> = {};
      try { envVars = JSON.parse(env.envVars); } catch {}

      const result = await startProcess(projectId, env.name, env.cmd, projectPath, envVars, env.port);
      if (result.success) {
        await persistEnvState(envId, fromDash, { status: 'running', pid: result.pid ?? null });
        sendJSON(res, 200, { ok: true, pid: result.pid });
      } else {
        await persistEnvState(envId, fromDash, { status: 'stopped', pid: null });
        sendJSON(res, 400, { ok: false, error: result.error, detail: result.detail, logFile: result.logFile });
      }
      return;
    }

    // POST /api/agent/projects/:id/environments/:envId/rebuild
    const rebuildMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/rebuild$/);
    if (rebuildMatch && req.method === 'POST') {
      const [, projectId, envId] = rebuildMatch;
      const resolved = await resolveEnv(projectId, envId);
      if (!resolved) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      const { env, projectPath, fromDash } = resolved;

      // Stop → wait → restart
      await stopProcess(projectId, env.name, env.port);
      await new Promise(r => setTimeout(r, 1000));

      let envVars: Record<string, string> = {};
      try { envVars = JSON.parse(env.envVars); } catch {}

      const result = await startProcess(projectId, env.name, env.cmd, projectPath, envVars, env.port);
      if (result.success) {
        await persistEnvState(envId, fromDash, { status: 'running', pid: result.pid ?? null });
        sendJSON(res, 200, { ok: true, pid: result.pid });
      } else {
        await persistEnvState(envId, fromDash, { status: 'stopped', pid: null });
        sendJSON(res, 400, { ok: false, error: result.error, detail: result.detail, logFile: result.logFile });
      }
      return;
    }

    // GET /api/agent/projects/:id/environments/:envId/logs
    const envLogsMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/logs$/);
    if (envLogsMatch && req.method === 'GET') {
      const [, projectId, envId] = envLogsMatch;
      const resolved = await resolveEnv(projectId, envId);
      if (!resolved) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      const logs = getLogs(projectId, resolved.env.name);
      sendJSON(res, 200, { logs });
      return;
    }

    // PUT /api/agent/projects/:id/environments/:envId
    const envMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)$/);
    if (envMatch && req.method === 'PUT') {
      const [, projectId, envId] = envMatch;
      const body = await getBody(req);
      // Dash-managed env → update the dashboard DB row.
      if (getDashDb()) {
        const dashHit = await getDashEnvFull(projectId, envId);
        if (dashHit) {
          const sets: string[] = [];
          const params: any[] = [];
          if (body.name !== undefined) { sets.push('"name" = ?'); params.push(String(body.name)); }
          if (body.cmd !== undefined) { sets.push('"cmd" = ?'); params.push(String(body.cmd)); }
          if (body.port !== undefined) { sets.push('"port" = ?'); params.push(parseInt(String(body.port), 10) || 0); }
          if (body.envVars !== undefined) { sets.push('"envVars" = ?'); params.push(typeof body.envVars === 'string' ? body.envVars : JSON.stringify(body.envVars)); }
          if (sets.length > 0) {
            sets.push('"updatedAt" = ?'); params.push(Date.now());
            params.push(envId);
            await getDashDb().$executeRawUnsafe(`UPDATE "Environment" SET ${sets.join(', ')} WHERE "id" = ? AND "projectId" = ?`, ...params, projectId);
          }
          const after = await getDashEnvFull(projectId, envId);
          sendJSON(res, 200, { environment: after?.env });
          return;
        }
      }
      const env = await db.environment.findUnique({ where: { id: envId } });
      if (!env || env.projectId !== projectId) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      const updated = await db.environment.update({
        where: { id: envId },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.cmd !== undefined && { cmd: body.cmd }),
          ...(body.port !== undefined && { port: parseInt(String(body.port), 10) }),
          ...(body.envVars !== undefined && { envVars: typeof body.envVars === 'string' ? body.envVars : JSON.stringify(body.envVars) }),
        },
      });
      sendJSON(res, 200, { environment: updated });
      return;
    }

    // DELETE /api/agent/projects/:id/environments/:envId
    if (envMatch && req.method === 'DELETE') {
      const [, projectId, envId] = envMatch;
      const resolved = await resolveEnv(projectId, envId);
      if (!resolved) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      const { env, fromDash } = resolved;
      await stopProcess(projectId, env.name, env.port);
      if (fromDash) {
        await getDashDb()!.$executeRawUnsafe('DELETE FROM "Environment" WHERE "id" = ? AND "projectId" = ?', envId, projectId);
      } else {
        await db.environment.delete({ where: { id: envId } });
      }
      sendJSON(res, 200, { ok: true });
      return;
    }

    // POST /api/agent/projects (create project on agent)
    if (pathname === '/api/agent/projects' && req.method === 'POST') {
      const body = await getBody(req);
      // Co-located dashboard: create the project in ITS database so it shows
      // up in the local dashboard UI as a first-class local project.
      if (getDashDb()) {
        const id = `c${randomBytes(11).toString('hex')}`;
        const now = Date.now();
        const tags = typeof body.tags === 'string' ? body.tags : JSON.stringify(body.tags || []);
        await getDashDb().$executeRawUnsafe(
          'INSERT INTO "Project" ("id","name","path","description","icon","tags","order","createdAt","updatedAt") VALUES (?,?,?,?,?,?,0,?,?)',
          id, String(body.name || 'Untitled'), String(body.path || '.'), String(body.description || ''), String(body.icon || 'folder'), tags, now, now
        );
        sendJSON(res, 200, { project: await getDashProject(id) });
        return;
      }
      const project = await db.project.create({
        data: {
          name: body.name || 'Untitled',
          path: body.path || '.',
          description: body.description || '',
          icon: body.icon || 'folder',
          tags: body.tags || '[]',
        },
        include: { environments: true },
      });
      sendJSON(res, 200, { project });
      return;
    }

    // POST /api/agent/projects/:id/environments (add environment to project)
    const addEnvMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments$/);
    if (addEnvMatch && req.method === 'POST') {
      const projectId = addEnvMatch[1];
      const body = await getBody(req);
      const dashProject = getDashDb() ? await getDashProject(projectId) : null;
      if (dashProject) {
        const id = `c${randomBytes(11).toString('hex')}`;
        const now = Date.now();
        await getDashDb()!.$executeRawUnsafe(
          'INSERT INTO "Environment" ("id","projectId","name","cmd","port","envVars","status","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?)',
          id, projectId, String(body.name || 'dev'), String(body.cmd || 'npm start'), parseInt(String(body.port || '3000'), 10) || 3000,
          typeof body.envVars === 'string' ? body.envVars : JSON.stringify(body.envVars || {}), 'stopped', now, now
        );
        const after = await getDashEnvFull(projectId, id);
        sendJSON(res, 200, { environment: after?.env });
        return;
      }
      const project = await db.project.findUnique({ where: { id: projectId } });
      if (!project) { sendJSON(res, 404, { error: 'Project not found' }); return; }
      const env = await db.environment.create({
        data: {
          projectId,
          name: body.name || 'dev',
          cmd: body.cmd || 'npm start',
          port: parseInt(String(body.port || '3000'), 10),
          envVars: typeof body.envVars === 'string' ? body.envVars : JSON.stringify(body.envVars || {}),
          status: 'stopped',
        },
      });
      sendJSON(res, 200, { environment: env });
      return;
    }

    // GET /api/agent/projects/:id/activity
    const activityMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/activity$/);
    if (activityMatch && req.method === 'GET') {
      const projectId = activityMatch[1];
      const types = ['deploy', 'start', 'stop', 'restart', 'rebuild', 'config_change', 'error'];
      const events = [];
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        events.push({
          id: `activity_${projectId}_${i}`,
          type: types[Math.floor(Math.random() * types.length)],
          message: `Remote activity event ${i + 1}`,
          timestamp: new Date(now - i * 1800000).toISOString(),
          projectId,
        });
      }
      sendJSON(res, 200, events);
      return;
    }

    // GET /api/agent/projects/:id/logs (project-level)
    const projectLogsMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/logs$/);
    if (projectLogsMatch && req.method === 'GET') {
      const projectId = projectLogsMatch[1];
      const logs = [];
      const now = Date.now();
      for (let i = 0; i < 20; i++) {
        logs.push({
          id: `log_${projectId}_${i}`,
          timestamp: new Date(now - i * 15000).toISOString(),
          level: ['info', 'warn', 'error'][Math.floor(Math.random() * 3)],
          source: 'server',
          message: `Remote log entry ${i + 1}`,
          projectId,
        });
      }
      sendJSON(res, 200, logs);
      return;
    }

    // ======================== AUTO-DEBUG ANALYZE (LLM-driven, async job) ========================
    // POST /api/agent/analyze-project {path, name, llmBaseUrl, usedPorts?}
    // GET  /api/agent/analyze-project/:jobId
    //
    // The dashboard provides the LLM endpoint (its llm-gateway, OpenAI-compatible).
    // This device-side loop: read files → LLM config → try start → check port →
    // feed errors back to the LLM → retry, until the service actually boots.
    const analyzeJobMatch = pathname.match(/^\/api\/agent\/analyze-project\/([^/]+)$/);
    if (analyzeJobMatch && req.method === 'GET') {
      const job = analyzeJobs.get(analyzeJobMatch[1]);
      if (!job) { sendJSON(res, 404, { error: 'Job not found' }); return; }
      sendJSON(res, 200, job);
      return;
    }
    if (pathname === '/api/agent/analyze-project' && req.method === 'POST') {
      const body = await getBody(req);
      const projectPath = resolve(String(body.path || ''));
      if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
        sendJSON(res, 400, { error: `Invalid path: ${projectPath}` });
        return;
      }
      const jobId = randomUUID();
      const job: AnalyzeJob = {
        id: jobId, path: projectPath, name: String(body.name || basename(projectPath)),
        status: 'running', createdAt: Date.now(), updatedAt: Date.now(),
        progress: [], result: null, error: null,
      };
      analyzeJobs.set(jobId, job);
      runAutoDebugAnalyze(job, body.llmBaseUrl || null, Array.isArray(body.usedPorts) ? body.usedPorts : [3000, 3100, 3021, 3022]);
      sendJSON(res, 200, { jobId });
      return;
    }

    // 404
    sendJSON(res, 404, { error: 'Not found' });
  } catch (error: any) {
    console.error('[Agent] Error:', error);
    sendJSON(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[Agent] Dashboard Agent listening on ${HOST}:${PORT}`);
  console.log(`[Agent] Name: ${AGENT_NAME}`);
  console.log(`[Agent] Platform: ${platform()} ${arch()}`);
  console.log(`[Agent] DB: ${dbPath}`);
  const bootDash = dashboardDbState();
  if (bootDash.dashboardDbFound) console.log(`[Agent] Dashboard projects: ${bootDash.dashboardDbPath}`);
  console.log(`[Agent] Logs: ${LOG_DIR}`);
});

// Self-bootstrap the agent DB tables (fresh clones ship no agent.db).
ensureAgentDb().catch((err: any) => console.warn(`[Agent] DB bootstrap failed: ${err?.message}`));

// Heartbeat: keep every paired dashboard's Device row fresh (self-heal on
// network / port change). Runs only when at least one target is known
// (--dashboard, agent-config.json 'dashboardUrl'/'dashboardUrls', or set
// later via /api/agent/pair-target).
if (HEARTBEAT_TARGETS.length > 0) armHeartbeat();

// Keep alive
setInterval(() => {
  // Heartbeat log every 60 seconds
}, 60000);

// ======================== GRACEFUL SHUTDOWN (Cross-Platform) ========================

const shutdown = () => {
  console.log('[Agent] Shutting down...');
  for (const [, child] of runningProcesses) {
    try {
      if (child.pid) killProcess(child.pid);
    } catch {}
  }
  db.$disconnect();
  getDashDb()?.$disconnect();
  server.close();
  process.exit(0);
};

// Unix signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Windows: handle Ctrl+C and console close
if (IS_WINDOWS) {
  // The SIGHUP won't fire on Windows, but we handle it for consistency
  process.on('SIGHUP', shutdown);

  // Use readline to handle Ctrl+C properly in Windows terminal
  if (process.stdin.isTTY) {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => {
      console.log('\n[Agent] Received Ctrl+C');
      shutdown();
    });
  }
}

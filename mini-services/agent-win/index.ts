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
import { readFileSync, existsSync, mkdirSync, createWriteStream, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { randomBytes } from 'crypto';
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
// SQLite (db/custom.db at the project root). This agent's own DB starts
// EMPTY — so on dashboard machines, remote peers saw ZERO projects even
// though the local UI listed them. When a co-located dashboard DB is found,
// project reads AND control operations resolve against it:
//   * listings serve the dashboard's OWN projects (deviceId IS NULL).
//     Rows the remote side mirrored back (deviceId set) are excluded —
//     that's what keeps the mesh mirror loop-free.
//   * status/pid writes land in the same rows the local dashboard reads,
//     so both views stay consistent.
//   * standalone agent-DB projects are still listed and controlled.
// Override: --dashboardDb <path> (or "dashboardDb" in agent-config.json).
const DASHBOARD_DB_ARG = getArg('dashboardDb', '');
function detectDashboardDb(): string | null {
  const candidates: string[] = [];
  if (DASHBOARD_DB_ARG) candidates.push(resolve(DASHBOARD_DB_ARG));
  const persisted = String(readPersistedConfig().dashboardDb || '');
  if (persisted) candidates.push(resolve(persisted));
  // mini-services/agent → project root → db/custom.db
  candidates.push(resolve(process.cwd(), '..', '..', 'db', 'custom.db'));
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* unreadable */ }
  }
  return null;
}
const DASHBOARD_DB_PATH = detectDashboardDb();
// NOTE: only raw queries ($queryRawUnsafe / $executeRawUnsafe) run against
// it — the generated client schema doesn't know the dashboard's deviceId
// column, and raw SQL bypasses that entirely.
const dashDb = DASHBOARD_DB_PATH
  ? new PrismaClient({ datasources: { db: { url: `file:${DASHBOARD_DB_PATH}` } } })
  : null;
if (DASHBOARD_DB_PATH) {
  console.log(`[Agent] Co-located dashboard DB: ${DASHBOARD_DB_PATH}`);
  console.log('[Agent] Serving its local (deviceId IS NULL) projects to remote peers');
}

/** Mirror an agent-DB project edit into the co-located dashboard DB
 *  (best-effort): updates the row ONLY when it exists there as a LOCAL
 *  project (deviceId IS NULL keeps the mesh mirror loop-free). This is the
 *  agent-win heritage write-back: repoUrl/notes edited from a REMOTE
 *  dashboard also appear on the project's home dashboard when this agent
 *  runs beside it. Unknown columns on an older dashboard schema simply
 *  throw → caught by the caller. */
async function dualWriteDashProject(projectId: string, fields: Record<string, string>): Promise<void> {
  if (!dashDb || Object.keys(fields).length === 0) return;
  const sets = Object.keys(fields).map((k) => `"${k}" = ?`);
  const params = Object.values(fields);
  sets.push('"updatedAt" = ?');
  params.push(String(Date.now()));
  params.push(projectId);
  const rows = await dashDb.$executeRawUnsafe(
    `UPDATE "Project" SET ${sets.join(', ')} WHERE "id" = ? AND "deviceId" IS NULL`,
    ...params,
  );
  if (rows > 0) console.log(`[Agent] Mirrored project edit into home dashboard DB (${rows} row)`);
}

// Dashboard-schema capability probe (run once, lazily): older co-located
// dashboards lack the repoUrl/notes columns — SQL touching them would throw
// and take the whole listing down. Probe PRAGMA table_info and expose
// "does the home dashboard know this column?".
const dashColumns = new Set<string>();
let dashColumnsProbed = false;
async function ensureDashColumns(): Promise<Set<string>> {
  if (!dashDb || dashColumnsProbed) return dashColumns;
  dashColumnsProbed = true;
  try {
    const rows = await dashDb.$queryRawUnsafe('PRAGMA table_info("Project")') as any[];
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
  if (!dashDb || projectIds.length === 0) return byProject;
  const rows: any[] = await dashDb.$queryRawUnsafe(
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
  if (!dashDb) return [];
  try {
    const rows: any[] = await dashDb.$queryRawUnsafe(
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
  if (!dashDb) return [];
  try {
    return await dashDb.$queryRawUnsafe('SELECT "id", "path" FROM "Project" WHERE "deviceId" IS NULL');
  } catch { return []; }
}

async function getDashProject(id: string): Promise<any | null> {
  if (!dashDb) return null;
  try {
    const rows: any[] = await dashDb.$queryRawUnsafe(
      `SELECT ${await projectCols()} FROM "Project" WHERE "id" = ? AND "deviceId" IS NULL`, id
    );
    if (rows.length === 0) return null;
    const envs = await dashEnvsFor([id]);
    return mapProjectRow(rows[0], envs.get(id) || []);
  } catch { return null; }
}

/** Env + owning project path from the dashboard DB, or null. */
async function getDashEnvFull(projectId: string, envId: string): Promise<{ env: any; projectPath: string } | null> {
  if (!dashDb) return null;
  try {
    const rows: any[] = await dashDb.$queryRawUnsafe(
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
  if (!dashDb) return;
  const sets: string[] = [];
  const params: any[] = [];
  if (data.status !== undefined) { sets.push('"status" = ?'); params.push(data.status); }
  if (data.pid !== undefined) { sets.push('"pid" = ?'); params.push(data.pid); }
  if (sets.length === 0) return;
  sets.push('"updatedAt" = ?'); params.push(Date.now());
  params.push(envId);
  await dashDb.$executeRawUnsafe(`UPDATE "Environment" SET ${sets.join(', ')} WHERE "id" = ?`, ...params);
}

/** Env resolution across BOTH stores: dashboard DB first, agent DB second. */
async function resolveEnv(projectId: string, envId: string): Promise<{ env: any; projectPath: string; fromDash: boolean } | null> {
  if (dashDb) {
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
  const first = cmd.trim().split(/\s+/)[0];
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
  if (dashDb) {
    try {
      const cols = await ensureDashColumns();
      if (cols.has('repoUrl')) {
        const rows: any[] = await dashDb.$queryRawUnsafe(
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

/** Run `git pull --ff-only` (with upstream fallback) in a project dir.
 *  repoUrl (optional, from the project row) self-heals a missing/broken
 *  'origin' remote — see ensureOriginRemote. Pre-flight failures return
 *  {ok:false} instead of throwing so the route can answer 4xx-style. */
async function gitPull(projectPath: string, repoUrl?: string | null): Promise<any> {
  const ensured = await ensureOriginRemote(projectPath, repoUrl);
  if (ensured.error) return { ok: false, error: ensured.error, hint: ensured.hint };

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
  const notes = repairedOrigin ? `[agent] ${repairedOrigin} → ${ensured.originUrl}\n` : '';
  return { ok: true, upToDate, before, after, summary: upToDate ? 'Already up to date' : before || after ? `${before} → ${after}` : 'done', output: (notes + output).slice(0, 4000) };
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
      sendJSON(res, 200, {
        status: 'ok',
        name: AGENT_NAME,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        version: '1.7.0',
        platform: platform(),
        arch: arch(),
        // Whether this agent serves a co-located dashboard's projects
        // (dashboards use it to explain what the listing contains).
        dashboardDb: !!DASHBOARD_DB_PATH,
        // Feature markers for the dashboard's auto-upgrade check: a MISSING
        // field means the process is executing pre-upgrade code and gets
        // respawned by ensureLocalAgent (git pull cannot hot-reload a
        // spawned agent process).
        pushProjects: true, // heartbeat pushes the project list
        smartIp: true,      // gateway-subnet-aware LAN IP detection
        envSanitize: true,  // child-process env sanitization (TURBOPACK leak) + pull origin self-heal
        peerRelay: true,    // caches register-response peer projects; serves them at /api/agent/peer-cache
        repoMerge: true,    // dual-store listing merge (repoUrl/notes by path) + pull cross-store repoUrl heal
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

    // POST /api/agent/projects/:id/pull — one-click git pull on THIS machine
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
      // repoUrl cross-store heal: the resolved row may be the store WITHOUT
      // the GitHub link (standalone agent-DB row whose path ALSO has a
      // dashboard row carrying repoUrl — buildPeerProjects merges them for
      // the listing; the pull deserves the same union). A healable https
      // repoUrl at the SAME PATH in either store is enough to wire 'origin'.
      if (!isHealableRepoUrl(project.repoUrl)) {
        const altRepoUrl = await findRepoUrlByPath(project.path, String(project.id));
        if (altRepoUrl) project = { ...project, repoUrl: altRepoUrl };
      }
      try {
        const pullResult = await gitPull(project.path, project.repoUrl);
        if (pullResult && pullResult.ok === false) {
          sendJSON(res, 400, { error: pullResult.error, hint: pullResult.hint });
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
      sendJSON(res, 200, { projects: enriched });
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
      if (dashDb && (await getDashProject(projectId))) {
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
          await dashDb.$executeRawUnsafe(`UPDATE "Project" SET ${sets.join(', ')} WHERE "id" = ? AND "deviceId" IS NULL`, ...params);
        }
        sendJSON(res, 200, { project: await getDashProject(projectId) });
        return;
      }
      const tagsNorm = normalizeTagsValue(body.tags);
      const repoUrlNorm = body.repoUrl !== undefined ? normalizeRepoUrl(body.repoUrl) : undefined;
      const notesNorm = body.notes !== undefined ? String(body.notes).slice(0, 20000) : undefined;
      const project = await db.project.update({
        where: { id: projectId },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.icon !== undefined && { icon: body.icon }),
          ...(tagsNorm !== undefined && { tags: tagsNorm }),
          ...(repoUrlNorm !== undefined && { repoUrl: repoUrlNorm }),
          ...(notesNorm !== undefined && { notes: notesNorm }),
        },
        include: { environments: true },
      });
      // Home-machine write-back (agent-win heritage): when this agent runs
      // BESIDE the project's home dashboard, a local row with the same id
      // may live in ITS database — mirror the dashboard-level fields there
      // so the home dashboard ALSO shows the GitHub link / notes. Raw SQL +
      // try/catch: the co-located DB may be absent or an older schema —
      // both are non-fatal.
      if (repoUrlNorm !== undefined || notesNorm !== undefined || tagsNorm !== undefined) {
        try {
          await dualWriteDashProject(projectId, {
            ...(repoUrlNorm !== undefined && { repoUrl: repoUrlNorm }),
            ...(notesNorm !== undefined && { notes: notesNorm }),
            ...(tagsNorm !== undefined && { tags: tagsNorm }),
            ...(body.name !== undefined && { name: String(body.name) }),
            ...(body.description !== undefined && { description: String(body.description) }),
            ...(body.icon !== undefined && { icon: String(body.icon) }),
          });
        } catch { /* best-effort mirror — see dualWriteDashProject */ }
      }
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
        await dashDb!.$executeRawUnsafe('DELETE FROM "Environment" WHERE "projectId" = ?', projectId);
        await dashDb!.$executeRawUnsafe('DELETE FROM "Project" WHERE "id" = ? AND "deviceId" IS NULL', projectId);
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
      if (dashDb) {
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
            await dashDb.$executeRawUnsafe(`UPDATE "Environment" SET ${sets.join(', ')} WHERE "id" = ? AND "projectId" = ?`, ...params, projectId);
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
        await dashDb!.$executeRawUnsafe('DELETE FROM "Environment" WHERE "id" = ? AND "projectId" = ?', envId, projectId);
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
      if (dashDb) {
        const id = `c${randomBytes(11).toString('hex')}`;
        const now = Date.now();
        const tags = typeof body.tags === 'string' ? body.tags : JSON.stringify(body.tags || []);
        await dashDb.$executeRawUnsafe(
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
      const dashProject = dashDb ? await getDashProject(projectId) : null;
      if (dashProject) {
        const id = `c${randomBytes(11).toString('hex')}`;
        const now = Date.now();
        await dashDb!.$executeRawUnsafe(
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
  if (DASHBOARD_DB_PATH) console.log(`[Agent] Dashboard projects: ${DASHBOARD_DB_PATH}`);
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
  dashDb?.$disconnect();
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

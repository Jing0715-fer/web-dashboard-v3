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
import { spawn, ChildProcess, execSync } from 'child_process';
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
const API_KEY = getArg('apiKey', randomBytes(32).toString('hex'));
const AGENT_NAME = getArg('name', hostname());
const HOST = IS_WINDOWS ? '0.0.0.0' : getArg('host', '0.0.0.0');
const DASHBOARD_URL = getArg('dashboard', '').replace(/\/+$/, '');

console.log(`[Agent] Config: port=${PORT}, name=${AGENT_NAME}, host=${HOST}`);
console.log(`[Agent] API Key: ${API_KEY}`);

// ======================== MESH PAIRING SUPPORT ========================

// Ranked LAN IP detection (mirrors the dashboard's lanIpCandidates — see
// src/app/api/mesh/[action]/route.ts). The FIRST non-internal IPv4 is often
// a VPN / Clash TUN fake-IP (198.18.0.0/15) or a stale virtual NIC —
// advertising it would register an UNREACHABLE address in the dashboard DB
// and the device would show offline forever.
function lanIpCandidates(): string[] {
  const ips: string[] = [];
  for (const i of Object.values(networkInterfaces()).flat()) {
    if (!i || i.family !== 'IPv4' || i.internal) continue;
    const [a, b] = i.address.split('.').map(Number);
    if (a === 198 && (b === 18 || b === 19)) continue; // VPN fake-IP range
    if (a === 169 && b === 254) continue;              // link-local
    ips.push(i.address);
  }
  const rank = (ip: string): number => {
    const [a, b] = ip.split('.').map(Number);
    if (a === 192 && b === 168) return 0;               // typical home/office LAN
    if (a === 10) return 1;                             // larger private nets
    if (a === 172 && b >= 16 && b <= 31) return 2;      // docker / corp
    if (a === 100 && b >= 64 && b <= 127) return 3;     // CGNAT (Tailscale & friends)
    return 4;
  };
  return ips.sort((x, y) => rank(x) - rank(y));
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
  const payload = {
    name: AGENT_NAME,
    ip: lanIpCandidates()[0] || '127.0.0.1',
    port: PORT,
    apiKey: API_KEY,
  };
  try {
    const res = await fetch(`${target}/api/mesh/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data: any = await res.json().catch(() => ({}));
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

// ---- raw-row mappers (SQLite dates come back as numbers/strings) ----
function toDate(v: any): Date { return v instanceof Date ? v : new Date(Number(v) || String(v)); }
function toInt(v: any, fallback = 0): number { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function toPid(v: any): number | null { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

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
      `SELECT ${PROJECT_COLS} FROM "Project" WHERE "deviceId" IS NULL ORDER BY "order" ASC, "updatedAt" DESC`
    );
    const envs = await dashEnvsFor(rows.map((r) => r.id));
    return rows.map((r) => mapProjectRow(r, envs.get(r.id) || []));
  } catch (err: any) {
    console.warn(`[Agent] dashboard DB listing failed: ${err?.message}`);
    return [];
  }
}

async function getDashProject(id: string): Promise<any | null> {
  if (!dashDb) return null;
  try {
    const rows: any[] = await dashDb.$queryRawUnsafe(
      `SELECT ${PROJECT_COLS} FROM "Project" WHERE "id" = ? AND "deviceId" IS NULL`, id
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
  'CREATE TABLE IF NOT EXISTS "Project" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "path" TEXT NOT NULL, "description" TEXT NOT NULL DEFAULT \'\', "icon" TEXT NOT NULL DEFAULT \'folder\', "tags" TEXT NOT NULL DEFAULT \'[]\', "order" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL)',
  'CREATE UNIQUE INDEX IF NOT EXISTS "Project_path_key" ON "Project"("path")',
  'CREATE TABLE IF NOT EXISTS "Environment" ("id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL, "name" TEXT NOT NULL, "cmd" TEXT NOT NULL, "port" INTEGER NOT NULL, "envVars" TEXT NOT NULL DEFAULT \'{}\', "status" TEXT NOT NULL DEFAULT \'stopped\', "pid" INTEGER, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL, CONSTRAINT "Environment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE)',
  'CREATE INDEX IF NOT EXISTS "Environment_projectId_idx" ON "Environment"("projectId")',
];

async function ensureAgentDb(): Promise<void> {
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch { /* read-only fs — prisma will surface a clear error later */ }
  for (const ddl of AGENT_DDL) {
    try { await db.$executeRawUnsafe(ddl); } catch (err: any) {
      console.warn(`[Agent] bootstrap DDL failed: ${err?.message}`);
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

async function startProcess(
  projectId: string,
  envName: string,
  cmd: string,
  projectPath: string,
  envVars: Record<string, string>,
  port: number
): Promise<{ success: boolean; pid?: number; error?: string }> {
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

    // Sanitize env
    delete env.DATABASE_URL;
    delete env.__NEXT_PRIVATE_ROOT_RENDER_ID;

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

    // Log stdout and stderr
    const logStream = createWriteStream(logFile, { flags: 'a' });

    // Write timestamp header
    logStream.write(`\n[${new Date().toISOString()}] === Process started: ${cmd} (port=${port}) ===\n`);

    child.stdout?.on('data', (data: Buffer) => logStream.write(data));
    child.stderr?.on('data', (data: Buffer) => logStream.write(data));

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
      return { success: false, error: 'Process exited immediately' };
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
        version: '1.1.0',
        platform: platform(),
        arch: arch(),
        // Whether this agent serves a co-located dashboard's projects
        // (dashboards use it to explain what the listing contains).
        dashboardDb: !!DASHBOARD_DB_PATH,
      });
      return;
    }

    // Auth check
    if (!verifyAuth(req)) {
      sendJSON(res, 401, { error: 'Unauthorized' });
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

    // GET /api/agent/projects
    if (pathname === '/api/agent/projects' && req.method === 'GET') {
      // Dashboard machines: serve the co-located dashboard's OWN projects
      // (deviceId IS NULL) merged with standalone agent-DB projects.
      const [dashProjects, agentProjects] = await Promise.all([
        listDashProjects(),
        safeAgentProjects(),
      ]);
      const projects: any[] = [...dashProjects, ...agentProjects];

      const allPorts = projects.flatMap(p => p.environments.map(e => e.port));
      const portChecks = await Promise.all(allPorts.map(p => checkPortStatus(p).then(ok => [p, ok] as const)));
      const activePorts = new Map(portChecks);

      const enriched = projects.map(project => ({
        ...project,
        environments: project.environments.map(env => ({
          ...env,
          status: activePorts.get(env.port) ? 'running' : 'stopped',
        })),
      }));

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
      // local UI reads).
      if (dashDb && (await getDashProject(projectId))) {
        const sets: string[] = [];
        const params: any[] = [];
        for (const field of ['name', 'description', 'icon', 'tags'] as const) {
          if (body[field] !== undefined) {
            sets.push(`"${field}" = ?`);
            params.push(String(body[field]));
          }
        }
        if (sets.length > 0) {
          sets.push('"updatedAt" = ?');
          params.push(Date.now());
          params.push(projectId);
          await dashDb.$executeRawUnsafe(`UPDATE "Project" SET ${sets.join(', ')} WHERE "id" = ? AND "deviceId" IS NULL`, ...params);
        }
        sendJSON(res, 200, { project: await getDashProject(projectId) });
        return;
      }
      const project = await db.project.update({
        where: { id: projectId },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.icon !== undefined && { icon: body.icon }),
          ...(body.tags !== undefined && { tags: body.tags }),
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
        sendJSON(res, 400, { ok: false, error: result.error });
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
        sendJSON(res, 400, { ok: false, error: result.error });
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
        sendJSON(res, 400, { ok: false, error: result.error });
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
          'INSERT INTO "Environment" ("id","projectId","name","cmd","port","envVars","status","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?)',
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

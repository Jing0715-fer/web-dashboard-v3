/**
 * Dashboard Agent for Windows (Plain JavaScript — Cross-Platform)
 *
 * Runs on each remote device and exposes REST API for the Dashboard to manage
 * projects, environments, and processes.
 *
 * Usage:
 *   node agent.js --port 3100 --apiKey <token>
 *   node agent.js --port 3100 --apiKey <token> --name "My-Device"
 *   node agent.js --config agent-config.json
 *   node agent.js --install-service
 *   node agent.js --uninstall-service
 *
 * Windows Service:
 *   node agent.js --install-service --port 3100 --apiKey <token>
 *   node agent.js --uninstall-service
 */

'use strict';

const http = require('http');
const { PrismaClient } = require('@prisma/client');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ======================== PLATFORM DETECTION ========================

const IS_WINDOWS = os.platform() === 'win32';
const PATH_SEP = IS_WINDOWS ? ';' : ':';

console.log(`[Agent] Platform: ${os.platform()} ${os.arch()} (${IS_WINDOWS ? 'Windows' : 'Unix-like'})`);

// ======================== COMMAND-LINE ARGUMENT PARSING ========================

/**
 * Parse command-line arguments into a simple key-value map.
 * Supports: --key value, --flag (boolean true), --config path
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

const cliArgs = parseArgs(process.argv.slice(2));

// ======================== CONFIG FILE SUPPORT ========================

/**
 * Load configuration from a JSON file specified by --config flag.
 * CLI arguments take precedence over config file values.
 */
function loadConfigFile(configPath) {
  try {
    const resolvedPath = path.resolve(configPath);
    if (!fs.existsSync(resolvedPath)) {
      console.warn(`[Agent] Config file not found: ${resolvedPath}`);
      return {};
    }
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const config = JSON.parse(content);
    console.log(`[Agent] Loaded config from: ${resolvedPath}`);
    return config;
  } catch (err) {
    console.warn(`[Agent] Failed to load config file: ${err.message}`);
    return {};
  }
}

// Merge config file with CLI args (CLI takes precedence)
const fileConfig = cliArgs.config ? loadConfigFile(cliArgs.config) : {};
const PORT = parseInt(cliArgs.port || fileConfig.port || '3100', 10);
const API_KEY = cliArgs.apiKey || fileConfig.apiKey || crypto.randomBytes(32).toString('hex');
const AGENT_NAME = cliArgs.name || fileConfig.name || os.hostname();
const HOST = IS_WINDOWS ? '0.0.0.0' : (cliArgs.host || fileConfig.host || '0.0.0.0');

console.log(`[Agent] Config: port=${PORT}, name=${AGENT_NAME}, host=${HOST}`);
console.log(`[Agent] API Key: ${API_KEY}`);

// Persist the *runtime* config so the dashboard backend can auto-discover
// this agent (port + apiKey + name) for web-UI mesh pairing — see
// GET /api/mesh/local-agent on the dashboard. Merged with any existing
// agent-config.json so extra fields survive restarts.
try {
  const configPath = path.resolve(process.cwd(), 'agent-config.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch (e) { /* first run */ }
  fs.writeFileSync(configPath, JSON.stringify({
    ...existing,
    port: PORT,
    apiKey: API_KEY,
    name: AGENT_NAME,
    dbPath: existing.dbPath || path.join(process.cwd(), 'db', 'agent.db'),
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
} catch (err) {
  console.warn(`[Agent] Failed to persist agent-config.json: ${err.message}`);
}

// ======================== PID FILE MANAGEMENT (Windows Service Support) ========================

/**
 * PID file path — used for Windows Service pattern to track the running process.
 * Stored in the agent's own directory so it persists across restarts.
 */
const PID_FILE = path.resolve(process.cwd(), 'agent.pid');

function writePidFile() {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
    console.log(`[Agent] PID file written: ${PID_FILE} (PID: ${process.pid})`);
  } catch (err) {
    console.warn(`[Agent] Failed to write PID file: ${err.message}`);
  }
}

function removePidFile() {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
      console.log(`[Agent] PID file removed: ${PID_FILE}`);
    }
  } catch (err) {
    console.warn(`[Agent] Failed to remove PID file: ${err.message}`);
  }
}

function readPidFile() {
  try {
    if (fs.existsSync(PID_FILE)) {
      return parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    }
  } catch (err) {
    // Ignore
  }
  return null;
}

// Write PID file on startup
writePidFile();

// ======================== WINDOWS SERVICE MANAGEMENT ========================

/**
 * Install the agent as a Windows Service using the node-windows pattern.
 * Creates a daemon wrapper script and registers it with Windows Service Control Manager.
 *
 * This uses a simplified approach:
 * 1. Creates a wrapper .bat file that starts the agent
 * 2. Uses sc.exe or nssm.exe to register the service
 *
 * For production, use the install-service.ps1 script instead, which provides
 * a more robust service installation experience.
 */
function installWindowsService() {
  if (!IS_WINDOWS) {
    console.error('[Agent] --install-service is only available on Windows');
    process.exit(1);
  }

  console.log('[Agent] Installing Dashboard Agent as a Windows Service...');
  console.log('[Agent] Note: This requires Administrator privileges.');

  const scriptDir = process.cwd();
  const serviceName = 'DashboardAgent';
  const nodePath = process.execPath;
  const agentPath = path.join(scriptDir, 'agent.js');

  // Build the command arguments
  const argsList = [];
  argsList.push(`--port ${PORT}`);
  argsList.push(`--apiKey ${API_KEY}`);
  argsList.push(`--name "${AGENT_NAME}"`);

  // Save config file for service use
  const configData = {
    port: PORT,
    apiKey: API_KEY,
    name: AGENT_NAME,
    dbPath: path.join(scriptDir, 'db', 'agent.db'),
  };
  const configPath = path.join(scriptDir, 'agent-config.json');
  fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf-8');
  argsList.push(`--config "${configPath}"`);

  // Create wrapper batch file
  const wrapperContent = [
    '@echo off',
    `cd /d "${scriptDir}"`,
    `set DATABASE_URL=file:${path.join(scriptDir, 'db', 'agent.db').replace(/\\/g, '\\\\')}`,
    `"${nodePath}" "${agentPath}" ${argsList.join(' ')}`,
  ].join('\r\n');

  const wrapperPath = path.join(scriptDir, 'run-agent-service.bat');
  fs.writeFileSync(wrapperPath, wrapperContent, 'utf-8');
  console.log(`[Agent] Created service wrapper: ${wrapperPath}`);

  // Try to register the service using sc.exe
  try {
    // Delete existing service if present
    try {
      execSync(`sc.exe stop ${serviceName}`, { stdio: 'pipe' });
    } catch (e) { /* service may not be running */ }

    try {
      execSync(`sc.exe delete ${serviceName}`, { stdio: 'pipe' });
    } catch (e) { /* service may not exist */ }

    // Wait a moment
    const sync = require('child_process').execSync;
    sync('timeout /t 2 /nobreak >nul', { stdio: 'pipe' });

    // Create the service
    execSync(
      `sc.exe create ${serviceName} binPath= "${wrapperPath}" start= auto DisplayName= "Dashboard Agent"`,
      { stdio: 'pipe' }
    );

    // Set description
    try {
      execSync(
        `sc.exe description ${serviceName} "Dashboard Agent - Remote device management service"`,
        { stdio: 'pipe' }
      );
    } catch (e) { /* description set may fail on some Windows versions */ }

    console.log(`[Agent] Service "${serviceName}" installed successfully!`);
    console.log(`[Agent] Use 'sc start ${serviceName}' or 'Start-Service ${serviceName}' to start.`);
    console.log(`[Agent] Use 'sc stop ${serviceName}' or 'Stop-Service ${serviceName}' to stop.`);
    console.log(`[Agent] Config saved to: ${configPath}`);
  } catch (err) {
    console.error(`[Agent] Failed to install service: ${err.message}`);
    console.error('[Agent] Make sure you are running as Administrator.');
    console.error('[Agent] Alternatively, use the install-service.ps1 PowerShell script.');
    process.exit(1);
  }

  process.exit(0);
}

/**
 * Uninstall the Windows Service.
 */
function uninstallWindowsService() {
  if (!IS_WINDOWS) {
    console.error('[Agent] --uninstall-service is only available on Windows');
    process.exit(1);
  }

  console.log('[Agent] Uninstalling Dashboard Agent Windows Service...');
  console.log('[Agent] Note: This requires Administrator privileges.');

  const serviceName = 'DashboardAgent';

  try {
    // Stop the service
    try {
      execSync(`sc.exe stop ${serviceName}`, { stdio: 'pipe' });
      console.log(`[Agent] Service stopped.`);
    } catch (e) {
      console.warn('[Agent] Service may not be running.');
    }

    // Wait a moment
    execSync('timeout /t 2 /nobreak >nul', { stdio: 'pipe' });

    // Delete the service
    execSync(`sc.exe delete ${serviceName}`, { stdio: 'pipe' });
    console.log(`[Agent] Service "${serviceName}" uninstalled successfully!`);
  } catch (err) {
    console.error(`[Agent] Failed to uninstall service: ${err.message}`);
    console.error('[Agent] Make sure you are running as Administrator.');
    process.exit(1);
  }

  process.exit(0);
}

// Handle --install-service and --uninstall-service flags
if (cliArgs['install-service']) {
  installWindowsService();
  // installWindowsService calls process.exit, so we never reach here
}
if (cliArgs['uninstall-service']) {
  uninstallWindowsService();
  // uninstallWindowsService calls process.exit, so we never reach here
}

// ======================== DATABASE ========================

const dbPath = path.resolve(process.cwd(), 'db', 'agent.db');

// Ensure db directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new PrismaClient({
  datasources: { db: { url: `file:${dbPath}` } },
});

console.log(`[Agent] Database: ${dbPath}`);

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
const DASHBOARD_DB_ARG = String(cliArgs.dashboardDb || fileConfig.dashboardDb || '');
function detectDashboardDb() {
  const candidates = [];
  if (DASHBOARD_DB_ARG) candidates.push(path.resolve(DASHBOARD_DB_ARG));
  // "dashboardDb" field in agent-config.json (read inline — the persisted
  // config helpers further below are defined later in this file)
  let persisted = '';
  try {
    persisted = String((JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'agent-config.json'), 'utf-8')) || {}).dashboardDb || '');
  } catch (e) { /* no agent-config.json yet */ }
  if (persisted) candidates.push(path.resolve(persisted));
  // mini-services/agent-linux → project root → db/custom.db
  candidates.push(path.resolve(process.cwd(), '..', '..', 'db', 'custom.db'));
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* unreadable */ }
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
function toDate(v) { return v instanceof Date ? v : new Date(Number(v) || String(v)); }
function toInt(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function toPid(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

const PROJECT_COLS = '"id","name","path","description","icon","tags","order","createdAt","updatedAt"';
const ENV_COLS = '"id","projectId","name","cmd","port","envVars","status","pid","createdAt","updatedAt"';

function mapEnvRow(e) {
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

function mapProjectRow(p, envs) {
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

async function dashEnvsFor(projectIds) {
  const byProject = new Map();
  if (!dashDb || projectIds.length === 0) return byProject;
  const rows = await dashDb.$queryRawUnsafe(
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
async function listDashProjects() {
  if (!dashDb) return [];
  try {
    const rows = await dashDb.$queryRawUnsafe(
      `SELECT ${PROJECT_COLS} FROM "Project" WHERE "deviceId" IS NULL ORDER BY "order" ASC, "updatedAt" DESC`
    );
    const envs = await dashEnvsFor(rows.map((r) => r.id));
    return rows.map((r) => mapProjectRow(r, envs.get(r.id) || []));
  } catch (err) {
    console.warn(`[Agent] dashboard DB listing failed: ${err.message}`);
    return [];
  }
}

async function getDashProject(id) {
  if (!dashDb) return null;
  try {
    const rows = await dashDb.$queryRawUnsafe(
      `SELECT ${PROJECT_COLS} FROM "Project" WHERE "id" = ? AND "deviceId" IS NULL`, id
    );
    if (rows.length === 0) return null;
    const envs = await dashEnvsFor([id]);
    return mapProjectRow(rows[0], envs.get(id) || []);
  } catch (e) { return null; }
}

/** Env + owning project path from the dashboard DB, or null. */
async function getDashEnvFull(projectId, envId) {
  if (!dashDb) return null;
  try {
    const rows = await dashDb.$queryRawUnsafe(
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
  } catch (e) { return null; }
}

/** Update status/pid on a dashboard env row (process control writes). */
async function setDashEnvState(envId, data) {
  if (!dashDb) return;
  const sets = [];
  const params = [];
  if (data.status !== undefined) { sets.push('"status" = ?'); params.push(data.status); }
  if (data.pid !== undefined) { sets.push('"pid" = ?'); params.push(data.pid); }
  if (sets.length === 0) return;
  sets.push('"updatedAt" = ?'); params.push(Date.now());
  params.push(envId);
  await dashDb.$executeRawUnsafe(`UPDATE "Environment" SET ${sets.join(', ')} WHERE "id" = ?`, ...params);
}

/** Env resolution across BOTH stores: dashboard DB first, agent DB second. */
async function resolveEnv(projectId, envId) {
  if (dashDb) {
    const dashHit = await getDashEnvFull(projectId, envId);
    if (dashHit) return { ...dashHit, fromDash: true };
  }
  const env = await db.environment.findUnique({ where: { id: envId }, include: { project: true } });
  if (!env || env.projectId !== projectId) return null;
  return { env, projectPath: env.project.path, fromDash: false };
}

/** Write a start/stop outcome back to whichever store owns the env. */
async function persistEnvState(envId, fromDash, data) {
  if (fromDash) {
    await setDashEnvState(envId, data).catch(() => { /* ignore */ });
  } else {
    await db.environment.update({ where: { id: envId }, data: { status: data.status, pid: data.pid ?? null } }).catch(() => { /* ignore */ });
  }
}

// ---- agent-DB bootstrap ----
// A fresh clone (or a machine where nobody ran `prisma db push` in
// mini-services/agent) has an agent.db WITHOUT tables — every prisma call
// then fails with P2021, /api/agent/projects returns 500, and remote
// dashboards mark the device OFFLINE (real-world report: "paired but
// devices can't see each other / no remote projects"). The agent creates
// its own tables at boot instead of depending on a manual push.
// (This linux bundle additionally ships the Activity module, so its
// ActivityEvent table + indexes are bootstrapped here too.)
const AGENT_DDL = [
  'CREATE TABLE IF NOT EXISTS "Project" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "path" TEXT NOT NULL, "description" TEXT NOT NULL DEFAULT \'\', "icon" TEXT NOT NULL DEFAULT \'folder\', "tags" TEXT NOT NULL DEFAULT \'[]\', "order" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL)',
  'CREATE UNIQUE INDEX IF NOT EXISTS "Project_path_key" ON "Project"("path")',
  'CREATE TABLE IF NOT EXISTS "Environment" ("id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL, "name" TEXT NOT NULL, "cmd" TEXT NOT NULL, "port" INTEGER NOT NULL, "envVars" TEXT NOT NULL DEFAULT \'{}\', "status" TEXT NOT NULL DEFAULT \'stopped\', "pid" INTEGER, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL, CONSTRAINT "Environment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE)',
  'CREATE INDEX IF NOT EXISTS "Environment_projectId_idx" ON "Environment"("projectId")',
  'CREATE TABLE IF NOT EXISTS "ActivityEvent" ("id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT, "projectName" TEXT, "envId" TEXT, "envName" TEXT, "type" TEXT NOT NULL, "message" TEXT NOT NULL, "detail" TEXT, "level" TEXT NOT NULL DEFAULT \'info\', "durationMs" INTEGER, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)',
  'CREATE INDEX IF NOT EXISTS "ActivityEvent_createdAt_idx" ON "ActivityEvent"("createdAt")',
  'CREATE INDEX IF NOT EXISTS "ActivityEvent_projectId_createdAt_idx" ON "ActivityEvent"("projectId", "createdAt")',
];

async function ensureAgentDb() {
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } catch (e) { /* read-only fs — prisma will surface a clear error later */ }
  for (const ddl of AGENT_DDL) {
    try { await db.$executeRawUnsafe(ddl); } catch (err) {
      console.warn(`[Agent] bootstrap DDL failed: ${err.message}`);
    }
  }
}

/** Agent-DB listing that NEVER throws — a broken/missing agent DB must not
 *  take down the (working) dashboard-DB projects listing. */
async function safeAgentProjects() {
  try {
    return await db.project.findMany({
      include: { environments: true },
      orderBy: [{ order: 'asc' }, { updatedAt: 'desc' }],
    });
  } catch (err) {
    console.warn(`[Agent] agent-DB listing unavailable: ${err.message}`);
    return [];
  }
}

// ======================== ACTIVITY EVENTS (DB-backed, fire-and-forget) ========================

/**
 * Persist an activity event. Fire-and-forget: never awaited by callers,
 * never throws — every failure is swallowed (console-only) so activity
 * logging can never break or block a request.
 */
function logActivity(input) {
  try {
    const data = {
      type: String(input.type || 'info'),
      message: String(input.message || ''),
      level: String(input.level || 'info'),
    };
    if (input.projectId !== undefined) data.projectId = input.projectId || null;
    if (input.projectName !== undefined) data.projectName = input.projectName || null;
    if (input.envId !== undefined) data.envId = input.envId || null;
    if (input.envName !== undefined) data.envName = input.envName || null;
    if (input.detail !== undefined) data.detail = input.detail || null;
    if (input.durationMs !== undefined) data.durationMs = input.durationMs;
    db.activityEvent.create({ data }).catch(() => { /* swallow write errors */ });
  } catch (e) {
    // never throw out of activity logging
  }
}

/** Serialize a DB ActivityEvent row into the dashboard-compatible shape. */
function serializeActivityEvent(e) {
  const ts = (e.createdAt instanceof Date) ? e.createdAt : new Date(e.createdAt);
  const out = {
    id: e.id,
    type: e.type,
    message: e.message,
    timestamp: ts.toISOString(),
  };
  if (e.projectId) out.projectId = e.projectId;
  const metadata = {};
  if (e.envName) metadata.environmentName = e.envName;
  if (e.detail) metadata.detail = e.detail;
  if (e.durationMs !== null && e.durationMs !== undefined) metadata.durationMs = e.durationMs;
  if (Object.keys(metadata).length > 0) out.metadata = metadata;
  return out;
}

// ======================== LOG DIRECTORY (Cross-Platform) ========================

// Windows: %APPDATA%\dashboard-agent-logs  or  %TEMP%\dashboard-agent-logs
// Unix:    /tmp/dashboard-agent-logs
const LOG_DIR = IS_WINDOWS
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dashboard-agent-logs')
  : path.join(os.tmpdir(), 'dashboard-agent-logs');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}
console.log(`[Agent] Log directory: ${LOG_DIR}`);

// ======================== PROCESS MANAGER ========================

const runningProcesses = new Map();

function getProcessKey(projectId, envName) {
  return `${projectId}:${envName}`;
}

/**
 * Check if a command is safe to execute.
 * Blocks dangerous commands and only allows whitelisted executables.
 */
function isCommandSafe(cmd) {
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
function killProcess(pid, force) {
  if (force === undefined) force = false;
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
  } catch (e) {
    return false;
  }
}

/**
 * Start a process for a project environment.
 * Handles cross-platform spawning, logging, and process tracking.
 */
async function startProcess(projectId, envName, cmd, projectPath, envVars, port) {
  if (!isCommandSafe(cmd)) {
    return { success: false, error: `Command not allowed: ${cmd}` };
  }

  const key = getProcessKey(projectId, envName);

  // Kill existing process if running
  if (runningProcesses.has(key)) {
    const existing = runningProcesses.get(key);
    try {
      if (existing.pid) killProcess(existing.pid);
    } catch (e) { /* ignore */ }
    runningProcesses.delete(key);
  }

  const logFile = path.join(LOG_DIR, `${key.replace(/[:\\]/g, '_')}.log`);

  try {
    const env = Object.assign({}, process.env, envVars, {
      PORT: String(port),
      NODE_ENV: envVars.NODE_ENV || 'production',
    });

    // Sanitize env — remove agent-specific vars
    delete env.DATABASE_URL;
    delete env.__NEXT_PRIVATE_ROOT_RENDER_ID;

    // Add node_modules/.bin to PATH (cross-platform separator)
    const nodeBin = path.join(projectPath, 'node_modules', '.bin');
    if (fs.existsSync(nodeBin)) {
      env.PATH = `${nodeBin}${PATH_SEP}${env.PATH}`;
    }

    // Spawn options
    const spawnOptions = {
      cwd: projectPath,
      env: env,
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
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    // Write timestamp header
    logStream.write(`\n[${new Date().toISOString()}] === Process started: ${cmd} (port=${port}) ===\n`);

    if (child.stdout) {
      child.stdout.on('data', (data) => logStream.write(data));
    }
    if (child.stderr) {
      child.stderr.on('data', (data) => logStream.write(data));
    }

    child.on('exit', (code) => {
      logStream.write(`\n[${new Date().toISOString()}] === Process exited with code ${code} ===\n`);
      runningProcesses.delete(key);
      try { logStream.end(); } catch (e) { /* ignore */ }
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

    // Wait and verify the process didn't exit immediately
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (child.exitCode !== null) {
      return { success: false, error: 'Process exited immediately' };
    }

    return { success: true, pid: child.pid || undefined };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Stop a running process.
 * First tries the tracked child process, then falls back to finding by port.
 */
async function stopProcess(projectId, envName, port) {
  const key = getProcessKey(projectId, envName);

  const child = runningProcesses.get(key);
  if (child && child.pid) {
    try {
      killProcess(child.pid);
      // Wait for exit
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          // Force kill after timeout
          try { killProcess(child.pid, true); } catch (e) { /* ignore */ }
          resolve();
        }, 3000);
        child.on('exit', () => { clearTimeout(timeout); resolve(); });
        // If already exited
        if (child.exitCode !== null) { clearTimeout(timeout); resolve(); }
      });
      runningProcesses.delete(key);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Try finding PID on port
  const pid = findPidOnPort(port);
  if (pid && pid !== process.pid) {
    try {
      killProcess(pid);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (e) { /* ignore */ }
    return { success: true };
  }

  return { success: true };
}

/**
 * Find PID listening on a port — cross-platform
 * - Windows: netstat -ano | findstr :PORT | findstr LISTENING
 * - Unix: lsof or ss
 */
function findPidOnPort(port) {
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
      } catch (e) { /* lsof not available */ }

      try {
        const ssOut = execSync(
          `ss -tlnp 'sport = :${port}' 2>/dev/null`,
          { encoding: 'utf-8', timeout: 5000 }
        ).trim();
        const match = ssOut.match(/pid=(\d+)/);
        if (match) return parseInt(match[1], 10);
      } catch (e) { /* ss not available */ }

      return null;
    }
  } catch (e) {
    return null;
  }
}

/**
 * Check if a port has an active listener — cross-platform
 */
async function checkPortStatus(port) {
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
  } catch (e) {
    return false;
  }
}

/**
 * Get the last 200 lines of log output for a project environment.
 */
function getLogs(projectId, envName) {
  const key = getProcessKey(projectId, envName).replace(/[:\\]/g, '_');
  const logFile = path.join(LOG_DIR, `${key}.log`);
  if (!fs.existsSync(logFile)) return [];

  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    return lines.slice(-200);
  } catch (e) {
    return [];
  }
}

/**
 * Parse a leading "[ISO] " prefix from a log line.
 * Returns { timestamp (ISO string or null), message } — when a real
 * timestamp is found it is stripped from the message.
 */
function parseLogLine(line) {
  const m = line.match(/^\[([^\]]+)\]\s?(.*)$/);
  if (m) {
    const parsed = Date.parse(m[1]);
    if (!Number.isNaN(parsed)) {
      return { timestamp: new Date(parsed).toISOString(), message: m[2] };
    }
  }
  return { timestamp: null, message: line };
}

/** Infer a log level from the line content. */
function inferLogLevel(text) {
  if (/error|exception|failed|fatal|EADDRINUSE|Cannot find|crash/i.test(text)) return 'error';
  if (/warn|warning|deprecated/i.test(text)) return 'warn';
  return 'info';
}

// ======================== AUTH MIDDLEWARE ========================

function verifyAuth(req) {
  // X-API-Key header (alternative auth for CLI/curl usage)
  const apiKeyHeader = req.headers['x-api-key'];
  if (apiKeyHeader && apiKeyHeader === API_KEY) return true;
  const auth = req.headers['authorization'];
  if (!auth) return false;
  const token = auth.replace('Bearer ', '');
  return token === API_KEY;
}

// ======================== ROUTE HELPERS ========================

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { resolve({}); }
    });
  });
}

// ======================== AUTO-DEBUG ANALYZE ENGINE ========================
// Lightweight LLM-driven loop used on remote devices (no dsh required):
//   files → LLM JSON config → start → verify port → feed errors back → retry.
// The dashboard supplies the LLM endpoint (its llm-gateway) so remote devices
// need no LLM credentials of their own — the dashboard is the mesh's brain.

const analyzeJobs = new Map();

function jobProgress(job, kind, text) {
  job.progress.push({ ts: Date.now(), kind, text });
  if (job.progress.length > 300) job.progress.splice(0, job.progress.length - 300);
  job.updatedAt = Date.now();
}

/** Read a project directory into a compact file digest for the LLM. */
function readProjectDigest(dir) {
  const interesting = ['package.json', 'bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock',
    'README.md', 'next.config.js', 'next.config.ts', 'next.config.mjs', 'vite.config.js',
    'vite.config.ts', 'nuxt.config.ts', 'requirements.txt', 'pyproject.toml', 'Makefile',
    'Dockerfile', 'docker-compose.yml', 'go.mod', 'Cargo.toml', '.env.example'];
  const parts = [];
  for (const name of interesting) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) continue;
    try {
      const content = fs.readFileSync(f, 'utf-8').split('\n').slice(0, 60).join('\n');
      parts.push(`=== ${name} ===\n${content}`);
    } catch { /* unreadable */ }
  }
  const sub = fs.readdirSync(dir).filter(e => {
    try { return fs.statSync(path.join(dir, e)).isDirectory() && !e.startsWith('.') && e !== 'node_modules'; } catch { return false; }
  }).slice(0, 15).join(', ');
  parts.push(`=== top-level dirs ===\n${sub || '(none)'}`);
  return parts.join('\n\n').slice(0, 12000);
}

/** Call an OpenAI-compatible chat endpoint. */
async function llmChat(llmBaseUrl, messages, retries = 3) {
  const url = llmBaseUrl.replace(/\/$/, '') + '/chat/completions';
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 120000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-gateway-key' },
        body: JSON.stringify({ messages, temperature: 0.2 }),
        signal: controller.signal,
      });
      clearTimeout(to);
      if (!res.ok) {
        const text = await res.text();
        if ((res.status === 429 || res.status >= 500) && i < retries) {
          await new Promise(r => setTimeout(r, 4000 * (i + 1)));
          continue;
        }
        throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 3000 * (i + 1)));
    }
  }
  return '';
}

function parseConfigFromText(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try {
    const obj = JSON.parse(t.slice(s, e + 1));
    if (!Array.isArray(obj.environments) || obj.environments.length === 0) return null;
    const valid = obj.environments.filter(env => env && env.cmd && Number(env.port) > 0 && Number(env.port) !== 3000);
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

/** Check whether a TCP port answers (cross-platform). */
function checkPortOpen(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

/** HTTP check via curl when available (validates an actual response). */
function curlCheck(port) {
  try {
    const out = execSync(`curl -s -o /dev/null -w "%{http_code}" --max-time 4 http://127.0.0.1:${port}/ || true`, { encoding: 'utf-8', timeout: 6000 });
    return out.trim();
  } catch { return '000'; }
}

async function runAutoDebugAnalyze(job, llmBaseUrl, usedPorts) {
  try {
    if (!llmBaseUrl) {
      job.status = 'failed';
      job.error = '未提供 LLM 端点（llmBaseUrl）— 请从仪表盘发起远程分析';
      return;
    }
    jobProgress(job, 'note', `项目: ${job.name} (${job.path})`);

    const digest = readProjectDigest(job.path);
    jobProgress(job, 'file', '读取项目文件（package.json / 配置 / README）');

    let feedback = null;
    const MAX_ROUNDS = 4;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      jobProgress(job, 'start', `第 ${round}/${MAX_ROUNDS} 轮配置生成（LLM）`);
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
        jobProgress(job, 'error', 'LLM 未返回有效配置，重试…');
        feedback = 'The previous reply was not valid JSON with environments[].';
        continue;
      }

      const env = config.environments[0];
      jobProgress(job, 'command', `验证启动: ${env.cmd} (:${env.port})`);

      // ---- start & verify ----
      const envVars = { ...env.envVars };
      if (!Object.keys(envVars).some(k => k.toUpperCase() === 'PORT')) envVars.PORT = String(env.port);
      const child = spawn(IS_WINDOWS ? 'cmd' : 'sh',
        IS_WINDOWS ? ['/c', env.cmd] : ['-c', env.cmd],
        { cwd: job.path, env: { ...process.env, ...envVars }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.unref?.();
      let output = '';
      child.stdout?.on('data', c => { output += c.toString(); if (output.length > 8000) output = output.slice(-8000); });
      child.stderr?.on('data', c => { output += c.toString(); if (output.length > 8000) output = output.slice(-8000); });

      let verified = false;
      const waitStart = Date.now();
      while (Date.now() - waitStart < 45000) {
        await new Promise(r => setTimeout(r, 2500));
        const httpCode = curlCheck(env.port);
        if (httpCode !== '000' && httpCode !== '') { verified = true; break; }
        try { process.kill(child.pid, 0); } catch { break; } // exited early
      }

      // ---- stop the verification process ----
      try {
        if (IS_WINDOWS) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { process.kill(child.pid, 'SIGKILL'); } catch {} } }
      } catch { /* already dead */ }
      await new Promise(r => setTimeout(r, 1000));

      if (verified) {
        job.status = 'completed';
        job.result = { ...config, attempts: round, verified: true, finishedAt: Date.now() };
        jobProgress(job, 'result', `验证成功（${round} 轮）：${env.cmd} → :${env.port} 响应正常`);
        return;
      }
      feedback = `Startup command "${env.cmd}" on port ${env.port} did not respond within 45s. Process output:\n${output.slice(-1500) || '(no output)'}`;
      jobProgress(job, 'error', `启动未响应（端口 ${env.port}），准备下一轮调试…`);
    }

    job.status = 'failed';
    job.error = `自动调试 ${MAX_ROUNDS} 轮后仍未成功。最后反馈: ${(feedback || '').slice(0, 400)}`;
  } catch (e) {
    job.status = 'failed';
    job.error = String(e?.message || e);
  } finally {
    // GC the job after 1h
    setTimeout(() => analyzeJobs.delete(job.id), 60 * 60 * 1000).unref?.();
  }
}

// ======================== DEVICE PAIRING ========================
// One-liner mesh join: the dashboard shows a pairing URL + code, and this
// agent registers itself with `--pair <dashboard-origin> --code <code>`.

// ---- Ranked LAN IP detection (mirrors the dashboard's lanIpCandidates) ----
// The FIRST non-internal IPv4 is often a VPN / Clash / Surge TUN fake-IP
// (198.18.0.0/15) or a stale virtual NIC — advertising it registers an
// UNREACHABLE address and the dashboard shows this device offline forever
// (user report: pair registered 192.168.253.1:3100 while the routable
// address was 192.168.101.43:3101).
function lanIpCandidates() {
  const ips = [];
  for (const i of Object.values(os.networkInterfaces()).flat()) {
    if (!i || i.family !== 'IPv4' || i.internal) continue;
    const [a, b] = i.address.split('.').map(Number);
    if (a === 198 && (b === 18 || b === 19)) continue; // VPN fake-IP range
    if (a === 169 && b === 254) continue;              // link-local
    ips.push(i.address);
  }
  const rank = (ip) => {
    const [a, b] = ip.split('.').map(Number);
    if (a === 192 && b === 168) return 0;               // typical home/office LAN
    if (a === 10) return 1;                             // larger private nets
    if (a === 172 && b >= 16 && b <= 31) return 2;      // docker / corp
    if (a === 100 && b >= 64 && b <= 127) return 3;     // CGNAT (Tailscale & friends)
    return 4;
  };
  return ips.sort((x, y) => rank(x) - rank(y));
}

const PERSISTED_CONFIG_PATH = path.resolve(process.cwd(), 'agent-config.json');
function readPersistedConfig() {
  try { return JSON.parse(fs.readFileSync(PERSISTED_CONFIG_PATH, 'utf-8')); } catch (e) { return {}; }
}
function persistConfigField(key, value) {
  try {
    const cfg = readPersistedConfig();
    cfg[key] = value;
    fs.writeFileSync(PERSISTED_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (err) { console.warn(`[Agent] persist ${key} failed: ${err.message}`); }
}

// ---- heartbeat: keep the dashboard's Device row fresh ----
// IP drift (DHCP / new network / VPN up) or a port change would leave the
// dashboard's DB pointing at a dead address. Re-registration with the
// already-paired apiKey self-heals the row — POST /api/mesh/register
// accepts {apiKey} WITHOUT a pair code for existing devices.
const DASHBOARD_URL = String(
  cliArgs.dashboard || fileConfig.dashboardUrl || readPersistedConfig().dashboardUrl || ''
).replace(/\/+$/, '');
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

// Re-armable heartbeat target: the pair-target endpoint can point this
// agent at a dashboard AFTER boot (the web-UI join flow does exactly that),
// so the timer must be startable lazily, not only at startup.
let HEARTBEAT_TARGET = DASHBOARD_URL;
let heartbeatTimer = null;
function armHeartbeat() {
  if (!HEARTBEAT_TARGET) return;
  console.log(`[Agent][heartbeat] re-registering with ${HEARTBEAT_TARGET} every ${HEARTBEAT_INTERVAL_MS / 1000}s`);
  if (heartbeatTimer) return; // already armed
  setTimeout(reRegisterWithDashboard, 3000).unref?.();
  heartbeatTimer = setInterval(reRegisterWithDashboard, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

async function reRegisterWithDashboard() {
  if (!HEARTBEAT_TARGET) return;
  const payload = {
    name: AGENT_NAME,
    ip: lanIpCandidates()[0] || '127.0.0.1',
    port: PORT,
    apiKey: API_KEY,
  };
  try {
    const res = await fetch(HEARTBEAT_TARGET + '/api/mesh/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.addressFixed) {
        console.log(`[Agent][heartbeat] dashboard row healed → ${payload.ip}:${payload.port}`);
      }
    } else if (res.status !== 400) {
      // 400 = key unknown to this dashboard (not ours / DB reset) — noisy, skip
      console.warn(`[Agent][heartbeat] dashboard responded ${res.status}`);
    }
  } catch (e) { /* dashboard unreachable — retry next cycle */ }
}

async function pairWithDashboard(dashboardUrl, code) {
  const info = {
    code,
    name: AGENT_NAME,
    ip: lanIpCandidates()[0] || '127.0.0.1', // ranked: LAN first, VPN fake-IP excluded
    port: PORT,
    apiKey: API_KEY,
  };
  const url = dashboardUrl.replace(/\/+$/, '') + '/api/mesh/register';
  console.log(`[Agent][pair] registering with ${url} as "${info.name}" (${info.ip}:${info.port})`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(info),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(`[Agent][pair] SUCCESS — dashboard "${data.dashboard?.name || 'dashboard'}" registered this device.`);
    console.log(`[Agent][pair] You can now manage this device's projects from the dashboard.`);
    // Remember the dashboard so the heartbeat keeps the row fresh (self-heal
    // on later IP/port drift) and restarts re-register automatically.
    persistConfigField('dashboardUrl', dashboardUrl.replace(/\/+$/, ''));
    return true;
  }
  console.error(`[Agent][pair] FAILED (${res.status}): ${data.error || 'unknown error'}`);
  return false;
}

if (cliArgs.pair) {
  const code = cliArgs.code || cliArgs.pairCode;
  if (!code) {
    console.error('[Agent][pair] --code <pairing-code> is required');
    process.exit(1);
  }
  pairWithDashboard(String(cliArgs.pair), String(code))
    .then(ok => process.exit(ok ? 0 : 1))
    .catch(e => { console.error('[Agent][pair] error:', e.message); process.exit(1); });
}

// ======================== HTTP SERVER ========================

const startTime = Date.now();

const server = http.createServer(async (req, res) => {
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

    // ======================== Health endpoint (no auth required) ========================

    if (pathname === '/api/agent/health') {
      sendJSON(res, 200, {
        status: 'ok',
        name: AGENT_NAME,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        version: '1.2.0',
        platform: os.platform(),
        arch: os.arch(),
        pid: process.pid,
        // Whether this agent serves a co-located dashboard's projects
        // (dashboards use it to explain what the listing contains).
        dashboardDb: !!DASHBOARD_DB_PATH,
      });
      return;
    }

    // ======================== Auth check ========================

    if (!verifyAuth(req)) {
      sendJSON(res, 401, { error: 'Unauthorized' });
      return;
    }

    // ======================== POST /api/agent/pair-target ========================
    // {dashboardUrl} — called by the LOCAL dashboard right after a successful
    // join, so this agent heartbeats to the dashboard it just joined — the
    // remote Device row then self-heals on ip/port drift without a manual
    // re-pair.
    if (pathname === '/api/agent/pair-target' && req.method === 'POST') {
      const body = await getBody(req);
      const dashUrl = String(body.dashboardUrl || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\/.+/i.test(dashUrl)) {
        sendJSON(res, 400, { error: 'dashboardUrl must be an http(s) URL' });
        return;
      }
      HEARTBEAT_TARGET = dashUrl;
      // Persist the merged agent-config.json so restarts re-register too.
      persistConfigField('dashboardUrl', dashUrl);
      armHeartbeat();
      console.log(`[Agent][pair-target] heartbeat target set to ${dashUrl}`);
      sendJSON(res, 200, { ok: true, dashboardUrl: dashUrl });
      return;
    }

    // ======================== GET /api/agent/projects ========================

    if (pathname === '/api/agent/projects' && req.method === 'GET') {
      // Dashboard machines: serve the co-located dashboard's OWN projects
      // (deviceId IS NULL) merged with standalone agent-DB projects.
      const [dashProjects, agentProjects] = await Promise.all([
        listDashProjects(),
        safeAgentProjects(),
      ]);
      const projects = [...dashProjects, ...agentProjects];

      const allPorts = projects.flatMap(p => p.environments.map(e => e.port));
      const portChecks = await Promise.all(allPorts.map(p => checkPortStatus(p).then(ok => [p, ok])));
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

    // ======================== POST /api/agent/projects (create project) ========================

    if (pathname === '/api/agent/projects' && req.method === 'POST') {
      const body = await getBody(req);
      // Co-located dashboard: create the project in ITS database so it shows
      // up in the local dashboard UI as a first-class local project.
      if (dashDb) {
        const id = `c${crypto.randomBytes(11).toString('hex')}`;
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
      logActivity({
        projectId: project.id,
        projectName: project.name,
        type: 'create',
        level: 'success',
        message: `Project '${project.name}' created`,
        detail: `Path: ${project.path}`,
      });
      sendJSON(res, 200, { project });
      return;
    }

    // ======================== Match project-level routes: /api/agent/projects/:id ========================

    const projectMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)$/);

    // GET /api/agent/projects/:id
    if (projectMatch && req.method === 'GET') {
      const projectId = projectMatch[1];
      // Dashboard DB first, standalone agent DB second.
      let project = await getDashProject(projectId);
      if (!project) {
        project = await db.project.findUnique({
          where: { id: projectId },
          include: { environments: true },
        });
      }
      if (!project) { sendJSON(res, 404, { error: 'Project not found' }); return; }

      const ports = project.environments.map(e => e.port);
      const portChecks = await Promise.all(ports.map(p => checkPortStatus(p).then(ok => [p, ok])));
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

    // PUT /api/agent/projects/:id
    if (projectMatch && req.method === 'PUT') {
      const projectId = projectMatch[1];
      const body = await getBody(req);
      // Dash-managed project → update the dashboard DB row (same data the
      // local UI reads).
      if (dashDb && (await getDashProject(projectId))) {
        const sets = [];
        const params = [];
        for (const field of ['name', 'description', 'icon', 'tags']) {
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
      logActivity({
        projectId: project.id,
        projectName: project.name,
        type: 'config_change',
        level: 'info',
        message: `Project '${project.name}' updated`,
      });
      sendJSON(res, 200, { project });
      return;
    }

    // DELETE /api/agent/projects/:id
    if (projectMatch && req.method === 'DELETE') {
      const projectId = projectMatch[1];
      // Resolve from either store — envs must be stopped before deleting.
      const dashProject = await getDashProject(projectId);
      const project = dashProject || (await db.project.findUnique({
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
        await dashDb.$executeRawUnsafe('DELETE FROM "Environment" WHERE "projectId" = ?', projectId);
        await dashDb.$executeRawUnsafe('DELETE FROM "Project" WHERE "id" = ? AND "deviceId" IS NULL', projectId);
      } else {
        await db.project.delete({ where: { id: projectId } });
      }
      logActivity({
        projectId,
        projectName: project.name,
        type: 'delete',
        level: 'info',
        message: `Project '${project.name}' deleted`,
      });
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ======================== POST /api/agent/projects/:id/analyze ========================
    // Lightweight local analyzer — no LLM needed. Reads package.json scripts and
    // auto-creates dev/prod environments based on common patterns.
    const analyzeMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/analyze$/);
    if (analyzeMatch && req.method === 'POST') {
      const projectId = analyzeMatch[1];
      const project = await db.project.findUnique({
        where: { id: projectId },
        include: { environments: true },
      });
      if (!project) { sendJSON(res, 404, { error: 'Project not found' }); return; }

      // Read package.json from the project directory
      const pkgPath = path.join(project.path, 'package.json');
      let scripts = {};
      try {
        const pkgRaw = fs.readFileSync(pkgPath, 'utf-8');
        const pkg = JSON.parse(pkgRaw);
        scripts = pkg.scripts || {};
      } catch {
        sendJSON(res, 400, { error: 'Cannot read package.json — ensure the project path is correct and accessible.' });
        return;
      }

      const scriptNames = Object.keys(scripts);

      // Determine dev command: prefer "dev" > "start" > "serve" > first script
      const devCandidates = ['dev', 'start', 'serve', 'develop', 'dev:server'];
      const devScript = devCandidates.find(s => scriptNames.includes(s)) || scriptNames[0];
      const devCmd = devScript ? `npm run ${devScript}` : 'npm start';

      // Determine prod command: prefer "build" + "preview" > "build" > "start"
      const hasBuild = scriptNames.includes('build');
      const hasPreview = scriptNames.includes('preview');
      const hasStart = scriptNames.includes('start');
      let prodCmd;
      if (hasBuild && hasPreview) {
        prodCmd = 'npm run build && npm run preview';
      } else if (hasBuild) {
        prodCmd = 'npm run build && npm start';
      } else if (hasStart) {
        prodCmd = 'npm start';
      } else {
        prodCmd = devCmd;
      }

      // Pick ports: try to extract from the dev command, default 3000/3001
      let devPort = 3000;
      let prodPort = 3001;
      const portMatch = scripts[devScript]?.match(/--port\s+(\d+)/);
      if (portMatch) {
        devPort = parseInt(portMatch[1], 10);
        prodPort = devPort + 1;
      }

      // Delete existing environments if replace=true
      const body = await getBody(req).catch(() => ({}));
      if (body.replace) {
        await db.environment.deleteMany({ where: { projectId } });
      }

      // Create or update dev environment
      const existingDev = project.environments.find(e => e.name === 'dev' || e.name === 'development');
      if (existingDev) {
        await db.environment.update({
          where: { id: existingDev.id },
          data: { cmd: devCmd, port: devPort, envVars: JSON.stringify({ NODE_ENV: 'development', PORT: String(devPort) }) },
        });
      } else {
        await db.environment.create({
          data: { projectId, name: 'dev', cmd: devCmd, port: devPort, envVars: JSON.stringify({ NODE_ENV: 'development', PORT: String(devPort) }), status: 'stopped' },
        });
      }

      // Create or update prod environment (skip if prodCmd === devCmd and ports collide)
      if (prodCmd !== devCmd || prodPort !== devPort) {
        const existingProd = project.environments.find(e => e.name === 'prod' || e.name === 'production');
        if (existingProd) {
          await db.environment.update({
            where: { id: existingProd.id },
            data: { cmd: prodCmd, port: prodPort, envVars: JSON.stringify({ NODE_ENV: 'production', PORT: String(prodPort) }) },
          });
        } else {
          await db.environment.create({
            data: { projectId, name: 'prod', cmd: prodCmd, port: prodPort, envVars: JSON.stringify({ NODE_ENV: 'production', PORT: String(prodPort) }), status: 'stopped' },
          });
        }
      }

      const updated = await db.project.findUnique({
        where: { id: projectId },
        include: { environments: true },
      });
      sendJSON(res, 200, { project: updated, analyzed: { devCmd, devPort, prodCmd, prodPort, scripts: scriptNames } });
      return;
    }

    // ======================== POST /api/agent/projects/:id/environments (add environment) ========================

    const addEnvMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments$/);
    if (addEnvMatch && req.method === 'POST') {
      const projectId = addEnvMatch[1];
      const body = await getBody(req);
      // Dash-managed project → create the environment in the dashboard DB.
      const dashProject = dashDb ? await getDashProject(projectId) : null;
      if (dashProject) {
        const id = `c${crypto.randomBytes(11).toString('hex')}`;
        const now = Date.now();
        await dashDb.$executeRawUnsafe(
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
      logActivity({
        projectId,
        projectName: project.name,
        envId: env.id,
        envName: env.name,
        type: 'create',
        level: 'success',
        message: `Environment '${env.name}' created`,
        detail: `Command: ${env.cmd} (port ${env.port})`,
      });
      sendJSON(res, 200, { environment: env });
      return;
    }

    // ======================== POST .../start ========================

    const startMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/start$/);
    if (startMatch && req.method === 'POST') {
      const projectId = startMatch[1];
      const envId = startMatch[2];
      const resolved = await resolveEnv(projectId, envId);
      if (!resolved) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      const { env, projectPath, fromDash } = resolved;
      // project name for the activity feed (dash envs carry only a path)
      const projectName = (env.project && env.project.name) || path.basename(projectPath || '');

      let envVars = {};
      try { envVars = JSON.parse(env.envVars); } catch (e) { /* use default empty */ }

      const result = await startProcess(projectId, env.name, env.cmd, projectPath, envVars, env.port);
      if (result.success) {
        await persistEnvState(envId, fromDash, { status: 'running', pid: result.pid ?? null });
        logActivity({
          projectId,
          projectName,
          envId,
          envName: env.name,
          type: 'start',
          level: 'success',
          message: `Environment '${env.name}' started on port ${env.port}`,
          detail: result.pid ? `PID: ${result.pid}` : undefined,
        });
        sendJSON(res, 200, { ok: true, pid: result.pid });
      } else {
        await persistEnvState(envId, fromDash, { status: 'stopped', pid: null });
        logActivity({
          projectId,
          projectName,
          envId,
          envName: env.name,
          type: 'error',
          level: 'error',
          message: `Environment '${env.name}' failed to start`,
          detail: result.error,
        });
        sendJSON(res, 400, { ok: false, error: result.error });
      }
      return;
    }

    // ======================== POST .../stop ========================

    const stopMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/stop$/);
    if (stopMatch && req.method === 'POST') {
      const projectId = stopMatch[1];
      const envId = stopMatch[2];
      const resolved = await resolveEnv(projectId, envId);
      if (!resolved) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      const { env, projectPath, fromDash } = resolved;
      // project name for the activity feed (dash envs carry only a path)
      const projectName = (env.project && env.project.name) || path.basename(projectPath || '');

      const result = await stopProcess(projectId, env.name, env.port);
      await persistEnvState(envId, fromDash, { status: 'stopped', pid: null });
      logActivity({
        projectId,
        projectName,
        envId,
        envName: env.name,
        type: result.success ? 'stop' : 'error',
        level: result.success ? 'info' : 'error',
        message: result.success
          ? `Environment '${env.name}' stopped`
          : `Environment '${env.name}' failed to stop`,
        detail: result.success ? undefined : result.error,
      });
      sendJSON(res, 200, { ok: result.success, error: result.error });
      return;
    }

    // ======================== POST .../restart ========================

    const restartMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/restart$/);
    if (restartMatch && req.method === 'POST') {
      const projectId = restartMatch[1];
      const envId = restartMatch[2];
      const resolved = await resolveEnv(projectId, envId);
      if (!resolved) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      const { env, projectPath, fromDash } = resolved;
      // project name for the activity feed (dash envs carry only a path)
      const projectName = (env.project && env.project.name) || path.basename(projectPath || '');

      const cycleStart = Date.now();
      await stopProcess(projectId, env.name, env.port);
      await new Promise(r => setTimeout(r, 500));

      let envVars = {};
      try { envVars = JSON.parse(env.envVars); } catch (e) { /* use default empty */ }

      const result = await startProcess(projectId, env.name, env.cmd, projectPath, envVars, env.port);
      if (result.success) {
        await persistEnvState(envId, fromDash, { status: 'running', pid: result.pid ?? null });
        logActivity({
          projectId,
          projectName,
          envId,
          envName: env.name,
          type: 'restart',
          level: 'success',
          message: `Environment '${env.name}' restarted`,
          detail: `Now running on port ${env.port}${result.pid ? ` (PID: ${result.pid})` : ''}`,
          durationMs: Date.now() - cycleStart,
        });
        sendJSON(res, 200, { ok: true, pid: result.pid });
      } else {
        await persistEnvState(envId, fromDash, { status: 'stopped', pid: null });
        logActivity({
          projectId,
          projectName,
          envId,
          envName: env.name,
          type: 'error',
          level: 'error',
          message: `Environment '${env.name}' failed to restart`,
          detail: result.error,
        });
        sendJSON(res, 400, { ok: false, error: result.error });
      }
      return;
    }

    // ======================== POST .../rebuild ========================

    const rebuildMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/rebuild$/);
    if (rebuildMatch && req.method === 'POST') {
      const projectId = rebuildMatch[1];
      const envId = rebuildMatch[2];
      const resolved = await resolveEnv(projectId, envId);
      if (!resolved) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      const { env, projectPath, fromDash } = resolved;
      // project name for the activity feed (dash envs carry only a path)
      const projectName = (env.project && env.project.name) || path.basename(projectPath || '');

      const cycleStart = Date.now();
      // Stop → wait → restart
      await stopProcess(projectId, env.name, env.port);
      await new Promise(r => setTimeout(r, 1000));

      let envVars = {};
      try { envVars = JSON.parse(env.envVars); } catch (e) { /* use default empty */ }

      const result = await startProcess(projectId, env.name, env.cmd, projectPath, envVars, env.port);
      if (result.success) {
        await persistEnvState(envId, fromDash, { status: 'running', pid: result.pid ?? null });
        logActivity({
          projectId,
          projectName,
          envId,
          envName: env.name,
          type: 'rebuild',
          level: 'success',
          message: `Environment '${env.name}' rebuilt`,
          detail: `Now running on port ${env.port}${result.pid ? ` (PID: ${result.pid})` : ''}`,
          durationMs: Date.now() - cycleStart,
        });
        sendJSON(res, 200, { ok: true, pid: result.pid });
      } else {
        await persistEnvState(envId, fromDash, { status: 'stopped', pid: null });
        logActivity({
          projectId,
          projectName,
          envId,
          envName: env.name,
          type: 'error',
          level: 'error',
          message: `Environment '${env.name}' failed to rebuild`,
          detail: result.error,
        });
        sendJSON(res, 400, { ok: false, error: result.error });
      }
      return;
    }

    // ======================== GET .../logs (environment-level) ========================

    const envLogsMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/logs$/);
    if (envLogsMatch && req.method === 'GET') {
      const projectId = envLogsMatch[1];
      const envId = envLogsMatch[2];
      const resolved = await resolveEnv(projectId, envId);
      if (!resolved) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      const logs = getLogs(projectId, resolved.env.name);
      sendJSON(res, 200, { logs });
      return;
    }

    // ======================== PUT /api/agent/projects/:id/environments/:envId ========================

    const envMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)$/);

    if (envMatch && req.method === 'PUT') {
      const projectId = envMatch[1];
      const envId = envMatch[2];
      const body = await getBody(req);
      // Dash-managed env → update the dashboard DB row.
      if (dashDb) {
        const dashHit = await getDashEnvFull(projectId, envId);
        if (dashHit) {
          const sets = [];
          const params = [];
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

    // ======================== DELETE /api/agent/projects/:id/environments/:envId ========================

    if (envMatch && req.method === 'DELETE') {
      const projectId = envMatch[1];
      const envId = envMatch[2];
      const resolved = await resolveEnv(projectId, envId);
      if (!resolved) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      const { env, projectPath, fromDash } = resolved;
      // project name for the activity feed (dash envs carry only a path)
      const projectName = (env.project && env.project.name) || path.basename(projectPath || '');
      await stopProcess(projectId, env.name, env.port);
      if (fromDash) {
        await dashDb.$executeRawUnsafe('DELETE FROM "Environment" WHERE "id" = ? AND "projectId" = ?', envId, projectId);
      } else {
        await db.environment.delete({ where: { id: envId } });
      }
      logActivity({
        projectId,
        projectName,
        envId,
        envName: env.name,
        type: 'delete',
        level: 'info',
        message: `Environment '${env.name}' deleted`,
      });
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ======================== GET /api/agent/projects/:id/activity ========================
    // Real events from the DB (written fire-and-forget by logActivity in the
    // mutation handlers above). Empty table → [].

    const activityMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/activity$/);
    if (activityMatch && req.method === 'GET') {
      const projectId = activityMatch[1];
      const events = await db.activityEvent.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      sendJSON(res, 200, events.map(serializeActivityEvent));
      return;
    }

    // ======================== GET /api/agent/projects/:id/logs (project-level) ========================
    // Real file logs: aggregate every environment's log file (written by the
    // process manager) for this project. Lines keep file order (old → new)
    // within each environment; timestamps are parsed from "[ISO] " prefixes
    // when present, otherwise null.

    const projectLogsMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/logs$/);
    if (projectLogsMatch && req.method === 'GET') {
      const projectId = projectLogsMatch[1];
      const project = await db.project.findUnique({
        where: { id: projectId },
        include: { environments: { orderBy: { createdAt: 'asc' } } },
      });
      const logs = [];
      if (project) {
        for (const env of project.environments) {
          const lines = getLogs(projectId, env.name);
          lines.forEach((line, idx) => {
            const { timestamp, message } = parseLogLine(line);
            logs.push({
              id: `${env.id}-${idx}`,
              timestamp,
              level: inferLogLevel(message),
              source: env.name,
              message,
              projectId,
              envName: env.name,
            });
          });
        }
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
      const projectPath = path.resolve(String(body.path || ''));
      if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        sendJSON(res, 400, { error: `Invalid path: ${projectPath}` });
        return;
      }
      const jobId = crypto.randomUUID();
      const job = {
        id: jobId, path: projectPath, name: String(body.name || path.basename(projectPath)),
        status: 'running', createdAt: Date.now(), updatedAt: Date.now(),
        progress: [], result: null, error: null,
      };
      analyzeJobs.set(jobId, job);
      runAutoDebugAnalyze(job, body.llmBaseUrl || null, Array.isArray(body.usedPorts) ? body.usedPorts : [3000, 3100, 3021, 3022]);
      sendJSON(res, 200, { jobId });
      return;
    }

    // ======================== 404 ========================

    sendJSON(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('[Agent] Error:', error);
    sendJSON(res, 500, { error: error.message });
  }
});

// Pair-only mode: registration already exited the process after completion;
// never bind the HTTP server in that mode.
if (cliArgs.pair) {
  // Keep the process alive only until pairWithDashboard settles and exits it.
  const pairWatchdog = setTimeout(() => { console.error('[Agent][pair] timed out'); process.exit(1); }, 30000);
  pairWatchdog.unref?.();
} else {
server.listen(PORT, HOST, () => {
  console.log(`[Agent] Dashboard Agent listening on ${HOST}:${PORT}`);
  console.log(`[Agent] Name: ${AGENT_NAME}`);
  console.log(`[Agent] Platform: ${os.platform()} ${os.arch()}`);
  console.log(`[Agent] DB: ${dbPath}`);
  if (DASHBOARD_DB_PATH) console.log(`[Agent] Dashboard projects: ${DASHBOARD_DB_PATH}`);
  console.log(`[Agent] Logs: ${LOG_DIR}`);
  console.log(`[Agent] PID: ${process.pid}`);
  console.log(`[Agent] PID File: ${PID_FILE}`);
});

// Self-bootstrap the agent DB tables (fresh clones ship no agent.db —
// every prisma call would fail with P2021 until someone ran db push).
ensureAgentDb().catch((err) => console.warn(`[Agent] DB bootstrap failed: ${err.message}`));

// Heartbeat: keep the dashboard's Device row fresh (self-heal on network /
// port change). Runs only when a paired dashboard is known (--dashboard,
// agent-config.json 'dashboardUrl', or set later via /api/agent/pair-target).
if (HEARTBEAT_TARGET) armHeartbeat();
}

// Keep alive — prevent the event loop from being empty
setInterval(() => {
  // Heartbeat — process stays alive
}, 60000);

// ======================== GRACEFUL SHUTDOWN (Cross-Platform) ========================

const shutdown = () => {
  console.log('[Agent] Shutting down...');

  // Kill all managed processes
  for (const [, child] of runningProcesses) {
    try {
      if (child.pid) killProcess(child.pid);
    } catch (e) { /* ignore */ }
  }

  // Remove PID file
  removePidFile();

  // Disconnect databases
  db.$disconnect();
  if (dashDb) dashDb.$disconnect();

  // Close HTTP server
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

// Always remove PID file on exit (even uncaught errors)
process.on('exit', () => {
  try { removePidFile(); } catch (e) { /* ignore */ }
});

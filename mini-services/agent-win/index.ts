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
import { readFileSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { join, resolve, dirname } from 'path';
import { randomBytes } from 'crypto';
import { hostname, tmpdir, platform, arch, homedir } from 'os';

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

console.log(`[Agent] Config: port=${PORT}, name=${AGENT_NAME}, host=${HOST}`);
console.log(`[Agent] API Key: ${API_KEY}`);

// ======================== DATABASE ========================

const dbPath = resolve(process.cwd(), 'db', 'agent.db');
const db = new PrismaClient({
  datasources: { db: { url: `file:${dbPath}` } },
});

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
      });
      return;
    }

    // Auth check
    if (!verifyAuth(req)) {
      sendJSON(res, 401, { error: 'Unauthorized' });
      return;
    }

    // GET /api/agent/projects
    if (pathname === '/api/agent/projects' && req.method === 'GET') {
      const projects = await db.project.findMany({
        include: { environments: true },
        orderBy: [{ order: 'asc' }, { updatedAt: 'desc' }],
      });

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
      const project = await db.project.findUnique({
        where: { id: projectId },
        include: { environments: true },
      });
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
      const project = await db.project.findUnique({
        where: { id: projectId },
        include: { environments: true },
      });
      if (!project) { sendJSON(res, 404, { error: 'Project not found' }); return; }
      for (const env of project.environments) {
        await stopProcess(projectId, env.name, env.port);
      }
      await db.project.delete({ where: { id: projectId } });
      sendJSON(res, 200, { ok: true });
      return;
    }

    // POST /api/agent/projects/:id/environments/:envId/start
    const startMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/start$/);
    if (startMatch && req.method === 'POST') {
      const [, projectId, envId] = startMatch;
      const env = await db.environment.findUnique({
        where: { id: envId },
        include: { project: true },
      });
      if (!env || env.projectId !== projectId) { sendJSON(res, 404, { error: 'Environment not found' }); return; }

      let envVars: Record<string, string> = {};
      try { envVars = JSON.parse(env.envVars); } catch {}

      const result = await startProcess(projectId, env.name, env.cmd, env.project.path, envVars, env.port);
      if (result.success) {
        await db.environment.update({ where: { id: envId }, data: { status: 'running', pid: result.pid } });
        sendJSON(res, 200, { ok: true, pid: result.pid });
      } else {
        await db.environment.update({ where: { id: envId }, data: { status: 'stopped', pid: null } });
        sendJSON(res, 400, { ok: false, error: result.error });
      }
      return;
    }

    // POST /api/agent/projects/:id/environments/:envId/stop
    const stopMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/stop$/);
    if (stopMatch && req.method === 'POST') {
      const [, projectId, envId] = stopMatch;
      const env = await db.environment.findUnique({ where: { id: envId } });
      if (!env || env.projectId !== projectId) { sendJSON(res, 404, { error: 'Environment not found' }); return; }

      const result = await stopProcess(projectId, env.name, env.port);
      await db.environment.update({ where: { id: envId }, data: { status: 'stopped', pid: null } });
      sendJSON(res, 200, { ok: result.success, error: result.error });
      return;
    }

    // POST /api/agent/projects/:id/environments/:envId/restart
    const restartMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/restart$/);
    if (restartMatch && req.method === 'POST') {
      const [, projectId, envId] = restartMatch;
      const env = await db.environment.findUnique({
        where: { id: envId },
        include: { project: true },
      });
      if (!env || env.projectId !== projectId) { sendJSON(res, 404, { error: 'Environment not found' }); return; }

      await stopProcess(projectId, env.name, env.port);
      await new Promise(r => setTimeout(r, 500));

      let envVars: Record<string, string> = {};
      try { envVars = JSON.parse(env.envVars); } catch {}

      const result = await startProcess(projectId, env.name, env.cmd, env.project.path, envVars, env.port);
      if (result.success) {
        await db.environment.update({ where: { id: envId }, data: { status: 'running', pid: result.pid } });
        sendJSON(res, 200, { ok: true, pid: result.pid });
      } else {
        await db.environment.update({ where: { id: envId }, data: { status: 'stopped', pid: null } });
        sendJSON(res, 400, { ok: false, error: result.error });
      }
      return;
    }

    // POST /api/agent/projects/:id/environments/:envId/rebuild
    const rebuildMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/rebuild$/);
    if (rebuildMatch && req.method === 'POST') {
      const [, projectId, envId] = rebuildMatch;
      const env = await db.environment.findUnique({
        where: { id: envId },
        include: { project: true },
      });
      if (!env || env.projectId !== projectId) { sendJSON(res, 404, { error: 'Environment not found' }); return; }

      // Stop → wait → restart
      await stopProcess(projectId, env.name, env.port);
      await new Promise(r => setTimeout(r, 1000));

      let envVars: Record<string, string> = {};
      try { envVars = JSON.parse(env.envVars); } catch {}

      const result = await startProcess(projectId, env.name, env.cmd, env.project.path, envVars, env.port);
      if (result.success) {
        await db.environment.update({ where: { id: envId }, data: { status: 'running', pid: result.pid } });
        sendJSON(res, 200, { ok: true, pid: result.pid });
      } else {
        await db.environment.update({ where: { id: envId }, data: { status: 'stopped', pid: null } });
        sendJSON(res, 400, { ok: false, error: result.error });
      }
      return;
    }

    // GET /api/agent/projects/:id/environments/:envId/logs
    const envLogsMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/logs$/);
    if (envLogsMatch && req.method === 'GET') {
      const [, projectId, envId] = envLogsMatch;
      const env = await db.environment.findUnique({ where: { id: envId } });
      if (!env || env.projectId !== projectId) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      const logs = getLogs(projectId, env.name);
      sendJSON(res, 200, { logs });
      return;
    }

    // PUT /api/agent/projects/:id/environments/:envId
    const envMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)$/);
    if (envMatch && req.method === 'PUT') {
      const [, projectId, envId] = envMatch;
      const body = await getBody(req);
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
      const env = await db.environment.findUnique({ where: { id: envId } });
      if (!env || env.projectId !== projectId) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      await stopProcess(projectId, env.name, env.port);
      await db.environment.delete({ where: { id: envId } });
      sendJSON(res, 200, { ok: true });
      return;
    }

    // POST /api/agent/projects (create project on agent)
    if (pathname === '/api/agent/projects' && req.method === 'POST') {
      const body = await getBody(req);
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
  console.log(`[Agent] Logs: ${LOG_DIR}`);
});

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

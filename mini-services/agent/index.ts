/**
 * Dashboard Agent - Standalone headless agent for remote device management
 * 
 * Runs on each remote device and exposes REST API for the Dashboard to manage
 * projects, environments, and processes.
 * 
 * Usage: bun index.ts --port 3100 --apiKey <token>
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { PrismaClient } from '@prisma/client';
import { spawn, ChildProcess } from 'child_process';
import { readFileSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { hostname } from 'os';
import { execSync } from 'child_process';

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
const HOST = getArg('host', '0.0.0.0');

console.log(`[Agent] Config: port=${PORT}, name=${AGENT_NAME}, host=${HOST}`);
console.log(`[Agent] API Key: ${API_KEY}`);

// ======================== DATABASE ========================

const dbPath = resolve(process.cwd(), 'db/agent.db');
const db = new PrismaClient({
  datasources: { db: { url: `file:${dbPath}` } },
});

// ======================== PROCESS MANAGER ========================

const runningProcesses = new Map<string, ChildProcess>();
const LOG_DIR = '/tmp/dashboard-agent-logs';

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

function getProcessKey(projectId: string, envName: string): string {
  return `${projectId}:${envName}`;
}

function isCommandSafe(cmd: string): boolean {
  const blocked = [/rm\s+-rf\s+\//, /fork\s*\(/, /:()\s*{\s*:\s*\|\s*:&\s*}/, /dd\s+if=/, /mkfs/, /chmod\s+777/, /curl.*\|\s*(ba)?sh/, /wget.*\|\s*(ba)?sh/];
  for (const pattern of blocked) {
    if (pattern.test(cmd)) return false;
  }
  const allowed = ['npm', 'npx', 'yarn', 'pnpm', 'bun', 'node', 'python', 'python3', 'go', 'cargo', 'dotnet', 'java', 'ruby', 'rails', 'docker', 'docker-compose', 'make', 'gradle'];
  const first = cmd.trim().split(/\s+/)[0];
  const base = first.split('/').pop() || '';
  return allowed.some(a => base === a || base.startsWith(a));
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
    try { existing.kill('SIGTERM'); } catch {}
    runningProcesses.delete(key);
  }

  const logFile = join(LOG_DIR, `${key.replace(/:/g, '_')}.log`);

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

    // Add node_modules/.bin to PATH
    const nodeBin = join(projectPath, 'node_modules', '.bin');
    if (existsSync(nodeBin)) {
      env.PATH = `${nodeBin}:${env.PATH}`;
    }

    const child = spawn(cmd, [], {
      cwd: projectPath,
      env,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Log stdout and stderr
    const logStream = createWriteStream(logFile, { flags: 'a' });
    child.stdout?.on('data', (data: Buffer) => logStream.write(data));
    child.stderr?.on('data', (data: Buffer) => logStream.write(data));

    child.on('exit', () => {
      runningProcesses.delete(key);
      try { logStream.end(); } catch {}
    });

    child.on('error', (err) => {
      console.error(`[Agent] Process error for ${key}:`, err.message);
    });

    // Detach so it survives parent exit
    child.unref();
    runningProcesses.set(key, child);

    // Wait and verify
    await new Promise(resolve => setTimeout(resolve, 1500));
    
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
  if (child) {
    try {
      child.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      runningProcesses.delete(key);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  // Try finding PID on port
  try {
    let pid: string | null = null;
    
    try {
      pid = execSync(`lsof -t -i :${port} -sTCP:LISTEN 2>/dev/null`).toString().trim().split('\n')[0];
    } catch {}
    
    if (!pid) {
      try {
        const output = execSync(`ss -tlnp 'sport = :${port}' 2>/dev/null`).toString();
        const match = output.match(/pid=(\d+)/);
        if (match) pid = match[1];
      } catch {}
    }
    
    if (pid && parseInt(pid) !== process.pid) {
      try {
        process.kill(parseInt(pid), 'SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch {}
      return { success: true };
    }
  } catch {}

  return { success: true };
}

async function checkPortStatus(port: number): Promise<boolean> {
  try {
    const output = execSync(`ss -tlnp 'sport = :${port}' 2>/dev/null || lsof -t -i :${port} -sTCP:LISTEN 2>/dev/null`).toString();
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function getLogs(projectId: string, envName: string): string[] {
  const key = getProcessKey(projectId, envName).replace(/:/g, '_');
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
        version: '1.0.0',
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
});

// Keep alive
setInterval(() => {
  // Heartbeat log every 60 seconds
}, 60000);

// Graceful shutdown
const shutdown = () => {
  console.log('[Agent] Shutting down...');
  for (const [, child] of runningProcesses) {
    try { child.kill('SIGTERM'); } catch {}
  }
  db.$disconnect();
  server.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

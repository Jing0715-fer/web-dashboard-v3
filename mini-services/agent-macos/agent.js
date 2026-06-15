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

// ======================== AUTH MIDDLEWARE ========================

function verifyAuth(req) {
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
      });
      return;
    }

    // ======================== Auth check ========================

    if (!verifyAuth(req)) {
      sendJSON(res, 401, { error: 'Unauthorized' });
      return;
    }

    // ======================== GET /api/agent/projects ========================

    if (pathname === '/api/agent/projects' && req.method === 'GET') {
      const projects = await db.project.findMany({
        include: { environments: true },
        orderBy: [{ order: 'asc' }, { updatedAt: 'desc' }],
      });

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

    // ======================== Match project-level routes: /api/agent/projects/:id ========================

    const projectMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)$/);

    // GET /api/agent/projects/:id
    if (projectMatch && req.method === 'GET') {
      const projectId = projectMatch[1];
      const project = await db.project.findUnique({
        where: { id: projectId },
        include: { environments: true },
      });
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

    // DELETE /api/agent/projects/:id
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

    // ======================== POST .../start ========================

    const startMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/start$/);
    if (startMatch && req.method === 'POST') {
      const projectId = startMatch[1];
      const envId = startMatch[2];
      const env = await db.environment.findUnique({
        where: { id: envId },
        include: { project: true },
      });
      if (!env || env.projectId !== projectId) { sendJSON(res, 404, { error: 'Environment not found' }); return; }

      let envVars = {};
      try { envVars = JSON.parse(env.envVars); } catch (e) { /* use default empty */ }

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

    // ======================== POST .../stop ========================

    const stopMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/stop$/);
    if (stopMatch && req.method === 'POST') {
      const projectId = stopMatch[1];
      const envId = stopMatch[2];
      const env = await db.environment.findUnique({ where: { id: envId } });
      if (!env || env.projectId !== projectId) { sendJSON(res, 404, { error: 'Environment not found' }); return; }

      const result = await stopProcess(projectId, env.name, env.port);
      await db.environment.update({ where: { id: envId }, data: { status: 'stopped', pid: null } });
      sendJSON(res, 200, { ok: result.success, error: result.error });
      return;
    }

    // ======================== POST .../restart ========================

    const restartMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/restart$/);
    if (restartMatch && req.method === 'POST') {
      const projectId = restartMatch[1];
      const envId = restartMatch[2];
      const env = await db.environment.findUnique({
        where: { id: envId },
        include: { project: true },
      });
      if (!env || env.projectId !== projectId) { sendJSON(res, 404, { error: 'Environment not found' }); return; }

      await stopProcess(projectId, env.name, env.port);
      await new Promise(r => setTimeout(r, 500));

      let envVars = {};
      try { envVars = JSON.parse(env.envVars); } catch (e) { /* use default empty */ }

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

    // ======================== POST .../rebuild ========================

    const rebuildMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/rebuild$/);
    if (rebuildMatch && req.method === 'POST') {
      const projectId = rebuildMatch[1];
      const envId = rebuildMatch[2];
      const env = await db.environment.findUnique({
        where: { id: envId },
        include: { project: true },
      });
      if (!env || env.projectId !== projectId) { sendJSON(res, 404, { error: 'Environment not found' }); return; }

      // Stop → wait → restart
      await stopProcess(projectId, env.name, env.port);
      await new Promise(r => setTimeout(r, 1000));

      let envVars = {};
      try { envVars = JSON.parse(env.envVars); } catch (e) { /* use default empty */ }

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

    // ======================== GET .../logs (environment-level) ========================

    const envLogsMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)\/logs$/);
    if (envLogsMatch && req.method === 'GET') {
      const projectId = envLogsMatch[1];
      const envId = envLogsMatch[2];
      const env = await db.environment.findUnique({ where: { id: envId } });
      if (!env || env.projectId !== projectId) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      const logs = getLogs(projectId, env.name);
      sendJSON(res, 200, { logs });
      return;
    }

    // ======================== PUT /api/agent/projects/:id/environments/:envId ========================

    const envMatch = pathname.match(/^\/api\/agent\/projects\/([^/]+)\/environments\/([^/]+)$/);

    if (envMatch && req.method === 'PUT') {
      const projectId = envMatch[1];
      const envId = envMatch[2];
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

    // ======================== DELETE /api/agent/projects/:id/environments/:envId ========================

    if (envMatch && req.method === 'DELETE') {
      const projectId = envMatch[1];
      const envId = envMatch[2];
      const env = await db.environment.findUnique({ where: { id: envId } });
      if (!env || env.projectId !== projectId) { sendJSON(res, 404, { error: 'Environment not found' }); return; }
      await stopProcess(projectId, env.name, env.port);
      await db.environment.delete({ where: { id: envId } });
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ======================== GET /api/agent/projects/:id/activity ========================

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

    // ======================== GET /api/agent/projects/:id/logs (project-level) ========================

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

    // ======================== 404 ========================

    sendJSON(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('[Agent] Error:', error);
    sendJSON(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[Agent] Dashboard Agent listening on ${HOST}:${PORT}`);
  console.log(`[Agent] Name: ${AGENT_NAME}`);
  console.log(`[Agent] Platform: ${os.platform()} ${os.arch()}`);
  console.log(`[Agent] DB: ${dbPath}`);
  console.log(`[Agent] Logs: ${LOG_DIR}`);
  console.log(`[Agent] PID: ${process.pid}`);
  console.log(`[Agent] PID File: ${PID_FILE}`);
});

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

  // Disconnect database
  db.$disconnect();

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

import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync, statSync, readdirSync, readFileSync as readFile } from 'fs';
import { join } from 'path';

const execp = promisify(exec);

// Global process registry
const processes = new Map<string, ChildProcess>();

// Log directory
const LOG_DIR = '/tmp/web-dashboard-logs';
const MAX_LOG_SIZE = 1024 * 1024; // 1MB max log file size

// Reserved ports that MUST NOT be killed by stopProcess / restartProcess
// Protects the dashboard's own port, common dev tools, and system ports.
const RESERVED_PORTS = new Set<number>([
  3000, // web-dashboard self (its own dev server)
  ...(process.env.RESERVED_PORTS?.split(',').map(p => parseInt(p.trim(), 10)).filter(n => !isNaN(n)) ?? []),
]);

// Reserved PID: the dashboard's own process. Never kill this one.
const SELF_PID = process.pid;

// Ensure log directory exists
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

function getLogKey(projectId: string, envName: string): string {
  return `${projectId}:${envName}`;
}

function getLogFilePath(key: string): string {
  // Sanitize key for filename
  const safeKey = key.replace(/[^a-zA-Z0-9:._-]/g, '_');
  return join(LOG_DIR, `${safeKey}.log`);
}

function appendLog(key: string, line: string) {
  try {
    const filePath = getLogFilePath(key);
    appendFileSync(filePath, line + '\n', 'utf8');
    
    // Trim log file if too large
    try {
      const stat = statSync(filePath);
      if (stat.size > MAX_LOG_SIZE) {
        const content = readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const trimmed = lines.slice(-200).join('\n');
        writeFileSync(filePath, trimmed, 'utf8');
      }
    } catch {
      // ignore trim errors
    }
  } catch {
    // ignore file write errors
  }
}

export function getLogs(projectId: string, envName: string): string[] {
  const key = getLogKey(projectId, envName);
  const filePath = getLogFilePath(key);
  try {
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, 'utf8');
    return content.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Validate a port number is a safe integer in valid range
 */
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Check if a port is currently in use (listening)
 */
export async function checkPortStatus(port: number): Promise<boolean> {
  if (!isValidPort(port)) return false;
  try {
    // Try lsof first
    const { stdout: lsofOut } = await execp(`lsof -iTCP:${port} -sTCP:LISTEN -n -P 2>/dev/null`);
    if (lsofOut.trim().length > 0) return true;
  } catch {
    // lsof not available, try ss
  }
  try {
    const { stdout: ssOut } = await execp(`ss -tlnp 2>/dev/null | grep ':${port} '`);
    if (ssOut.trim().length > 0) return true;
  } catch {
    // ss not available either
  }
  return false;
}

/**
 * Batch check multiple ports at once using a single `ss` call.
 * Returns a Set of ports that are currently in use.
 */
export async function batchCheckPorts(ports: number[]): Promise<Set<number>> {
  const validPorts = ports.filter(isValidPort);
  if (validPorts.length === 0) return new Set();
  
  const activePorts = new Set<number>();
  
  try {
    // Single ss call to get all listening ports
    const { stdout } = await execp('ss -tlnp 2>/dev/null');
    const lines = stdout.trim().split('\n');
    for (const line of lines) {
      // Extract port from lines like: LISTEN  0  128  *:3000  *:*
      const match = line.match(/[:.](\d+)\s/);
      if (match) {
        const p = parseInt(match[1], 10);
        if (validPorts.includes(p)) {
          activePorts.add(p);
        }
      }
    }
  } catch {
    // ss not available, fall back to individual checks
    for (const port of validPorts) {
      if (await checkPortStatus(port)) {
        activePorts.add(port);
      }
    }
  }
  
  return activePorts;
}

/**
 * Get the PID of a process listening on a port
 */
export async function getPidOnPort(port: number): Promise<number | null> {
  if (!isValidPort(port)) return null;

  // CRITICAL: never return the dashboard's own PID, regardless of port.
  // This prevents the dashboard from killing itself.
  if (RESERVED_PORTS.has(port)) return null;

  // Try lsof first
  try {
    const { stdout } = await execp(`lsof -iTCP:${port} -sTCP:LISTEN -n -P -t 2>/dev/null`);
    const pid = parseInt(stdout.trim().split('\n')[0], 10);
    if (!isNaN(pid) && pid > 0 && pid !== SELF_PID) return pid;
  } catch {
    // lsof not available
  }

  // Fallback: use ss
  try {
    const { stdout } = await execp(`ss -tlnp 'sport = :${port}' 2>/dev/null`);
    // ss output format: LISTEN  0  128  *:3000  *:*  users:(("node",pid=12345,fd=18))
    const match = stdout.match(/pid=(\d+)/);
    if (match) {
      const pid = parseInt(match[1], 10);
      if (!isNaN(pid) && pid > 0) return pid;
    }
  } catch {
    // ss not available
  }

  // Fallback: use fuser
  try {
    const { stdout } = await execp(`fuser ${port}/tcp 2>/dev/null`);
    const pid = parseInt(stdout.trim().split(/\s+/)[0], 10);
    if (!isNaN(pid) && pid > 0) return pid;
  } catch {
    // fuser not available
  }

  return null;
}

/**
 * Parse a command string into shell-compatible format.
 * For complex commands (with &&, ||, pipes), use shell mode.
 */
function parseCommand(cmd: string): { useShell: boolean; command: string; args: string[] } {
  // If the command contains shell operators or variable substitutions, use shell mode
  const shellOperators = ['&&', '||', '|', '>', '<', '>>', '<<', ';', '$(', '`'];
  const hasVarSubstitution = /\$\{?[A-Z_][A-Z0-9_]*\}?/.test(cmd);
  const needsShell = shellOperators.some(op => cmd.includes(op)) || hasVarSubstitution;

  if (needsShell) {
    return { useShell: true, command: '/bin/sh', args: ['-c', cmd] };
  }

  const parts = cmd.split(' ');
  return { useShell: false, command: parts[0], args: parts.slice(1) };
}

/**
 * Validate a command string - only allow known safe patterns
 */
function isCommandSafe(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  
  // Allow common package managers and dev tools
  const safePrefixes = [
    'npm', 'npx', 'yarn', 'pnpm', 'bun',
    'python', 'python3', 'pip', 'pipenv', 'poetry', 'uvicorn', 'gunicorn', 'flask', 'django',
    'go', 'cargo', 'rustc',
    'java', 'mvn', 'gradle', 'mvnw', './mvnw', './gradlew',
    'dotnet',
    'php', 'artisan', 'composer',
    'ruby', 'rails', 'bundle', 'rackup',
    'docker', 'docker-compose',
    'make',
    'node',
    'serve', 'vite', 'next', 'nuxt',
    'deno',
    'sh', 'bash', './',
    'redis-server', 'mongod', 'postgres',
    'nginx',
    'celery', 'rq',
  ];
  
  // Check if command starts with a safe prefix.
  // Skip leading VAR=value env prefixes (e.g. "DATABASE_URL=... bun run start").
  // The value may contain '/' (e.g. file paths) — we must NOT split the value on '/'.
  let firstToken = trimmed.split(/\s+/)[0] || '';
  if (/^[A-Z_][A-Z0-9_]*=/.test(firstToken)) {
    const tokens = trimmed.split(/\s+/);
    firstToken = tokens[1] || '';
  }
  firstToken = firstToken.split('/').pop() || '';
  const startsSafe = safePrefixes.some(prefix => {
    const prefixBase = prefix.split('/').pop() || prefix;
    return firstToken === prefixBase || firstToken.startsWith(prefixBase);
  });
  
  // Block dangerous patterns
  const dangerousPatterns = [
    /rm\s+-rf/, /rm\s+-r/, /rm\s+-f/,
    /:\s*\(\)\s*\{/,  // fork bomb
    /dd\s+if=/,
    /mkfs/,
    />\s*\/dev\//,
    /chmod\s+777/,
    /wget.*\|\s*(ba)?sh/,
    /curl.*\|\s*(ba)?sh/,
  ];
  
  const hasDangerous = dangerousPatterns.some(p => p.test(trimmed));
  
  return startsSafe && !hasDangerous;
}

/**
 * Start a process for a project environment
 */
export async function startProcess(
  projectId: string,
  envName: string,
  cmd: string,
  cwd: string,
  envVars: Record<string, string> = {},
  port: number
): Promise<{ success: boolean; pid?: number; error?: string }> {
  const key = getLogKey(projectId, envName);

  // Validate port
  if (!isValidPort(port)) {
    return { success: false, error: `Invalid port: ${port}` };
  }

  // PROTECT RESERVED PORTS — never start a project on the dashboard's own port.
  if (RESERVED_PORTS.has(port)) {
    return { success: false, error: `Port ${port} is reserved and protected (cannot start a project on it)` };
  }

  // Validate command safety
  if (!isCommandSafe(cmd)) {
    return { success: false, error: `Command not allowed for security reasons: ${cmd}` };
  }

  // Check if already running on this port
  const isRunning = await checkPortStatus(port);
  if (isRunning) {
    return { success: false, error: `Port ${port} is already in use` };
  }

  // Kill any existing tracked process
  const existing = processes.get(key);
  if (existing) {
    try { existing.kill('SIGTERM'); } catch { /* ignore */ }
    processes.delete(key);
  }

  // Check if the cwd exists and is a directory
  if (!existsSync(cwd)) {
    return { success: false, error: `Directory does not exist: ${cwd}` };
  }

  try {
    // Strip Next.js private/internal variables before passing to child process.
    // These leak from the dashboard's own runtime (e.g. __NEXT_PRIVATE_STANDALONE_CONFIG
    // points at the dashboard's standalone dir) and confuse other Next.js apps
    // when they try to JSON.parse them as their own config.
    //
    // Also strip DATABASE_URL / DATABASE_* — these leak from the dashboard's own
    // Prisma runtime and override the child project's own .env DATABASE_URL.
    // For example: dashboard's DATABASE_URL points at web-dashboard/db/custom.db,
    // so script-manager ends up querying dashboard's DB (no Script table → 500).
    // The child project's own .env will provide its own DATABASE_URL on startup.
    const sanitizedParentEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('__NEXT_PRIVATE_') || k === 'NEXT_DEPLOYMENT_ID' || k === '__NEXT_PROCESSED_ENV' || k === 'TURBOPACK') {
        continue;
      }
      if (k === 'DATABASE_URL' || k.startsWith('DATABASE_')) {
        continue;
      }
      sanitizedParentEnv[k] = v as string | undefined;
    }

    const env: NodeJS.ProcessEnv = {
      ...sanitizedParentEnv,
      ...envVars,
      PORT: String(port),
      // Next.js / bun / node all check HOSTNAME; some also check HOST. Set both.
      HOSTNAME: '0.0.0.0',
      HOST: '0.0.0.0',
    };

    // CRITICAL: prepend the target project's node_modules/.bin to PATH so
    // that `npm run dev` / `next dev` can find the project's own binaries.
    // Also ensure global npm/yarn/bun paths are included.
    const projectNodeBin = join(cwd, 'node_modules', '.bin');
    const globalBinPaths = [
      '/Users/lijing/.local/bin',
      '/Users/lijing/.bun/bin',
      '/Users/lijing/.nvm/versions/node/v22.22.0/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ].filter(existsSync);
    const pathParts = [
      ...(existsSync(projectNodeBin) ? [projectNodeBin] : []),
      ...globalBinPaths,
      process.env.PATH || '',
    ];
    env.PATH = pathParts.join(':');

    const { useShell, command, args } = parseCommand(cmd);

    appendLog(key, `[${new Date().toISOString()}] Starting: ${cmd} (port: ${port}, cwd: ${cwd})`);
    appendLog(key, `[${new Date().toISOString()}] Shell mode: ${useShell}`);

    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach(line => appendLog(key, line));
    });

    child.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach(line => appendLog(key, `[stderr] ${line}`));
    });

    child.on('error', (err) => {
      appendLog(key, `[${new Date().toISOString()}] Spawn Error: ${err.message}`);
      processes.delete(key);
    });

    child.on('exit', (code, signal) => {
      appendLog(key, `[${new Date().toISOString()}] Process exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`);
      processes.delete(key);
    });

    // Detach so process survives parent exit
    child.unref();

    processes.set(key, child);

    // Wait for the process to initialize, then check if it's still alive
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (child.exitCode !== null) {
      // Process already exited - get the error from logs
      const logs = getLogs(projectId, envName);
      const errorLines = logs.filter(l => l.includes('[stderr]') || l.includes('Error') || l.includes('error') || l.includes('ENOENT') || l.includes('not found'));
      const errorMsg = errorLines.length > 0
        ? errorLines.slice(-3).map(l => l.replace('[stderr] ', '')).join('; ')
        : 'Process exited immediately. Check logs for details.';
      return { success: false, error: errorMsg };
    }

    // Check if port is now in use
    const portActive = await checkPortStatus(port);
    if (portActive) {
      appendLog(key, `[${new Date().toISOString()}] [OK] Port ${port} is now active`);
    } else {
      appendLog(key, `[${new Date().toISOString()}] [WAIT] Port ${port} is not yet active (process may still be starting)`);
    }

    return { success: true, pid: child.pid || undefined };
  } catch (err: any) {
    appendLog(key, `[${new Date().toISOString()}] Failed to start: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Stop a process for a project environment
 */
export async function stopProcess(
  projectId: string,
  envName: string,
  port: number
): Promise<{ success: boolean; error?: string }> {
  if (!isValidPort(port)) {
    return { success: false, error: `Invalid port: ${port}` };
  }

  // PROTECT RESERVED PORTS — never kill processes listening on these.
  // Prevents the dashboard from killing itself, its peers, or system services.
  if (RESERVED_PORTS.has(port)) {
    appendLog(getLogKey(projectId, envName),
      `[${new Date().toISOString()}] ⛔ Refused to kill port ${port} (reserved). ` +
      `Set RESERVED_PORTS env to override.`);
    return { success: false, error: `Port ${port} is reserved and protected from being killed` };
  }
  
  const key = getLogKey(projectId, envName);

  // Try to kill via tracked process first
  const child = processes.get(key);
  if (child && child.pid) {
    try {
      process.kill(child.pid, 'SIGTERM');
      appendLog(key, `[${new Date().toISOString()}] Sent SIGTERM to tracked process ${child.pid}`);
    } catch {
      // Process might already be dead
    }
    processes.delete(key);
  }

  // Also try to kill via port
  const pid = await getPidOnPort(port);
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      appendLog(key, `[${new Date().toISOString()}] Sent SIGTERM to process ${pid} on port ${port}`);
    } catch {
      // Process might already be dead
    }
  }

  // Wait and verify
  await new Promise(resolve => setTimeout(resolve, 1500));
  const stillRunning = await checkPortStatus(port);
  if (stillRunning) {
    // Force kill
    const pid2 = await getPidOnPort(port);
    if (pid2) {
      try {
        process.kill(pid2, 'SIGKILL');
        appendLog(key, `[${new Date().toISOString()}] Force killed process ${pid2}`);
      } catch {
        // ignore
      }
    }
  }

  return { success: true };
}

/**
 * Restart a process
 */
export async function restartProcess(
  projectId: string,
  envName: string,
  cmd: string,
  cwd: string,
  envVars: Record<string, string> = {},
  port: number
): Promise<{ success: boolean; pid?: number; error?: string }> {
  await stopProcess(projectId, envName, port);
  await new Promise(resolve => setTimeout(resolve, 500));
  return startProcess(projectId, envName, cmd, cwd, envVars, port);
}

/**
 * Read a project directory and gather info for LLM analysis
 * Uses Node.js fs APIs to avoid command injection
 */
export async function readProjectDir(dirPath: string): Promise<{
  success: boolean;
  files?: string[];
  packageJson?: any;
  configFile?: { name: string; content: string }[];
  error?: string;
}> {
  try {
    // Validate directory exists using fs (not shell)
    if (!existsSync(dirPath)) {
      return { success: false, error: `Directory does not exist: ${dirPath}` };
    }

    // List files using fs (safe from injection)
    const files: string[] = [];
    
    function walkDir(dir: string, depth: number) {
      if (depth > 2) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.env.local' && entry.name !== '.env.development' && entry.name !== '.env.production') continue;
          const fullPath = join(dir, entry.name);
          if (entry.isFile()) {
            // Only include relevant config files
            const relevantExtensions = ['.json', '.yaml', '.yml', '.toml', '.config.js', '.config.ts', '.config.mjs'];
            const relevantNames = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'Makefile', '.env', '.env.local', '.env.development', '.env.production', 'next.config.js', 'next.config.ts', 'next.config.mjs', 'vite.config.ts', 'vite.config.js', 'nuxt.config.ts', 'nuxt.config.js', 'vue.config.js'];
            const isRelevant = relevantExtensions.some(ext => entry.name.endsWith(ext)) || relevantNames.some(name => entry.name === name);
            if (isRelevant) {
              files.push(fullPath);
            }
          } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '.git') {
            walkDir(fullPath, depth + 1);
          }
        }
      } catch {
        // permission denied or similar, skip
      }
    }
    
    walkDir(dirPath, 0);

    // Try to read package.json using fs
    let packageJson = null;
    try {
      const pjPath = join(dirPath, 'package.json');
      if (existsSync(pjPath)) {
        const pjContent = readFileSync(pjPath, 'utf8');
        packageJson = JSON.parse(pjContent);
      }
    } catch {
      // No package.json or parse error
    }

    // Read key config files using fs (safe from injection)
    // NOTE: .env files are excluded to prevent leaking secrets to LLM
    const configFileNames = [
      'package.json', 'next.config.js', 'next.config.ts', 'next.config.mjs',
      'vite.config.ts', 'vite.config.js', 'nuxt.config.ts', 'nuxt.config.js',
      'vue.config.js', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
      // .env files intentionally excluded - they contain secrets
      'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml',
      'go.mod', 'Makefile',
    ];

    const configFiles: { name: string; content: string }[] = [];
    for (const fname of configFileNames) {
      try {
        const fpath = join(dirPath, fname);
        if (!existsSync(fpath)) continue;
        const content = readFileSync(fpath, 'utf8');
        if (content.trim()) {
          // Limit content to first 100 lines to avoid sending huge files to LLM
          const limitedContent = content.split('\n').slice(0, 100).join('\n').trim();
          configFiles.push({ name: fname, content: limitedContent });
        }
      } catch {
        // skip unreadable files
      }
    }

    return {
      success: true,
      files,
      packageJson,
      configFile: configFiles,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

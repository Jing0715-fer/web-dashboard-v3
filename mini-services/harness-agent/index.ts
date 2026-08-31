/**
 * Harness Agent — deepseek-harness (dsh) orchestration layer for the dashboard.
 *
 * Responsibilities:
 *   - Runs `dsh --profile headless` as the LLM agent that analyzes a project
 *     directory, installs dependencies, generates a startup command, and
 *     ACTUALLY VERIFIES it boots (auto-debug loop until the port answers).
 *   - Supervises attempts: if the agent's final answer is not a valid config,
 *     re-runs with the failure feedback (up to N attempts).
 *   - Streams live progress by tailing the dsh session event log
 *     (a zstd-compressed JSONL file written incrementally by dsh).
 *
 * API:
 *   POST /api/harness/analyze            {path, name?, usedPorts?, maxAttempts?}
 *   GET  /api/harness/sessions/:id       → {status, progress[], result?, error?}
 *   GET  /api/harness/sessions/:id/events → SSE progress stream
 *   POST /api/harness/sessions/:id/cancel
 *   GET  /api/harness/health
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { spawn, ChildProcess } from 'child_process';
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, appendFileSync, readlinkSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { join, resolve, basename } from 'path';
import { randomUUID } from 'crypto';
import { zstdDecompressSync } from 'zlib';
import { homedir, tmpdir, platform } from 'os';

const PORT = 3022;
const DSH_BIN = resolve(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const DSH_HOME = resolve(process.cwd(), '.dsh-home');
const PATCH_PATH = resolve(process.cwd(), 'task-patch.yml');
const GATEWAY_KEY = 'local-gateway-key';
const ATTEMPT_TIMEOUT_MS = 8 * 60 * 1000; // per dsh run
const STALL_KILL_MS = 5 * 60 * 1000; // no activity at all → kill the attempt
const MAX_ATTEMPTS = 3;
const LOG_DIR = join(tmpdir(), 'harness-agent-logs');
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
/** Terminal-session snapshots, used to rebuild sessions after a restart. */
const RESULTS_DIR = join(LOG_DIR, 'results');
/** Attempt logs and dsh session dirs older than this are deleted. */
const ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

console.log(`[harness-agent] dsh bin: ${DSH_BIN}`);
console.log(`[harness-agent] DSH_HOME: ${DSH_HOME}`);

// ============================= session store =============================

interface ProgressItem {
  ts: number;
  attempt: number;
  kind: 'start' | 'command' | 'file' | 'message' | 'result' | 'error' | 'note';
  text: string;
}

interface AnalysisSession {
  id: string;
  path: string;
  name: string;
  usedPorts: number[];
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  attempt: number;
  maxAttempts: number;
  progress: ProgressItem[];
  result: any | null;
  error: string | null;
  child: ChildProcess | null;
  cancelled: boolean;
  lastLogSize: number;
  logFile: string;
  poller: any | null;
  lastEventLine: number;
  /** Last time we saw ANY sign of life: stdout/stderr bytes, log growth, progress events. */
  lastActivityAt: number;
  /** Attempt number that was killed for stalling (fed back into the retry prompt). */
  stalledAttempt: number | null;
  /** Warn-once flag for the 2-minute inactivity note. */
  stalledNote: boolean;
  /** True for lightweight sessions rebuilt from RESULTS_DIR after a restart. */
  restored?: boolean;
  /** Wall-clock time the session reached a terminal state (persisted). */
  finishedAt?: number;
}

const sessions = new Map<string, AnalysisSession>();

function pushProgress(s: AnalysisSession, kind: ProgressItem['kind'], text: string) {
  s.progress.push({ ts: Date.now(), attempt: s.attempt, kind, text });
  if (s.progress.length > 400) s.progress.splice(0, s.progress.length - 400);
  s.updatedAt = Date.now();
}

// ============================= dsh session log tailing =============================

/** Decompress a multi-frame zstd file into text. */
function readZstdFrames(file: string): string {
  const buf = readFileSync(file);
  let out = '';
  const frames: number[] = [];
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) frames.push(i);
  }
  if (frames.length === 0) {
    try { return zstdDecompressSync(buf).toString(); } catch { return ''; }
  }
  for (let k = 0; k < frames.length; k++) {
    const piece = buf.slice(frames[k], k + 1 < frames.length ? frames[k + 1] : buf.length);
    try { out += zstdDecompressSync(piece).toString(); } catch { /* partial frame */ }
  }
  return out;
}

function normalizeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Find the newest dsh session log file created after `since` for a project cwd.
 * dsh names session dirs by a slug of the cwd wrapped in dashes (exact rule
 * varies), so we normalize by stripping all dashes and comparing.
 */
function findSessionLogFile(cwd: string, since: number): string | null {
  const root = join(DSH_HOME, 'sessions');
  if (!existsSync(root)) return null;
  const want = normalizeCwd(cwd);
  let best: { file: string; mtime: number } | null = null;
  for (const slugDir of readdirSync(root)) {
    const dir = join(root, slugDir);
    let dirStat;
    try { dirStat = statSync(dir); } catch { continue; }
    if (!dirStat.isDirectory()) continue;
    if (normalizeCwd(slugDir) !== want) continue;
    if (dirStat.mtimeMs < since - 60000) continue; // stale dir for same path
    for (const sub of readdirSync(dir)) {
      const subDir = join(dir, sub);
      let stat;
      try { stat = statSync(subDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      if (stat.mtimeMs < since - 5000) continue;
      const f = join(subDir, 'session.jsonl.zstd');
      if (!existsSync(f)) continue;
      const fst = statSync(f);
      if (!best || fst.mtimeMs > best.mtime) best = { file: f, mtime: fst.mtimeMs };
    }
  }
  return best?.file ?? null;
}

/** Map dsh session events to friendly progress items (idempotent per size). */
function pollDshLog(s: AnalysisSession) {
  const file = findSessionLogFile(s.path, s.createdAt);
  if (!file) return;
  {
    let size = 0;
    try { size = statSync(file).size; } catch { return; }
    if (size <= s.lastLogSize && size !== 0) return;
    s.lastLogSize = size;
    s.lastActivityAt = Date.now(); // log file grew → the agent is alive
    let text = '';
    try { text = readZstdFrames(file); } catch { return; }
    const lines = text.split('\n').filter(l => l.trim());
    // The log is append-only: process only lines beyond what we already saw,
    // so re-reading a grown file never duplicates progress events.
    const newLines = lines.slice(s.lastEventLine);
    s.lastEventLine = lines.length;
    for (const line of newLines) {
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      const d = e.data ?? {};
      if (e.type === 'tool/call') {
        let args = d.arguments ?? {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        if (d.name === 'bash' || d.name === 'pwsh') {
          const cmd = String(args.command ?? '').slice(0, 160);
          if (cmd && !cmd.startsWith('true')) pushProgress(s, 'command', cmd);
        } else if (d.name === 'read' || d.name === 'read_image') {
          pushProgress(s, 'file', `读取 ${String(args.file_path ?? '').replace(s.path, '.')}`);
        } else if (d.name === 'write') {
          pushProgress(s, 'file', `写入 ${String(args.file_path ?? '').replace(s.path, '.')}`);
        } else if (d.name === 'edit' || d.name === 'str_replace_editor') {
          pushProgress(s, 'file', `编辑 ${String(args.file_path ?? args.path ?? '').replace(s.path, '.')}`);
        } else if (d.name === 'glob' || d.name === 'grep') {
          pushProgress(s, 'note', `搜索 ${String(args.pattern ?? args.query ?? '').slice(0, 60)}`);
        } else if (d.name === 'job_list' || d.name === 'job_output' || d.name === 'job_kill') {
          const c = String(args.command ?? '').slice(0, 100);
          if (c) pushProgress(s, 'note', `后台任务 ${d.name === 'job_kill' ? '停止' : '查看'}: ${c}`);
        }
      }
    }
  }
}

// ============================= task construction =============================

function buildTask(s: AnalysisSession, feedback?: string): string {
  const usedPorts = s.usedPorts.length > 0 ? s.usedPorts.join(', ') : 'none';
  return `You are a DevOps agent. Analyze the project in the current working directory and produce a VERIFIED startup configuration.

Steps you MUST complete:
1. Inspect the project files (package.json, bun.lock, config files, README) to understand the stack, scripts, and how it starts.
2. If dependencies are missing or incomplete, install them with the project's own package manager (bun install / npm install / pip install -r requirements.txt / go mod download etc).
3. Choose a "dev" startup command and a free port. NEVER use port 3000 (reserved for the dashboard itself)${s.usedPorts.length > 0 ? ` and never use these already-assigned ports: ${usedPorts}` : ''}.
4. VERIFY the dev startup command ACTUALLY WORKS: run it in the background, wait up to 90 seconds, then check the port responds (curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:PORT/ or use a TCP connection check). Read the process output to diagnose failures.
5. If it fails, DEBUG: read the error output, fix the problem (install missing packages, adjust the command or the port, fix trivial config issues), and retry. Keep iterating until the service successfully responds on its port.
6. Determine the PRODUCTION startup: check package.json (or equivalent) for build/start scripts. If they exist, run the production build once (npm run build / bun run build, budget ~3 minutes), then verify the production start command (e.g. npm run start) on a DIFFERENT port (dev port + 1 unless taken). If the production build or start fails, debug briefly (max 2 fix attempts — install missing deps, fix trivial issues); if it still fails, still include a best-guess production entry (build && start with a distinct port) and mention the failure in "summary". If the project has NO build script at all, use the dev command with NODE_ENV=production on a distinct port as the production entry.
7. STOP every process you started (kill them all) so all ports are free again.
8. Finally, reply with ONLY a JSON object (no markdown fences, no extra text):
{"projectName":"...","description":"one sentence","icon":"one of folder,globe,code,database,smartphone,shopping-cart,layout,palette,cpu,book-open,music,gamepad-2,bar-chart,shield,camera,map,cloud,terminal,rocket,puzzle,package,zap,laptop,atom,flame,server","summary":"what you did, problems found and fixed, production verification result","environments":[{"name":"dev","cmd":"the verified command","port":NUMBER,"envVars":{"KEY":"value"}},{"name":"production","cmd":"the production command (build && start when possible)","port":NUMBER,"envVars":{"NODE_ENV":"production","KEY":"value"}}]}

Rules:
- BUDGET DISCIPLINE (a supervisor kills runs that go silent): keep exploration MINIMAL — read package.json and the main entry file(s), at most ~8 files total. NEVER read node_modules, lockfiles, test files, or docs. Aim for ≤ 35 tool calls overall.
- Time budget: dev boot wait ≤ 90s (poll the port every few seconds instead of one long sleep), production build ≤ 3 min, overall target ≤ 6 minutes. If you are running out of budget, STOP exploring and return your best current valid JSON immediately — a partially verified config is far better than a timeout.
- If a port you chose is occupied, either kill the occupying process or move to the next free port. Do NOT retry the same port in a loop.
- The environments array MUST contain BOTH the verified "dev" entry AND a "production" entry, using DIFFERENT ports (e.g. dev=4001, production=4002).
- The production command must be a single shell command; combine build+start with && (e.g. "npm run build && npm run start"). Use bun run instead of npm run if the project uses bun.
- envVars values must be strings. Include HOST=0.0.0.0 and PORT as string when the server needs them; production envVars must include NODE_ENV=production.
- The cmd must be a single shell command usable as-is from the project directory.
- Your final message must be the JSON object only — it is parsed programmatically.${feedback ? `\n\nIMPORTANT — a previous attempt failed. Fix the issue and succeed this time:\n${feedback}` : ''}`;
}

// ============================= run orchestration =============================

function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (platform() === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
    else spawn('sh', ['-c', `kill -TERM -${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null; sleep 1; kill -KILL -${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null`]);
  } catch { /* best effort */ }
}

/**
 * Zombie sweep: kill any leftover process whose CWD is exactly the analyzed
 * project directory. The dsh agent starts servers (npm run dev …) as background
 * jobs; if it is killed mid-run (timeout/cancel/stall) those jobs survive
 * killTree and keep ports occupied, which derails the retry attempt. Sweeping
 * by /proc/<pid>/cwd catches them regardless of how they were spawned.
 */
function killProjectOrphans(s: AnalysisSession, why: string): number {
  try {
    if (platform() === 'win32') return 0;
    const myCwd = process.cwd();
    // Safety: never sweep a directory that contains the harness itself (would
    // kill the dashboard / harness-agent / their node_modules workers).
    if (myCwd === s.path || myCwd.startsWith(s.path + '/')) return 0;
    const victims: number[] = [];
    for (const ent of readdirSync('/proc')) {
      if (!/^\d+$/.test(ent)) continue;
      const pid = Number(ent);
      if (pid === process.pid) continue;
      try {
        const cwd = readlinkSync(join('/proc', ent, 'cwd'));
        if (cwd === s.path) victims.push(pid);
      } catch { continue; } // exited or not ours
    }
    if (victims.length === 0) return 0;
    pushProgress(s, 'note', `清理 ${victims.length} 个遗留进程（${why}）：PID ${victims.slice(0, 6).join(', ')}${victims.length > 6 ? '…' : ''}`);
    for (const pid of victims) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    const hard = setTimeout(() => {
      for (const pid of victims) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }, 1500);
    hard.unref?.();
    return victims.length;
  } catch { return 0; }
}

/** Best-effort cleanup of every live session (used on harness shutdown). */
function cleanupAllSessions() {
  for (const s of sessions.values()) {
    if (s.status === 'running') {
      killTree(s.child?.pid);
      setTimeout(() => killProjectOrphans(s, 'harness 退出清理'), 1000).unref?.();
      // Leave a durable record so a wizard polling across the restart gets
      // a definitive "failed" answer instead of a 404.
      s.status = 'failed';
      s.error = 'harness-agent 服务重启，分析被中断';
      pushProgress(s, 'error', s.error);
      persistResult(s);
    }
  }
}

function parseConfigJson(text: string): any | null {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    // Only hard-reject a completely empty payload — everything else flows
    // into sanitizeConfig, which collects issues instead of rejecting.
    if (!Array.isArray(obj.environments) || obj.environments.length === 0) return null;
    return obj;
  } catch { return null; }
}

// ============================= config sanitization =============================

/**
 * Mirrors the dashboard apply-analysis allowlist: leading VAR=value
 * assignments are stripped before the prefix comparison. Union of the
 * harness task allowlist and apply-analysis's own list.
 */
const SAFE_CMD_PREFIXES = [
  'npm', 'npx', 'node', 'bun', 'yarn', 'pnpm', 'python', 'python3', 'pip', 'pip3',
  'uv', 'uvicorn', 'dotnet', 'java', 'go', 'make', 'sh', 'bash', 'deno', 'cargo',
  'flask', 'gunicorn', 'django', 'php', 'ruby', 'rails', 'bundle', 'docker', './',
];
const stripEnvPrefix = (cmd: string) => cmd.replace(/^([A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, '');

/**
 * Deep-validate an agent-produced config:
 *   - envVars values coerced to strings (non-strings are flagged),
 *   - environments with invalid ports (1024-65535 integer) or missing cmd
 *     are DROPPED with an issue,
 *   - duplicate ports: first one wins, later ones are dropped with an issue,
 *   - non-allowlisted cmds are FLAGGED but kept (apply-analysis decides),
 *   - missing dev / production environments are flagged (apply has fallbacks).
 * Never hard-rejects unless nothing usable survives — issues surface in
 * result.issues and as a note progress event so the wizard can show them.
 */
function sanitizeConfig(config: any): { config: any; issues: string[] } {
  const issues: string[] = [];
  const envsIn: any[] = Array.isArray(config?.environments) ? config.environments : [];
  const envsOut: any[] = [];
  const seenPorts = new Map<number, string>();
  for (const raw of envsIn) {
    if (!raw || typeof raw !== 'object') { issues.push('环境条目不是有效对象，已丢弃'); continue; }
    const name = String(raw.name ?? '').trim() || '(unnamed)';
    // envVars — every value coerced to a string.
    const envVars: Record<string, string> = {};
    if (raw.envVars && typeof raw.envVars === 'object' && !Array.isArray(raw.envVars)) {
      for (const [k, v] of Object.entries(raw.envVars)) {
        if (v === null || v === undefined) continue;
        if (typeof v !== 'string') issues.push(`环境 ${name}: envVars.${k} 值非字符串（${typeof v}），已强转为字符串`);
        envVars[k] = typeof v === 'string' ? v : String(v);
      }
    }
    // port — integer in 1024..65535, otherwise the whole env is dropped.
    const portNum = Number(raw.port);
    if (!Number.isInteger(portNum) || portNum < 1024 || portNum > 65535) {
      issues.push(`环境 ${name}: 端口 ${JSON.stringify(raw.port ?? null)} 无效（需 1024-65535 整数），已丢弃该环境`);
      continue;
    }
    if (portNum === 3000) issues.push(`环境 ${name}: 端口 3000 为仪表盘保留端口，应用层可能拒绝`);
    // cmd — required, otherwise the whole env is dropped.
    const cmd = typeof raw.cmd === 'string' ? raw.cmd.trim() : '';
    if (!cmd) { issues.push(`环境 ${name}: 缺少启动命令（cmd），已丢弃该环境`); continue; }
    // duplicate ports — first one wins, later duplicates are dropped.
    const dupOf = seenPorts.get(portNum);
    if (dupOf !== undefined) {
      issues.push(`环境 ${name}: 端口 ${portNum} 与环境 ${dupOf} 重复，已丢弃后者`);
      continue;
    }
    seenPorts.set(portNum, name);
    // cmd allowlist — flag but KEEP (apply-analysis makes the final call).
    const baseCmd = stripEnvPrefix(cmd);
    if (!SAFE_CMD_PREFIXES.some(p => baseCmd.startsWith(p))) {
      issues.push(`环境 ${name}: 命令「${cmd.slice(0, 60)}」不在白名单前缀内，已保留待应用层裁决`);
    }
    envsOut.push({ ...raw, name, cmd, port: portNum, envVars });
  }
  const hasEnv = (n: string) => envsOut.some(e => String(e.name ?? '').toLowerCase() === n);
  if (!hasEnv('dev')) issues.push('缺少名为 dev 的开发环境');
  if (!hasEnv('production')) issues.push('缺少 production 环境（应用层将尝试合成兜底）');
  return { config: { ...config, environments: envsOut }, issues };
}

// ============================= run orchestration =============================

/** FIFO of session ids waiting for their turn (attempt not yet spawned). */
const runQueue: string[] = [];
/** Session id currently holding the single run slot (spawned, not exited). */
let activeRunId: string | null = null;

/**
 * Serialize dsh runs — the LLM backend rate-limits concurrent agents hard.
 * The run slot is held from spawn until the dsh child exits (startAttempt
 * resolves on exit/error), which is what makes queuePosition/queueLength
 * honest: a session that has not started spawning yet counts as queued.
 * A watchdog frees the slot after 2x the attempt timeout so a lost exit
 * event can never wedge the queue forever.
 */
let runChain: Promise<void> = Promise.resolve();
function enqueueRun(s: AnalysisSession, fn: () => void | Promise<void>): Promise<void> {
  runQueue.push(s.id);
  const run = async () => {
    const idx = runQueue.indexOf(s.id);
    if (idx !== -1) runQueue.splice(idx, 1);
    activeRunId = s.id;
    let watchdogTimer: any = null;
    const watchdog = new Promise<void>((resolve) => {
      watchdogTimer = setTimeout(() => {
        if (activeRunId === s.id) {
          console.error(`[harness-agent] run-slot watchdog fired for session ${s.id} — continuing the queue`);
          activeRunId = null;
        }
        resolve();
      }, ATTEMPT_TIMEOUT_MS * 2);
      watchdogTimer.unref?.();
    });
    try {
      await Promise.race([fn(), watchdog]);
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      if (activeRunId === s.id) activeRunId = null;
    }
  };
  const next = runChain.then(run, run);
  runChain = next.catch(() => {});
  return next;
}

function runAttempt(s: AnalysisSession, feedback?: string) {
  // Serialize across sessions — one dsh agent at a time (LLM rate limits).
  enqueueRun(s, () => startAttempt(s, feedback));
}

function startAttempt(s: AnalysisSession, feedback?: string): Promise<void> {
  // A session cancelled while still queued must never spawn a run.
  if (s.cancelled) return Promise.resolve();
  s.attempt += 1;
  s.lastLogSize = 0;
  s.lastEventLine = 0;
  s.lastActivityAt = Date.now();
  s.stalledNote = false;
  // Clear orphans from a previous attempt before spawning a new run — a
  // leftover dev server holding the port is the #1 cause of retry failures.
  killProjectOrphans(s, `第 ${s.attempt} 次尝试前清扫`);
  pushProgress(s, 'start', `第 ${s.attempt}/${s.maxAttempts} 次分析启动（deepseek-harness agent）`);

  const task = buildTask(s, feedback);
  const logFile = join(LOG_DIR, `${s.id}-attempt${s.attempt}.log`);
  s.logFile = logFile;

  const child = spawn('node', [DSH_BIN, '--profile', 'headless', '--patch', PATCH_PATH, task], {
    cwd: s.path,
    env: {
      ...process.env,
      DSH_HOME,
      ZAI_GATEWAY_KEY: GATEWAY_KEY,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'danger-full-access',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Process-group leader: killTree(-PGID) then reliably reaps dsh AND every
    // job it spawned (npm/node servers), instead of just the dsh process.
    detached: true,
  });
  s.child = child;

  let stdout = '';
  child.stdout!.on('data', (c: Buffer) => {
    stdout += c.toString();
    s.lastActivityAt = Date.now();
    try { appendFileSync(logFile, c); } catch {}
  });
  child.stderr!.on('data', (c: Buffer) => {
    s.lastActivityAt = Date.now();
    try { appendFileSync(logFile, c); } catch {}
    const line = c.toString().trim();
    if (line && !line.startsWith('dsh: ')) pushProgress(s, 'note', line.slice(0, 140));
  });

  const timeout = setTimeout(() => {
    pushProgress(s, 'error', '本次尝试超时，正在终止…');
    killTree(child.pid);
    // dsh background jobs can outlive the tree kill — sweep by project cwd.
    setTimeout(() => killProjectOrphans(s, '超时清扫'), 2500).unref?.();
  }, ATTEMPT_TIMEOUT_MS);

  // The run slot is held until the child is truly gone. 'error' (spawn
  // failure) funnels through the same path so the queue can never wedge.
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        handleAttemptExit(s, code, stdout);
      } catch (err: any) {
        console.error('[harness-agent] attempt exit handler failed:', err?.message || err);
        s.status = 'failed';
        s.error = `Attempt exit handler crashed: ${String(err?.message || err)}`;
        persistResult(s);
      }
      resolve();
    };
    child.on('exit', (code: number | null) => settle(code));
    child.on('error', (err: any) => {
      try { pushProgress(s, 'error', `dsh 进程异常: ${String(err?.message || err).slice(0, 140)}`); } catch { /* ignore */ }
      settle(null);
    });
  });
}

/** Shared exit path: evaluate output, sanitize, retry or finish, persist. */
function handleAttemptExit(s: AnalysisSession, code: number | null, stdout: string) {
  s.child = null;
  // Final sweep regardless of outcome — the task tells the agent to stop its
  // servers, but a supervisor-side guarantee is worth more than a promise.
  setTimeout(() => killProjectOrphans(s, '会话收尾校验'), 2000).unref?.();
  if (s.cancelled) {
    s.status = 'cancelled';
    pushProgress(s, 'error', '已取消');
    persistResult(s);
    return;
  }
  pollDshLog(s);
  const parsed = parseConfigJson(stdout);
  let issueFeedback = '';
  if (parsed) {
    const { config, issues } = sanitizeConfig(parsed);
    if ((config.environments?.length ?? 0) > 0) {
      s.result = {
        ...config,
        issues,
        attempts: s.attempt,
        verified: true,
        finishedAt: Date.now(),
      };
      s.status = 'completed';
      pushProgress(s, 'result', `分析成功（${s.attempt} 次尝试）：${config.environments.length} 个环境配置已生成并验证`);
      if (issues.length > 0) {
        pushProgress(s, 'note', `配置校验提示（${issues.length} 项）：\n${issues.map(i => `· ${i}`).join('\n')}`);
      }
      persistResult(s);
      return;
    }
    // Parsed, but sanitization dropped every environment — retry with the
    // concrete validation problems instead of a generic "invalid output".
    issueFeedback = `The returned JSON was structurally valid but failed validation and every environment was discarded. Fix these problems:\n${issues.map(i => `- ${i}`).join('\n')}\n`;
  }
  if (s.attempt < s.maxAttempts) {
    const tail = stdout.trim().slice(-600) || '(no output)';
    const stallNote = s.stalledAttempt === s.attempt
      ? 'The previous attempt STALLED — no agent activity for 5 minutes and the supervisor killed it (likely a hung command or a blocking wait). Avoid long blocking sleeps; poll with short sleeps instead. '
      : '';
    pushProgress(s, 'error', `第 ${s.attempt} 次尝试未返回有效配置，准备重试`);
    setTimeout(() => {
      if (!s.cancelled && s.status === 'running') runAttempt(s, `${stallNote}${issueFeedback}The previous attempt exited with code ${code} and its final output was not a valid JSON config. Last output:\n${tail}`);
    }, 1500);
  } else {
    s.status = 'failed';
    s.error = `Agent 未能生成有效的启动配置（已尝试 ${s.attempt} 次）。${issueFeedback ? `校验问题：${issueFeedback.replace(/\n/g, ' ').slice(0, 300)} ` : ''}最后输出: ${stdout.trim().slice(-400) || 'empty'}`;
    pushProgress(s, 'error', s.error);
    persistResult(s);
  }
}

function startAnalysis(path: string, name: string, usedPorts: number[], maxAttempts: number): AnalysisSession {
  const id = randomUUID();
  const s: AnalysisSession = {
    id,
    path,
    name,
    usedPorts,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    attempt: 0,
    maxAttempts,
    progress: [],
    result: null,
    error: null,
    child: null,
    cancelled: false,
    lastLogSize: 0,
    lastEventLine: 0,
    logFile: '',
    poller: null,
    lastActivityAt: Date.now(),
    stalledAttempt: null,
    stalledNote: false,
  };
  sessions.set(id, s);
  pushProgress(s, 'note', `项目: ${name} (${path})`);
  runAttempt(s);

  // Live progress poller — tails the dsh session event log, and doubles as
  // the stall supervisor: an agent with no log growth, no stdout and no
  // progress events for 5 minutes is considered hung.
  s.poller = setInterval(() => {
    if (s.status !== 'running') {
      clearInterval(s.poller);
      return;
    }
    try { pollDshLog(s); } catch { /* ignore */ }
    const idleMs = Date.now() - s.lastActivityAt;
    if (s.child && idleMs > STALL_KILL_MS) {
      s.stalledAttempt = s.attempt;
      pushProgress(s, 'error', `Agent 已 ${Math.round(STALL_KILL_MS / 60000)} 分钟无任何活动，判定卡死，终止本次尝试`);
      killTree(s.child.pid);
      setTimeout(() => killProjectOrphans(s, '卡死清扫'), 2500).unref?.();
    } else if (idleMs > 120_000) {
      if (!s.stalledNote) {
        s.stalledNote = true;
        pushProgress(s, 'note', '（两分钟无新事件 — agent 可能正在执行安装/构建等耗时命令，继续等待）');
      }
    } else if (idleMs < 60_000) {
      s.stalledNote = false; // activity resumed — allow a future warn
    }
  }, 2500);

  // Session GC after 1 hour.
  setTimeout(() => {
    if (s.status === 'running') {
      killTree(s.child?.pid);
      setTimeout(() => killProjectOrphans(s, '会话超时清扫'), 2500).unref?.();
      s.status = 'failed';
      s.error = 'Session timed out';
      persistResult(s);
    }
    setTimeout(() => {
      sessions.delete(id);
      deleteResultFile(id); // keep disk in sync with the in-memory store
    }, 60 * 60 * 1000);
  }, 60 * 60 * 1000).unref?.();

  return s;
}

// ============================= result persistence =============================

function summarizeAttempts(s: AnalysisSession): string[] {
  try {
    const per = new Map<number, string[]>();
    for (const p of s.progress) {
      if (p.kind === 'error' || p.kind === 'result') {
        const arr = per.get(p.attempt) ?? [];
        if (arr.length < 3) arr.push(p.text.slice(0, 160));
        per.set(p.attempt, arr);
      }
    }
    const out: string[] = [];
    for (let a = 1; a <= Math.max(s.attempt, 1); a++) {
      const notes = per.get(a);
      if (notes && notes.length > 0) out.push(`attempt ${a}: ${notes.join(' | ')}`);
    }
    return out;
  } catch { return []; }
}

/** Snapshot a terminal session to RESULTS_DIR for restart recovery. */
function persistResult(s: AnalysisSession) {
  try {
    if (s.status === 'running') return;
    mkdirSync(RESULTS_DIR, { recursive: true });
    const finishedAt = Date.now();
    s.finishedAt = finishedAt;
    const payload: any = {
      sessionId: s.id,
      status: s.status,
      projectPath: s.path,
      projectName: s.name,
      startedAt: s.createdAt,
      finishedAt,
      attempts: s.attempt,
      maxAttempts: s.maxAttempts,
      attemptsSummary: summarizeAttempts(s),
    };
    if (s.result !== null && s.result !== undefined) payload.result = s.result;
    if (s.error) payload.error = s.error;
    writeFileSync(join(RESULTS_DIR, `${s.id}.json`), JSON.stringify(payload, null, 2));
  } catch (err: any) {
    console.error('[harness-agent] persistResult failed:', err?.message || err);
  }
}

function deleteResultFile(sessionId: string) {
  try { unlinkSync(join(RESULTS_DIR, `${sessionId}.json`)); } catch { /* absent is fine */ }
}

/**
 * Rebuild lightweight terminal sessions from RESULTS_DIR so the dashboard
 * wizard keeps getting answers (instead of 404) after a harness restart.
 * Restored sessions never re-enter the run queue and are invisible to the
 * stall supervisor (no poller, lastActivityAt = finishedAt).
 */
function restoreSessionsFromDisk(): number {
  let restored = 0;
  try {
    if (!existsSync(RESULTS_DIR)) return 0;
    for (const file of readdirSync(RESULTS_DIR)) {
      try {
        if (!file.endsWith('.json')) continue;
        const id = file.slice(0, -'.json'.length);
        if (!/^[a-f0-9-]{8,}$/.test(id) || sessions.has(id)) continue;
        const data = JSON.parse(readFileSync(join(RESULTS_DIR, file), 'utf8'));
        const status = ['completed', 'failed', 'cancelled'].includes(data.status) ? data.status : 'failed';
        const finishedAt = Number(data.finishedAt) || Date.now();
        const attempts = Number(data.attempts) || 0;
        const s: AnalysisSession = {
          id,
          path: String(data.projectPath || ''),
          name: String(data.projectName || basename(String(data.projectPath || 'restored-session'))),
          usedPorts: [],
          status: status as AnalysisSession['status'],
          createdAt: Number(data.startedAt) || finishedAt,
          updatedAt: finishedAt,
          attempt: attempts,
          maxAttempts: Number(data.maxAttempts) || Math.max(attempts, 1),
          progress: [{ ts: finishedAt, attempt: attempts, kind: 'note', text: `会话已从磁盘恢复（状态：${status}，${attempts} 次尝试）— 原始进度不再可用` }],
          result: data.result ?? null,
          error: data.error ?? null,
          child: null,
          cancelled: status === 'cancelled',
          lastLogSize: 0,
          lastEventLine: 0,
          logFile: '',
          poller: null,
          lastActivityAt: finishedAt,
          stalledAttempt: null,
          stalledNote: false,
          restored: true,
        };
        sessions.set(id, s);
        restored += 1;
      } catch { /* corrupt file — skip it */ }
    }
  } catch { /* never fatal */ }
  return restored;
}

// ============================= disk hygiene =============================

/**
 * Delete attempt logs and dsh session directories older than 7 days.
 * Only plain files in LOG_DIR (the results/ subtree is preserved) and dsh
 * session directories (session-<uuid>) are ever removed; every step is
 * best-effort so cleanup failure never affects the service.
 */
function cleanupOldArtifacts(): { logs: number; dshSessions: number } {
  const removed = { logs: 0, dshSessions: 0 };
  const cutoff = Date.now() - ARTIFACT_TTL_MS;
  try {
    for (const ent of readdirSync(LOG_DIR)) {
      try {
        const p = join(LOG_DIR, ent);
        const st = statSync(p);
        if (!st.isFile()) continue; // results/ and other dirs are untouched
        if (st.mtimeMs < cutoff) { unlinkSync(p); removed.logs += 1; }
      } catch { /* skip */ }
    }
  } catch { /* LOG_DIR unreadable — ignore */ }
  try {
    const root = join(DSH_HOME, 'sessions');
    if (existsSync(root)) {
      for (const slug of readdirSync(root)) {
        try {
          const slugDir = join(root, slug);
          const slugStat = statSync(slugDir);
          if (!slugStat.isDirectory()) continue;
          for (const sub of readdirSync(slugDir)) {
            try {
              const sessDir = join(slugDir, sub);
              const sessStat = statSync(sessDir);
              if (!sessStat.isDirectory()) continue;
              // Conservative freshness: newest mtime among the dir and its
              // direct children (dsh appends to files without touching the
              // directory mtime).
              let newest = sessStat.mtimeMs;
              try {
                for (const f of readdirSync(sessDir)) {
                  try { const fst = statSync(join(sessDir, f)); if (fst.mtimeMs > newest) newest = fst.mtimeMs; } catch { /* skip */ }
                }
              } catch { /* skip */ }
              if (newest < cutoff) {
                rmSync(sessDir, { recursive: true, force: true });
                removed.dshSessions += 1;
              }
            } catch { /* skip */ }
          }
          // Remove the empty project shell only when it is itself older than
          // the TTL (never race an in-flight session creation).
          try {
            if (slugStat.mtimeMs < cutoff && readdirSync(slugDir).length === 0) rmSync(slugDir, { recursive: true, force: true });
          } catch { /* skip */ }
        } catch { /* skip */ }
      }
    }
  } catch { /* never fatal */ }
  return removed;
}

function runArtifactCleanup() {
  try {
    const { logs, dshSessions } = cleanupOldArtifacts();
    console.log(`[harness-agent] disk cleanup: removed ${logs} old attempt log(s), ${dshSessions} old dsh session dir(s) (TTL 7d)`);
  } catch { /* never fatal */ }
}

// ============================= HTTP layer =============================

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: any) {
  const body = JSON.stringify(data);
  // A route that already started writing (e.g. an SSE stream that errored
  // mid-flight) must not attempt writeHead again — that second throw used to
  // escape the async handler and kill the whole service.
  if (res.headersSent) {
    try { res.end(body); } catch { /* connection already gone */ }
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function sessionView(s: AnalysisSession) {
  const view: any = {
    id: s.id,
    path: s.path,
    name: s.name,
    status: s.status,
    attempt: s.attempt,
    maxAttempts: s.maxAttempts,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    progress: s.progress,
    result: s.result,
    error: s.error,
  };
  if (s.restored) view.restored = true;
  // Queue visibility: a session that has not started spawning yet is queued.
  // queuePosition = sessions ahead of it (waiting + the one running);
  // queueLength = total sessions in the queue system right now.
  if (s.status === 'running') {
    const active = activeRunId !== null;
    const pos = runQueue.indexOf(s.id);
    if (pos !== -1) {
      view.queuePosition = pos + (active ? 1 : 0);
      view.queueLength = runQueue.length + (active ? 1 : 0);
    } else if (activeRunId === s.id) {
      view.queuePosition = 0;
      view.queueLength = runQueue.length + 1;
    }
  }
  return view;
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = (req.url || '').split('?')[0];
  try {
    if (req.method === 'GET' && (url === '/api/harness/health' || url === '/health')) {
      return json(res, 200, { status: 'ok', dsh: existsSync(DSH_BIN), sessions: sessions.size, port: PORT });
    }

    // Session list (additive convenience route, also aliased as /sessions).
    if (req.method === 'GET' && (url === '/api/harness/sessions' || url === '/sessions')) {
      const list = Array.from(sessions.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(sessionView);
      return json(res, 200, { sessions: list, count: list.length });
    }

    if (req.method === 'POST' && url === '/api/harness/analyze') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const path = resolve(String(body.path || ''));
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        return json(res, 400, { error: `Invalid project path: ${path}` });
      }
      const usedPorts = Array.isArray(body.usedPorts) ? body.usedPorts.map(Number).filter((n: any) => Number.isInteger(n)) : [];
      const maxAttempts = Math.min(Math.max(Number(body.maxAttempts) || MAX_ATTEMPTS, 1), 5);
      const s = startAnalysis(path, String(body.name || basename(path)), usedPorts, maxAttempts);
      return json(res, 200, { sessionId: s.id, ...sessionView(s) });
    }

    const sessMatch = url.match(/^\/api\/harness\/sessions\/([a-f0-9-]+)(\/events|\/cancel)?$/);
    if (sessMatch) {
      const s = sessions.get(sessMatch[1]);
      if (!s) return json(res, 404, { error: 'Session not found' });
      const action = sessMatch[2];
      if (!action && req.method === 'GET') return json(res, 200, sessionView(s));
      if (action === '/cancel' && req.method === 'POST') {
        s.cancelled = true;
        killTree(s.child?.pid);
        setTimeout(() => killProjectOrphans(s, '取消清扫'), 2500).unref?.();
        if (s.status === 'running') {
          s.status = 'cancelled';
          persistResult(s);
        }
        return json(res, 200, sessionView(s));
      }
      if (action === '/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        let lastCount = 0;
        const send = () => {
          const items = s.progress.slice(lastCount);
          lastCount = s.progress.length;
          if (items.length > 0 || s.status !== 'running') {
            res.write(`data: ${JSON.stringify({ status: s.status, progress: items, attempt: s.attempt, result: s.result, error: s.error })}\n\n`);
          }
          if (s.status !== 'running') {
            res.write('data: [DONE]\n\n');
            res.end();
            clearInterval(timer);
          }
        };
        // Start the interval BEFORE the initial flush: a terminal session
        // (e.g. one restored from disk) ends the stream inside send(), which
        // must be able to clear an already-initialized timer (TDZ crash fix).
        const timer = setInterval(send, 2000);
        send();
        req.on('close', () => clearInterval(timer));
        return;
      }
    }

    json(res, 404, { error: `No route: ${req.method} ${url}` });
  } catch (err: any) {
    console.error('[harness-agent] error:', err);
    json(res, 500, { error: String(err?.message || err) });
  }
});

// Restart recovery + disk hygiene — both best-effort and never fatal.
try {
  const restoredCount = restoreSessionsFromDisk();
  console.log(`[harness-agent] restored ${restoredCount} finished session(s) from ${RESULTS_DIR}`);
} catch { /* ignore */ }
runArtifactCleanup();
const artifactCleanupTimer = setInterval(runArtifactCleanup, 3600_000);
artifactCleanupTimer.unref?.();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[harness-agent] listening on http://0.0.0.0:${PORT}`);
  console.log(`[harness-agent] dsh available: ${existsSync(DSH_BIN)}`);
});

// Don't leave dsh runs + project servers behind when the harness stops.
process.on('SIGTERM', () => { cleanupAllSessions(); process.exit(0); });
process.on('SIGINT', () => { cleanupAllSessions(); process.exit(0); });

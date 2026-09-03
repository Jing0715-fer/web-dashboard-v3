import { spawn, ChildProcess } from 'child_process';
import {
  existsSync, readdirSync, statSync, mkdirSync, appendFileSync, readlinkSync,
  writeFileSync, unlinkSync, rmSync, readFileSync,
} from 'fs';
import { join, resolve, basename } from 'path';
import { randomUUID } from 'crypto';
import * as zlib from 'zlib';
import { tmpdir, platform } from 'os';
import * as fzstd from 'fzstd';

/**
 * Harness engine — the former mini-services/harness-agent(:3022), now running
 * IN-PROCESS inside the dashboard server (single port).
 *
 * Responsibilities:
 *   - Runs `dsh --profile headless` as the LLM agent that analyzes a project
 *     directory, installs dependencies, generates a startup command, and
 *     ACTUALLY VERIFIES it boots (auto-debug loop until the port answers).
 *   - Supervises attempts: if the agent's final answer is not a valid config,
 *     re-runs with the failure feedback (up to N attempts).
 *   - Streams live progress by tailing the dsh session event log
 *     (a zstd-compressed JSONL file written incrementally by dsh).
 *   - dsh talks to the in-process LLM gateway (/api/llm/v1) through a
 *     per-attempt task patch whose baseURL is resolved from the live server.
 *
 * The engine state (sessions, run queue, timers) is a globalThis singleton so
 * every route handler shares ONE instance even across dev-mode hot reloads.
 */

const DSH_BIN = resolve(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const DSH_HOME = resolve(process.cwd(), '.dsh-home');
const GATEWAY_KEY = 'local-gateway-key';
const ATTEMPT_TIMEOUT_MS = 8 * 60 * 1000; // per dsh run
const STALL_KILL_MS = 5 * 60 * 1000; // no activity at all → kill the attempt
const MAX_ATTEMPTS = 3;
const LOG_DIR = join(tmpdir(), 'harness-agent-logs');
/** Terminal-session snapshots, used to rebuild sessions after a restart. */
const RESULTS_DIR = join(LOG_DIR, 'results');
/** Attempt logs and dsh session dirs older than this are deleted. */
const ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Fallback loopback candidates for the LLM gateway base URL. */
const GATEWAY_FALLBACK_PORTS = [3000];

// ============================= zstd (bun/node portable) =============================

/** Decompress one zstd frame — native zlib on modern Node, fzstd elsewhere. */
function decompressFrame(buf: Buffer): string {
  const zstdNative = (zlib as any).zstdDecompressSync;
  if (typeof zstdNative === 'function') {
    return zstdNative.call(zlib, buf).toString();
  }
  const out = fzstd.decompress(new Uint8Array(buf));
  return Buffer.from(out).toString();
}

/** Decompress a multi-frame zstd file into text. */
function readZstdFrames(file: string): string {
  const buf = readFileSync(file);
  let out = '';
  const frames: number[] = [];
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) frames.push(i);
  }
  if (frames.length === 0) {
    try { return decompressFrame(buf); } catch { return ''; }
  }
  for (let k = 0; k < frames.length; k++) {
    const piece = buf.slice(frames[k], k + 1 < frames.length ? frames[k + 1] : buf.length);
    try { out += decompressFrame(piece); } catch { /* partial frame */ }
  }
  return out;
}

// ============================= engine state (globalThis singleton) =============================

export interface ProgressItem {
  ts: number;
  attempt: number;
  kind: 'start' | 'command' | 'file' | 'message' | 'result' | 'error' | 'note';
  text: string;
}

export interface AnalysisSession {
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
  /** LLM gateway base URL the dsh patch points at (resolved per analysis). */
  llmBaseUrl: string;
}

interface EngineRuntime {
  sessions: Map<string, AnalysisSession>;
  runQueue: string[];
  activeRunId: string | null;
  runChain: Promise<void>;
  initialized: boolean;
  gatewayBaseUrl: string | null;
}

const g = globalThis as any;

function engineRuntime(): EngineRuntime {
  if (!g.__dashboardHarnessEngine) {
    g.__dashboardHarnessEngine = {
      sessions: new Map<string, AnalysisSession>(),
      runQueue: [],
      activeRunId: null,
      runChain: Promise.resolve(),
      initialized: false,
      gatewayBaseUrl: null,
    } satisfies EngineRuntime;
  }
  return g.__dashboardHarnessEngine;
}

function pushProgress(s: AnalysisSession, kind: ProgressItem['kind'], text: string) {
  s.progress.push({ ts: Date.now(), attempt: s.attempt, kind, text });
  if (s.progress.length > 400) s.progress.splice(0, s.progress.length - 400);
  s.updatedAt = Date.now();
}

// ============================= dsh session log tailing =============================

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
4. PRE-FLIGHT CLEANUP before starting any server: if the project has a .next/dev/lock file, a dev server for this project is (or was) already running — read the file, get the owning PID (JSON field "pid"), KILL that process tree first (Windows: taskkill /PID <pid> /T /F, otherwise kill -9 <pid>) and only THEN delete the lock file. NEVER delete .next/dev/lock while its process is still alive: two dev servers sharing one .next directory deadlock and every HTTP request then hangs forever. Also verify the port you chose is actually free.
5. VERIFY the dev startup command ACTUALLY WORKS: run it in the background and poll the port in a SHORT LOOP (one curl/TCP check per 5-10 seconds, print every result) for up to 240 seconds. On Windows the FIRST compile of "next dev" regularly takes 2-4 minutes — TCP connects but HTTP still hangs means compilation is in progress: KEEP POLLING, do NOT restart the server, do NOT touch .next/dev/lock. Read the process output/log to diagnose real failures.
6. If it fails, DEBUG: read the error output, fix the problem (install missing packages, adjust the command or the port, fix trivial config issues), and retry. Keep iterating until the service successfully responds on its port.
7. Determine the PRODUCTION startup — ONLY AFTER the dev verification passed: check package.json (or equivalent) for build/start scripts. If they exist, run the production build once (npm run build / bun run build, budget ~3 minutes), then verify the production start command (e.g. npm run start) on a DIFFERENT port (dev port + 1 unless taken). If the production build or start fails, debug briefly (max 2 fix attempts — install missing deps, fix trivial issues); if it still fails, still include a best-guess production entry (build && start with a distinct port) and mention the failure in "summary". If you already spent more than ~4 minutes in total, SKIP the production build entirely and return the best-guess production entry instead. If the project has NO build script at all, use the dev command with NODE_ENV=production on a distinct port as the production entry.
8. STOP every process you started (kill them all) so all ports are free again.
9. Finally, reply with ONLY a JSON object (no markdown fences, no extra text):
{"projectName":"...","description":"one sentence","icon":"one of folder,globe,code,database,smartphone,shopping-cart,layout,palette,cpu,book-open,music,gamepad-2,bar-chart,shield,camera,map,cloud,terminal,rocket,puzzle,package,zap,laptop,atom,flame,server","summary":"what you did, problems found and fixed, production verification result","environments":[{"name":"dev","cmd":"the verified command","port":NUMBER,"envVars":{"KEY":"value"}},{"name":"production","cmd":"the production command (build && start when possible)","port":NUMBER,"envVars":{"NODE_ENV":"production","KEY":"value"}}]}

Rules:
- BUDGET DISCIPLINE (a supervisor kills runs that go silent): keep exploration MINIMAL — read package.json and the main entry file(s), at most ~8 files total. NEVER read node_modules, lockfiles, test files, or docs. Aim for ≤ 35 tool calls overall.
- Time budget: dev boot wait ≤ 240s (poll in a short loop — never one long sleep; on Windows the first "next dev" compile takes 2-4 minutes), production build ≤ 3 min, overall target ≤ 6 minutes. If you are running out of budget, STOP exploring and return your best current valid JSON immediately — a partially verified config is far better than a timeout.
- If a port you chose is occupied, either kill the occupying process or move to the next free port. Do NOT retry the same port in a loop.
- A supervisor KILLS the whole attempt after 5 minutes of total silence: never run a command that blocks without printing anything for more than ~2 minutes (the production build is the ONLY exception). For every wait, loop with short sleeps and print each iteration.
- NEVER run the production build before the dev verification passed, and NEVER delete .next/dev/lock without first killing the PID inside it.
- The environments array MUST contain BOTH the verified "dev" entry AND a "production" entry, using DIFFERENT ports (e.g. dev=4001, production=4002).
- The production command must be a single shell command; combine build+start with && (e.g. "npm run build && npm run start"). Use bun run instead of npm run if the project uses bun.
- envVars values must be strings. Include HOST=0.0.0.0 and PORT as string when the server needs them; production envVars must include NODE_ENV=production.
- The cmd must be a single shell command usable as-is from the project directory.
- Your final message must be the JSON object only — it is parsed programmatically.${feedback ? `\n\nIMPORTANT — a previous attempt failed. Fix the issue and succeed this time:\n${feedback}` : ''}`;
}

/** Write the dsh agent-layer patch with the live LLM gateway base URL. */
function writeTaskPatch(llmBaseUrl: string, attemptFile: string): string {
  const yml = `# Agent-layer composition patch: route dsh's LLM through the
# dashboard's in-process llm-gateway (OpenAI-compatible bridge over
# z-ai-web-dev-sdk / the configured provider) and widen the bash timeout.
- id: llm-pi-ai
  config:
    providers:
      zai-gateway:
        apiKeyEnv: ZAI_GATEWAY_KEY
        api: openai-completions
        baseURL: ${llmBaseUrl.replace(/\/$/, '')}
        compat:
          supportsDeveloperRole: false
          supportsUsageInStreaming: false
          maxTokensField: max_tokens
        models:
          - id: glm-4-plus
            contextWindow: 131072
            maxTokens: 8192
            input: [text]

- id: agent-default-model
  config:
    provider: zai-gateway
    model: glm-4-plus

- id: bash-sandbox
  config:
    timeoutMs: 600000

# This host has no bwrap/landlock sandbox backend — run commands directly.
- id: sandbox-policy
  config:
    mode: danger-full-access
- id: approval
  config:
    policy: never
`;
  writeFileSync(attemptFile, yml);
  return attemptFile;
}

// ============================= run orchestration =============================

function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (platform() === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
    else spawn('sh', ['-c', `kill -TERM -${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null; sleep 1; kill -KILL -${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null`]);
  } catch { /* best effort */ }
}

/** PowerShell zombie sweep for Windows (see sweepWindowsOrphans). ASCII-only
 *  on purpose: PowerShell 5.1 reads BOM-less .ps1 files as the system codepage. */
const SWEEP_PS1 = `param(
  [string]$ProjPath,
  [string]$ExcludePids = ''
)
$ErrorActionPreference = 'SilentlyContinue'
$proj = $ProjPath.TrimEnd('\\').TrimEnd('/')
$projFwd = $proj.Replace('\\', '/')
$probe1 = $proj + '\\'
$probe2 = $projFwd + '/'
$excl = @{}
foreach ($e in ($ExcludePids -split ',')) {
  $t = 0
  if ([int]::TryParse($e.Trim(), [ref]$t)) { $excl[$t] = $true }
}
function Test-CmdlineMatch([string]$cl) {
  if (-not $cl) { return $false }
  if ($cl.IndexOf($probe1, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  if ($cl.IndexOf($probe2, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  return ($cl.Trim('"').Trim() -ieq $proj)
}
# Only kill processes that actually own a LISTENING port (spares editors'
# language servers etc.). $null = cmdlet unavailable -> no port filter.
$listenerPids = $null
try { $listenerPids = @(Get-NetTCPConnection -State Listen | ForEach-Object { [int]$_.OwningProcess }) } catch { $listenerPids = $null }
$victims = @{}
$names = @{}
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='bun.exe' OR Name='npm.exe' OR Name='next.exe'"
foreach ($p in $procs) {
  $v = [int]$p.ProcessId
  if ($excl.ContainsKey($v)) { continue }
  if (-not (Test-CmdlineMatch $p.CommandLine)) { continue }
  if ($null -ne $listenerPids -and -not ($listenerPids -contains $v)) { continue }
  $victims[$v] = $true
  $names[$v] = [string]$p.Name
}
# Next.js dev lock: JSON {"pid":...} of a live dev server for this project.
$lock = Join-Path $proj '.next\\dev\\lock'
if (Test-Path $lock) {
  $lockPid = $null
  try { $j = Get-Content $lock -Raw | ConvertFrom-Json; if ($j -and $j.pid) { $lockPid = [int]$j.pid } } catch {}
  if ($lockPid -and -not $excl.ContainsKey($lockPid)) {
    $lp = Get-CimInstance Win32_Process -Filter "ProcessId=$lockPid"
    if ($lp -and $lp.Name -match '^(node|bun|next|npm)\\.exe$' -and ($null -eq $listenerPids -or ($listenerPids -contains $lockPid))) {
      if (-not $victims.ContainsKey($lockPid)) { $victims[$lockPid] = $true; $names[$lockPid] = "$($lp.Name) (next dev lock)" }
    }
  }
}
foreach ($v in @($victims.Keys)) {
  Write-Output ("KILL " + $v + " " + $names[$v])
  & taskkill /PID $v /T /f 2>$null | Out-Null
}
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }
`;

/**
 * Zombie sweep: kill any leftover process belonging to the analyzed project.
 * The dsh agent starts servers (npm run dev …) as background jobs; if it is
 * killed mid-run (timeout/cancel/stall) those jobs survive killTree and keep
 * ports occupied, which derails the retry attempt — the #1 cause of the
 * "port occupied / retry inherits a dead .next/dev/lock" cascade.
 *   - unix: sweep by /proc/<pid>/cwd — catches every spawn style.
 *   - win32: .next/dev/lock PID + Win32_Process command-line scan (project
 *     path in argv AND owning a listening port) → taskkill /T /F + unlock.
 */
function killProjectOrphans(s: AnalysisSession, why: string): Promise<number> {
  if (platform() === 'win32') return sweepWindowsOrphans(s, why);
  return new Promise((resolve) => {
    try {
      const myCwd = process.cwd();
      // Safety: never sweep a directory that contains the dashboard itself (would
      // kill the dashboard server / its node_modules workers).
      if (myCwd === s.path || myCwd.startsWith(s.path + '/')) { resolve(0); return; }
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
      if (victims.length === 0) { resolve(0); return; }
      pushProgress(s, 'note', `清理 ${victims.length} 个遗留进程（${why}）：PID ${victims.slice(0, 6).join(', ')}${victims.length > 6 ? '…' : ''}`);
      for (const pid of victims) { try { process.kill(pid, 'SIGTERM'); } catch {} }
      const hard = setTimeout(() => {
        for (const pid of victims) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }, 1500);
      hard.unref?.();
      // Give the OS a beat to release the ports before the next attempt spawns.
      const settle = setTimeout(() => resolve(victims.length), 700);
      settle.unref?.();
    } catch { resolve(0); }
  });
}

/** Windows implementation of the orphan sweep (taskkill via PowerShell). */
function sweepWindowsOrphans(s: AnalysisSession, why: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      const projPath = resolve(s.path);
      const norm = (p: string) => p.toLowerCase().replace(/\\/g, '/');
      const nProj = norm(projPath);
      const nMine = norm(process.cwd());
      // Safety: never sweep the dashboard's own directory tree (either direction).
      if (!nProj || nProj === nMine || nMine.startsWith(nProj + '/') || nProj.startsWith(nMine + '/')) {
        resolve(0);
        return;
      }
      mkdirSync(LOG_DIR, { recursive: true });
      const script = join(LOG_DIR, 'sweep-orphans.ps1');
      writeFileSync(script, SWEEP_PS1, 'utf8');
      const exclude = [String(process.pid)];
      if (s.child?.pid) exclude.push(String(s.child.pid));
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-ProjPath', projPath, '-ExcludePids', exclude.join(','),
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, 10_000);
      timer.unref?.();
      child.stdout!.on('data', (c: Buffer) => { out += c.toString(); });
      child.on('error', () => { clearTimeout(timer); resolve(0); });
      child.on('exit', () => {
        clearTimeout(timer);
        const lines = out.split(/\r?\n/).filter((l) => l.startsWith('KILL '));
        if (lines.length > 0) {
          pushProgress(s, 'note', `清理 ${lines.length} 个遗留进程（${why}）：${lines.map((l) => l.slice(5).trim()).slice(0, 6).join('；')}${lines.length > 6 ? '…' : ''}`);
        }
        resolve(lines.length);
      });
    } catch { resolve(0); }
  });
}

/** Best-effort cleanup of every live session (used on server shutdown). */
function cleanupAllSessions() {
  const rt0 = engineRuntime();
  for (const s of rt0.sessions.values()) {
    if (s.status === 'running') {
      killTree(s.child?.pid);
      setTimeout(() => { void killProjectOrphans(s, 'harness 退出清理'); }, 1000).unref?.();
      // Leave a durable record so a wizard polling across the restart gets
      // a definitive "failed" answer instead of a 404.
      s.status = 'failed';
      s.error = '分析引擎随服务器重启，本次分析被中断';
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

/**
 * Serialize dsh runs — the LLM backend rate-limits concurrent agents hard.
 * The run slot is held from spawn until the dsh child exits (startAttempt
 * resolves on exit/error), which is what makes queuePosition/queueLength
 * honest: a session that has not started spawning yet counts as queued.
 * A watchdog frees the slot after 2x the attempt timeout so a lost exit
 * event can never wedge the queue forever.
 */
function enqueueRun(s: AnalysisSession, fn: () => void | Promise<void>): Promise<void> {
  const rt0 = engineRuntime();
  rt0.runQueue.push(s.id);
  const run = async () => {
    const rt = engineRuntime();
    const idx = rt.runQueue.indexOf(s.id);
    if (idx !== -1) rt.runQueue.splice(idx, 1);
    rt.activeRunId = s.id;
    let watchdogTimer: any = null;
    const watchdog = new Promise<void>((resolve) => {
      watchdogTimer = setTimeout(() => {
        const rt2 = engineRuntime();
        if (rt2.activeRunId === s.id) {
          console.error(`[harness] run-slot watchdog fired for session ${s.id} — continuing the queue`);
          rt2.activeRunId = null;
        }
        resolve();
      }, ATTEMPT_TIMEOUT_MS * 2);
      watchdogTimer.unref?.();
    });
    try {
      await Promise.race([fn(), watchdog]);
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      const rt3 = engineRuntime();
      if (rt3.activeRunId === s.id) rt3.activeRunId = null;
    }
  };
  const next = rt0.runChain.then(run, run);
  rt0.runChain = next.catch(() => {});
  return next;
}

function runAttempt(s: AnalysisSession, feedback?: string) {
  // Serialize across sessions — one dsh agent at a time (LLM rate limits).
  enqueueRun(s, () => startAttempt(s, feedback));
}

async function startAttempt(s: AnalysisSession, feedback?: string): Promise<void> {
  // A session cancelled while still queued must never spawn a run.
  if (s.cancelled) return;
  s.attempt += 1;
  s.lastLogSize = 0;
  s.lastEventLine = 0;
  s.lastActivityAt = Date.now();
  s.stalledNote = false;
  // Clear orphans from a previous attempt BEFORE spawning — awaited so the
  // retry truly starts with free ports (on Windows this runs taskkill on
  // leftover dev servers; a zombie holding .next/dev/lock or the port is
  // the #1 cause of retry failures and "port occupied" cascades).
  await killProjectOrphans(s, `第 ${s.attempt} 次尝试前清扫`);
  if (s.cancelled) return; // cancelled while the sweep was running
  pushProgress(s, 'start', `第 ${s.attempt}/${s.maxAttempts} 次分析启动（deepseek-harness agent）`);

  const task = buildTask(s, feedback);
  const logFile = join(LOG_DIR, `${s.id}-attempt${s.attempt}.log`);
  const patchFile = writeTaskPatch(s.llmBaseUrl, join(LOG_DIR, `${s.id}-attempt${s.attempt}.yml`));
  s.logFile = logFile;

  const child = spawn('node', [DSH_BIN, '--profile', 'headless', '--patch', patchFile, task], {
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
    setTimeout(() => { void killProjectOrphans(s, '超时清扫'); }, 2500).unref?.();
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
        console.error('[harness] attempt exit handler failed:', err?.message || err);
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

/** dsh headless often writes NOTHING to stdout when killed mid-run — its real
 *  activity lives in the tailed progress events. Use them as the "last output"
 *  so failure messages explain what actually happened instead of "empty". */
function lastProgressTail(s: AnalysisSession, max: number): string {
  const items = s.progress
    .slice(-8)
    .filter((p) => p.kind === 'command' || p.kind === 'file' || p.kind === 'note' || p.kind === 'message')
    .map((p) => p.text);
  const text = items.join(' | ');
  return text ? text.slice(-max) : '';
}

/** Shared exit path: evaluate output, sanitize, retry or finish, persist. */
function handleAttemptExit(s: AnalysisSession, code: number | null, stdout: string) {
  s.child = null;
  // Final sweep regardless of outcome — the task tells the agent to stop its
  // servers, but a supervisor-side guarantee is worth more than a promise.
  setTimeout(() => { void killProjectOrphans(s, '会话收尾校验'); }, 2000).unref?.();
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
    const tail = stdout.trim().slice(-600) || lastProgressTail(s, 600) || '(no output)';
    const stallNote = s.stalledAttempt === s.attempt
      ? 'The previous attempt STALLED — no agent activity for 5 minutes and the supervisor killed it (likely a hung command or a blocking wait). Avoid long blocking sleeps; poll with short sleeps instead. '
      : '';
    pushProgress(s, 'error', `第 ${s.attempt} 次尝试未返回有效配置，准备重试`);
    setTimeout(() => {
      if (!s.cancelled && s.status === 'running') runAttempt(s, `${stallNote}${issueFeedback}The previous attempt exited with code ${code} and its final output was not a valid JSON config. Last output:\n${tail}`);
    }, 1500);
  } else {
    s.status = 'failed';
    s.error = `Agent 未能生成有效的启动配置（已尝试 ${s.attempt} 次）。${issueFeedback ? `校验问题：${issueFeedback.replace(/\n/g, ' ').slice(0, 300)} ` : ''}最后输出: ${stdout.trim().slice(-400) || lastProgressTail(s, 400) || 'empty'}`;
    pushProgress(s, 'error', s.error);
    persistResult(s);
  }
}

// ============================= public engine API =============================

export function startAnalysis(
  path: string,
  name: string,
  usedPorts: number[],
  maxAttempts: number,
  llmBaseUrl: string,
): AnalysisSession {
  const rt0 = engineRuntime();
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
    llmBaseUrl,
  };
  rt0.sessions.set(id, s);
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
      setTimeout(() => { void killProjectOrphans(s, '卡死清扫'); }, 2500).unref?.();
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
      setTimeout(() => { void killProjectOrphans(s, '会话超时清扫'); }, 2500).unref?.();
      s.status = 'failed';
      s.error = 'Session timed out';
      persistResult(s);
    }
    setTimeout(() => {
      engineRuntime().sessions.delete(id);
      deleteResultFile(id); // keep disk in sync with the in-memory store
    }, 60 * 60 * 1000);
  }, 60 * 60 * 1000).unref?.();

  return s;
}

export function getSession(id: string): AnalysisSession | undefined {
  return engineRuntime().sessions.get(id);
}

export function listSessions(): AnalysisSession[] {
  return Array.from(engineRuntime().sessions.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export function cancelSession(id: string): AnalysisSession | undefined {
  const s = engineRuntime().sessions.get(id);
  if (!s) return undefined;
  s.cancelled = true;
  killTree(s.child?.pid);
  setTimeout(() => killProjectOrphans(s, '取消清扫'), 2500).unref?.();
  if (s.status === 'running') {
    s.status = 'cancelled';
    persistResult(s);
  }
  return s;
}

export function engineHealth() {
  const rt0 = engineRuntime();
  return {
    status: 'ok',
    dsh: existsSync(DSH_BIN),
    sessions: rt0.sessions.size,
    inProcess: true,
  };
}

/** View shape consumed by the dashboard wizard — identical to the old service. */
export function sessionView(s: AnalysisSession) {
  const rt0 = engineRuntime();
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
    const active = rt0.activeRunId !== null;
    const pos = rt0.runQueue.indexOf(s.id);
    if (pos !== -1) {
      view.queuePosition = pos + (active ? 1 : 0);
      view.queueLength = rt0.runQueue.length + (active ? 1 : 0);
    } else if (rt0.activeRunId === s.id) {
      view.queuePosition = 0;
      view.queueLength = rt0.runQueue.length + 1;
    }
  }
  return view;
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
    console.error('[harness] persistResult failed:', err?.message || err);
  }
}

function deleteResultFile(sessionId: string) {
  try { unlinkSync(join(RESULTS_DIR, `${sessionId}.json`)); } catch { /* absent is fine */ }
}

/**
 * Rebuild lightweight terminal sessions from RESULTS_DIR so the dashboard
 * wizard keeps getting answers (instead of 404) after a server restart.
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
        if (!/^[a-f0-9-]{8,}$/.test(id) || engineRuntime().sessions.has(id)) continue;
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
          llmBaseUrl: '',
        };
        engineRuntime().sessions.set(id, s);
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
    console.log(`[harness] disk cleanup: removed ${logs} old attempt log(s), ${dshSessions} old dsh session dir(s) (TTL 7d)`);
  } catch { /* never fatal */ }
}

// ============================= gateway base URL resolution =============================

/**
 * Resolve the loopback base URL of this dashboard's LLM gateway, used by the
 * dsh child process. Candidates: the request's own origin (covers custom
 * ports) and the standard 127.0.0.1:3000. Each is probed against
 * /api/llm/v1/models and must answer an OpenAI-style JSON list. The winner
 * is cached for the process lifetime.
 */
export async function resolveGatewayBaseUrl(requestOrigin?: string): Promise<string> {
  const rt0 = engineRuntime();
  if (rt0.gatewayBaseUrl) return rt0.gatewayBaseUrl;

  const candidates: string[] = [];
  for (const p of GATEWAY_FALLBACK_PORTS) candidates.push(`http://127.0.0.1:${p}`);
  if (requestOrigin && !candidates.includes(requestOrigin.replace(/\/$/, ''))) {
    candidates.push(requestOrigin.replace(/\/$/, ''));
  }

  for (const base of candidates) {
    try {
      const res = await fetch(`${base}/api/llm/v1/models`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) continue;
      const data: any = await res.json().catch(() => null);
      if (data && data.object === 'list' && Array.isArray(data.data)) {
        rt0.gatewayBaseUrl = base;
        console.log(`[harness] llm gateway base URL resolved: ${base}/api/llm/v1`);
        return base;
      }
    } catch { /* probe next candidate */ }
  }
  throw new Error(
    `LLM gateway unreachable — tried ${candidates.join(', ')} (dashboard must be running on this machine)`,
  );
}

// ============================= boot-time init =============================

/**
 * One-time engine init: restore terminal sessions, schedule artifact
 * cleanup, register shutdown handlers that kill running dsh children.
 * Called from instrumentation.register() and defensively from every route.
 */
export function ensureEngine(): void {
  const rt0 = engineRuntime();
  if (rt0.initialized) return;
  rt0.initialized = true;
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  } catch { /* best-effort */ }
  try {
    const restoredCount = restoreSessionsFromDisk();
    console.log(`[harness] restored ${restoredCount} finished session(s) from ${RESULTS_DIR}`);
  } catch { /* ignore */ }
  runArtifactCleanup();
  const artifactCleanupTimer = setInterval(runArtifactCleanup, 3600_000);
  artifactCleanupTimer.unref?.();
  // Don't leave dsh runs + project servers behind when the server stops.
  process.on('SIGTERM', () => { cleanupAllSessions(); process.exit(0); });
  process.on('SIGINT', () => { cleanupAllSessions(); process.exit(0); });
  console.log(`[harness] in-process engine ready (dsh available: ${existsSync(DSH_BIN)})`);
}

export function dshAvailable(): boolean {
  return existsSync(DSH_BIN);
}

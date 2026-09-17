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
import { isAllowedCommand } from '@/lib/cmd-allowlist';
import { isUnsafeAnalysisPath, isSelfOrAncestorPath, SELF_PROJECT_PATH } from '@/lib/self-guard';

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
const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000; // per dsh run — a Windows cold "next dev" compile alone takes 2-4 min
const STALL_KILL_MS = 6 * 60 * 1000; // no activity at all → kill (cmd hard-cap 3 min + slow LLM think)
/** Stall grace BEFORE the attempt's first sign of life. dsh writes NOTHING
 *  while its first LLM call is in flight (the session log only records
 *  completed tool calls/turns), so a cold-start model call on a busy backend
 *  legitimately looks "silent" for minutes — killing it at the normal stall
 *  deadline is how attempt 2 of the cryoflow run died having produced zero
 *  events. The dsh patch bounds the hang itself (streamIdleTimeoutMs +
 *  1 retry ≈ ≤5.3 min), so this grace only ever buys startup slack. */
const FIRST_STALL_KILL_MS = 8 * 60 * 1000;
/** LLM gateway pre-check (before each attempt spawn): one tiny completion. */
const LLM_PRECHECK_TIMEOUT_MS = 45_000;
/** Total time the pre-check waits for an unresponsive gateway before giving up and spawning anyway. */
const LLM_PRECHECK_WAIT_MS = 3 * 60 * 1000;
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
  /** True when the stall kill happened before ANY sign of life — the retry
   *  feedback then names the unresponsive LLM backend instead of loops. */
  stalledNoEvent: boolean;
  /** True once the CURRENT attempt produced any sign of life (stdout/stderr
   *  bytes or session-log growth). Drives the longer first-response stall
   *  grace — dsh is legitimately silent while its first LLM call is in flight. */
  attemptAlive: boolean;
  /** The dsh session-log file currently being tailed. Identity switch — NOT
   *  size tracking — is what moves the counters between attempts (see
   *  pollDshLog): a dead attempt's big file must never shadow or re-emit as
   *  the next attempt's smaller file. */
  logTailFile: string | null;
  /** Warn-once flag for the 2-minute inactivity note. */
  stalledNote: boolean;
  /** True for lightweight sessions rebuilt from RESULTS_DIR after a restart. */
  restored?: boolean;
  /** Wall-clock time the session reached a terminal state (persisted). */
  finishedAt?: number;
  /** LLM gateway base URL the dsh patch points at (resolved per analysis). */
  llmBaseUrl: string;
  /** Dashboard project id this analysis is associated with. When set, the
   *  engine auto-applies the verified result to that project server-side the
   *  moment the session completes — closing the wizard before clicking
   *  "save" can no longer lose the result. */
  projectId?: string;
  /** Server-side auto-apply outcome: {pending:true} while running, or the
   *  terminal result ({ok, applied, envs, …}). Undefined until it starts. */
  applyOutcome?: any;
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

/** Map dsh session events to friendly progress items (idempotent per size).
 *
 *  FILE-IDENTITY SWITCH: each dsh run writes a NEW session file. The tail
 *  counters (lastLogSize/lastEventLine) belong to the FILE, not the session —
 *  they reset only when pollDshLog sees a DIFFERENT file. The old
 *  reset-at-attempt-entry scheme had two fatal interactions with the retry
 *  window (sweep/pre-check delay before the next dsh creates its file):
 *    (a) the poller re-read the DEAD attempt's file with zeroed counters —
 *        re-emitting its whole history tagged with the NEW attempt number;
 *    (b) that read raised lastLogSize to the dead file's size, so the new
 *        attempt's smaller file was skipped (size <= lastLogSize) until it
 *        grew past it — retries looked "event-less" and a live agent could
 *        be stall-killed as silent (the observed zero-event attempt). */
function pollDshLog(s: AnalysisSession) {
  const file = findSessionLogFile(s.path, s.createdAt);
  if (!file) return;
  if (file !== s.logTailFile) {
    // New dsh run detected — tail the new file from its beginning.
    s.logTailFile = file;
    s.lastLogSize = 0;
    s.lastEventLine = 0;
  }
  {
    let size = 0;
    try { size = statSync(file).size; } catch { return; }
    if (size <= s.lastLogSize && size !== 0) return;
    s.lastLogSize = size;
    s.lastActivityAt = Date.now(); // log file grew → the agent is alive
    s.attemptAlive = true; // current attempt produced output
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
  // Hard boundaries the agent must respect: the dashboard process that is
  // RUNNING this very analysis, and the directory it lives in. Without this
  // the agent's pre-flight cleanup reads the dashboard's own .next/dev/lock
  // and kills the dashboard server (the "service stopped during analysis" bug).
  const selfGuardRules = `
- ABSOLUTE SAFETY BOUNDARY — the dashboard that is running you right now:
  - The dashboard server is PID ${process.pid} (this very analysis is one of its child tasks). NEVER kill PID ${process.pid}, any of its parent processes, or ANY process whose working directory or command line is inside "${SELF_PROJECT_PATH}" — a path that differs only in casing or through a symlink is the SAME directory on disk; resolve it before comparing.
  - That includes the .next/dev/lock you may find under "${SELF_PROJECT_PATH}" — it holds the LIVE dashboard server's PID. Do NOT read, kill, or delete anything there; just pick a different port for the server you are testing.
  - NEVER kill a process just because it occupies your chosen port unless that process clearly belongs to the project you are analyzing. When in doubt, move to the next free port.
`;
  return `You are a DevOps agent. Analyze the project in the current working directory and produce a VERIFIED startup configuration.

Steps you MUST complete:
1. Inspect the project files (package.json, bun.lock, config files, README) to understand the stack, scripts, and how it starts. Also note the tech stack (framework + language + key libraries) — you will use it to write the "description" field.
2. If dependencies are missing or incomplete, install them with the project's own package manager (bun install / npm install / pip install -r requirements.txt / go mod download etc). Installs often exceed the 3-minute command cap: run them DETACHED from your shell (run_in_background:true and poll with job_output, or "nohup ... > install.log 2>&1 &" / Start-Process with redirected logs) and check progress with short commands.
3. Choose a "dev" startup command and a free port. NEVER use port 3000 (reserved for the dashboard itself) and NEVER use ports 3100-3105 (reserved for the mesh agent service)${s.usedPorts.length > 0 ? ` and never use these already-assigned ports: ${usedPorts}` : ''}.
4. PRE-FLIGHT CLEANUP before starting any server: if the project has a .next/dev/lock file, a dev server for this project is (or was) already running — read the file, get the owning PID (JSON field "pid"), KILL that process tree first (Windows: taskkill /PID <pid> /T /F, otherwise kill -9 <pid>) and only THEN delete the lock file. NEVER delete .next/dev/lock while its process is still alive: two dev servers sharing one .next directory deadlock and every HTTP request then hangs forever. EXCEPTION: if the lock file is under "${SELF_PROJECT_PATH}" it belongs to the dashboard you are running inside — do NOT read, kill, or delete anything there, just pick a different port. Also verify the port you chose is actually free.
5. VERIFY the dev startup command ACTUALLY WORKS: start it DETACHED from your shell (Windows: Start-Process with -RedirectStandardOutput/-RedirectStandardError to log files; Unix: run_in_background:true or "nohup ... &"), then check readiness with ONE SHORT COMMAND PER CHECK — NEVER a while/for loop, NEVER one command that runs longer than 60 seconds. Windows PowerShell check (the -TimeoutSec 5 is MANDATORY — a compiling Next.js dev server accepts the TCP connection but never answers, and an unguarded Invoke-WebRequest hangs FOREVER): (try { (Invoke-WebRequest -Uri 'http://127.0.0.1:<PORT>/' -UseBasicParsing -TimeoutSec 5).StatusCode } catch { 'not-ready' }). Unix check: curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:<PORT>/. Between checks sleep in a SEPARATE short command (Start-Sleep -Seconds 15 / sleep 15). On Windows the FIRST compile of "next dev" regularly takes 2-4 minutes — keep checking every ~15s for up to ~6 minutes total; TCP connects but HTTP hangs means compilation is in progress: KEEP POLLING, do NOT restart the server, do NOT touch .next/dev/lock. If the server is still not ready after 4-5 checks, read the TAIL of the redirected dev-server log (Get-Content <log> -Tail 40 / tail -n 40) — an in-progress compile shows progress lines, a real failure shows the error. NEVER start a production build (next build / npm run build / bun run build) to diagnose or "pre-verify" a slow dev server: builds take minutes, burn the whole budget, and tell you nothing the dev log doesn't.
6. If it fails, DEBUG: read the error output, fix the problem (install missing packages, adjust the command or the port, fix trivial config issues), and retry. Keep iterating until the service successfully responds on its port.
7. Determine the PRODUCTION startup — ONLY AFTER the dev verification passed: check package.json (or equivalent) for build/start scripts. If they exist, run the production build ONCE in the BACKGROUND (Windows: Start-Process with redirected logs; Unix: "npm run build > build.log 2>&1 &") and poll the log/process with short commands — a foreground build hits the 3-minute command cap and is killed. Budget ~3 minutes of polling; if it still has not finished, stop it and use a best-guess production entry, mentioning the failure in "summary". If it finishes, verify the production start command (e.g. npm run start) on a DIFFERENT port (dev port + 1 unless taken) using the same one-short-check-per-command pattern. If the production start fails, debug briefly (max 2 fix attempts — install missing deps, fix trivial issues); if it still fails, still include a best-guess production entry (build && start with a distinct port) and mention the failure in "summary". If you already spent more than ~6 minutes in total, SKIP the production build entirely and return the best-guess production entry instead. If the project has NO build script at all, use the dev command with NODE_ENV=production on a distinct port as the production entry.
8. STOP every process you started (kill them all) so all ports are free again.
9. Finally, reply with ONLY a JSON object (no markdown fences, no extra text):
{"projectName":"...","description":"2-3 short sentences describing what this project IS and does: its purpose, the tech stack (framework/language/key libraries), and how it runs. Plain text, no markdown.","repoUrl":"the https:// URL of the git remote origin (run: git remote get-url origin) converted to https form, or "" if there is no remote — never include tokens","icon":"one of folder,globe,code,database,smartphone,shopping-cart,layout,palette,cpu,book-open,music,gamepad-2,bar-chart,shield,camera,map,cloud,terminal,rocket,puzzle,package,zap,laptop,atom,flame,server","summary":"what you did, problems found and fixed, production verification result","environments":[{"name":"dev","cmd":"the verified command","port":NUMBER,"envVars":{"KEY":"value"}},{"name":"production","cmd":"the production command (build && start when possible)","port":NUMBER,"envVars":{"NODE_ENV":"production","KEY":"value"}}]}

Rules:
- BUDGET DISCIPLINE (a supervisor kills runs that go silent): keep exploration MINIMAL — read package.json and the main entry file(s), at most ~8 files total. NEVER read node_modules, lockfiles, test files, or docs. Aim for ≤ 35 tool calls overall.${selfGuardRules}- Time budget: overall target ≤ 8 minutes (hard supervisor timeout 10). On Windows allow up to ~6 minutes of short readiness checks for the first "next dev" compile (2-4 minutes is NORMAL). If you are running out of budget, STOP exploring and return your best current valid JSON immediately — a partially verified config is far better than a timeout.
- CONTEXT HYGIENE (a supervisor also kills you when your LLM calls take too long, and every oversized tool result makes EVERY later call slower): when reading ANY log file ALWAYS tail it (Windows: Get-Content <log> -Tail 40; Unix: tail -n 40 <log>) — NEVER cat / Get-Content a whole log, a lockfile, or anything that could be large. An agent that swallowed a full build log made every following LLM call take minutes and died mid-call.
- SPAWN VISIBILITY: when starting any background process (dev server, install, build) always pass ABSOLUTE paths for BOTH the executable and any node_modules binary — Windows example: Start-Process -FilePath "node.exe" -ArgumentList "D:\\absolute\\project\\node_modules\\next\\dist\\bin\\next","dev","-p","<PORT>". Relative paths (node_modules\\next\\dist\\bin\\next) make the process INVISIBLE to the supervisor's cleanup sweep, so it survives this run, corrupts .next, and breaks every retry after you.
- If a port you chose is occupied, either kill the occupying process (ONLY if it clearly belongs to the project you are analyzing) or move to the next free port. NEVER kill the process on port 3000 or anything under "${SELF_PROJECT_PATH}". Do NOT retry the same port in a loop.
- A supervisor KILLS the whole attempt after 6 minutes of total silence, and the executor hard-caps every foreground command at 3 minutes: keep EVERY foreground command under 60 seconds — readiness checks and sleeps are always separate short commands. Long work (installs, builds, dev servers) runs detached/background (run_in_background:true, nohup &, Start-Process) and is polled with short commands or job_output. NEVER wrap an HTTP readiness check in a while loop and never call Invoke-WebRequest without -TimeoutSec — a compiling Next.js server accepts TCP but never answers, and the unguarded call hangs forever.
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
        # Bound hung upstream streams. Default is 5 MINUTES of silence before
        # dsh itself gives up — one dead LLM call could legally out-sit the
        # supervisor's stall watchdog (6 min) while the agent produces zero
        # events (the cryoflow attempt-2 death: killed mid first-LLM-call).
        # 2.5 min + the single retry below ≈ ≤5.3 min worst-case silence,
        # under the stall kill; streaming + gateway keepalives keep slow
        # but LIVE generations from tripping this.
        streamIdleTimeoutMs: 150000
        # Fail fast (one retry, short backoff) instead of dsh's default 5
        # retries: a hung or rate-limited call then surfaces as a loud agent
        # error the engine can retry at the ATTEMPT level, instead of silent
        # multi-minute stalls.
        retryPolicy:
          mode: normal
          maxRetries: 1
          backoff:
            initialDelayMs: 2000
            maxDelayMs: 15000
            jitterRatio: 0.2
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
    timeoutMs: 120000
    maxTimeoutMs: 180000

# Windows twin of bash-sandbox (bash-sandbox is disabled on win32 and
# vice versa — patching both keeps one patch platform-neutral).
- id: pwsh-sandbox
  config:
    timeoutMs: 120000
    maxTimeoutMs: 180000

# A job_output(wait:true) call is silent from the supervisor's point of view
# — without this cap the model can legally block for 10 minutes on one call
# and get stall-killed for it.
- id: tool-jobs
  config:
    waitTimeoutMs: 30000
    maxWaitTimeoutMs: 45000

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
    if (platform() === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else spawn('sh', ['-c', `kill -TERM -${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null; sleep 1; kill -KILL -${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null`]);
  } catch { /* best effort */ }
}

/** PowerShell zombie sweep for Windows (see sweepWindowsOrphans). ASCII-only
 *  on purpose: PowerShell 5.1 reads BOM-less .ps1 files as the system codepage. */
const SWEEP_PS1 = `param(
  [string]$ProjPath,
  [string]$ExcludePids = '',
  [long]$SinceMs = 0
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
# Kill project-owned processes by command line alone. The previous
# LISTEN-port filter let a first-boot dev server (compiling for minutes
# before it ever listens) survive the sweep while the lock file below was
# still deleted — the next attempt then shared .next with the zombie and
# every request hung forever. Command-line match + executable-name filter
# already spares editors' language servers (their argv carries extension
# paths, not the project directory).
$victims = @{}
$names = @{}
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='bun.exe' OR Name='npm.exe' OR Name='next.exe'"
foreach ($p in $procs) {
  $v = [int]$p.ProcessId
  if ($excl.ContainsKey($v)) { continue }
  if (-not (Test-CmdlineMatch $p.CommandLine)) { continue }
  $victims[$v] = $true
  $names[$v] = [string]$p.Name
}
# ---- class 3: orphans of THIS analysis run ----
# Relative-path spawns (Start-Process -ArgumentList "node_modules\\next\\dist\\bin\\next","build")
# carry no project path in their command line, so the path match above cannot
# see them — and they escape the engine's tree kill because Start-Process
# detaches them from the dsh process tree once the spawning pwsh exits (it
# runs one command per invocation). A leftover "next build" then races every
# later attempt's .next forever (the cryoflow cascade).
# SAFE discriminator, all three must hold:
#   - created AFTER the analysis session started (CreationDate gate), and
#   - node/bun/npm/next executable with a framework-CLI marker in the
#     command line (next / node_modules / npx), and
#   - the parent chain hits a DEAD pid within 3 hops. Anything started from
#     a live terminal roots at live processes (explorer/WindowsTerminal/ssh)
#     and is spared; the dashboard's own workers root at a live excluded
#     pid and are spared. PID reuse turns a kill into a miss (chain walks
#     into a live process) — the safe direction.
if ($SinceMs -gt 0) {
  $since = $null
  try { $since = [DateTimeOffset]::FromUnixTimeMilliseconds($SinceMs).LocalDateTime } catch {}
  if ($since) {
    $all = @(Get-CimInstance Win32_Process)
    $byId = @{}
    foreach ($q in $all) { $byId[[int]$q.ProcessId] = $q }
    foreach ($q in $all) {
      if ($q.Name -ne 'node.exe' -and $q.Name -ne 'bun.exe' -and $q.Name -ne 'npm.exe' -and $q.Name -ne 'next.exe') { continue }
      $v = [int]$q.ProcessId
      if ($excl.ContainsKey($v)) { continue }
      if ($victims.ContainsKey($v)) { continue }
      if (-not $q.CreationDate -or $q.CreationDate -lt $since) { continue }
      $cl = [string]$q.CommandLine
      if (-not $cl) { continue }
      if ($cl.IndexOf('next', [System.StringComparison]::OrdinalIgnoreCase) -lt 0 -and $cl.IndexOf('node_modules', [System.StringComparison]::OrdinalIgnoreCase) -lt 0 -and $cl.IndexOf('npx', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
      $cur = $q
      $hops = 0
      $orphan = $false
      while ($hops -lt 3) {
        $hops++
        $pp = [int]$cur.ParentProcessId
        if ($pp -le 0) { break }
        if ($excl.ContainsKey($pp) -and $byId.ContainsKey($pp)) { break }
        $parent = $byId[$pp]
        if (-not $parent) { $orphan = $true; break }
        $cur = $parent
      }
      if ($orphan) {
        $victims[$v] = $true
        $names[$v] = [string]$q.Name + ' (orphaned by analysis)'
      }
    }
  }
}
# Next.js dev lock: JSON {"pid":...} of a dev server for this project. Kill the
# lock owner REGARDLESS of listening state — that process owns .next; letting
# it live across attempts is exactly how zombie dev servers accumulate.
$lock = Join-Path $proj '.next\\dev\\lock'
$lockPid = $null
if (Test-Path $lock) {
  try { $j = Get-Content $lock -Raw | ConvertFrom-Json; if ($j -and $j.pid) { $lockPid = [int]$j.pid } } catch {}
  if ($lockPid -and -not $excl.ContainsKey($lockPid) -and -not $victims.ContainsKey($lockPid)) {
    $lp = Get-CimInstance Win32_Process -Filter "ProcessId=$lockPid"
    if ($lp -and $lp.Name -match '^(node|bun|next|npm|cmd|powershell|pwsh)\\.exe$') {
      $victims[$lockPid] = $true
      $names[$lockPid] = "$($lp.Name) (next dev lock)"
    }
  }
}
foreach ($v in @($victims.Keys)) {
  Write-Output ("KILL " + $v + " " + $names[$v])
  & taskkill /PID $v /T /f 2>$null | Out-Null
}
Start-Sleep -Milliseconds 800
# Delete the lock ONLY when its owner is really gone. A surviving owner plus
# a deleted lock is exactly how two dev servers end up sharing one .next and
# deadlocking every HTTP request.
if (Test-Path $lock) {
  $alive = $false
  if ($lockPid) { if (Get-Process -Id $lockPid -ErrorAction SilentlyContinue) { $alive = $true } }
  if (-not $alive) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }
}
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
      // kill the dashboard server / its node_modules workers). Canonicalized
      // compare — see self-guard.ts (case/symlink-hardened).
      if (isSelfOrAncestorPath(s.path) || myCwd === s.path || myCwd.startsWith(s.path + '/')) { resolve(0); return; }
      // NEVER kill the CURRENT attempt's dsh: it spawns with cwd = project
      // path, so a cwd-matching sweep fired around an attempt transition
      // would SIGTERM the brand-new dsh of the NEXT attempt (found live in
      // E2E: attempts 2/3 died instantly with no session and no output —
      // the previous attempt's delayed exit sweep had shot them).
      const ownPid = s.child?.pid;
      const victims: number[] = [];
      for (const ent of readdirSync('/proc')) {
        if (!/^\d+$/.test(ent)) continue;
        const pid = Number(ent);
        if (pid === process.pid || pid === ownPid) continue;
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
  // path.resolve OUTSIDE the promise executor: the executor parameter used to
  // shadow it, so `resolve(s.path)` resolved the PROMISE and left projPath
  // undefined — the function then threw immediately and the catch swallowed
  // it, making the ENTIRE Windows sweep a silent no-op (orphan dev servers
  // and builds survived every attempt; the cryoflow cascade).
  const projPath = resolve(s.path);
  return new Promise((resolve) => {
    try {
      const norm = (p: string) => p.toLowerCase().replace(/\\/g, '/');
      const nProj = norm(projPath);
      const nMine = norm(process.cwd());
      // Safety: never sweep the dashboard's own directory tree (either
      // direction) — canonicalized predicate for case/symlink safety.
      if (isSelfOrAncestorPath(s.path) || !nProj || nProj === nMine || nMine.startsWith(nProj + '/') || nProj.startsWith(nMine + '/')) {
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
        // Session start gate for the class-3 orphan detection: only processes
        // CREATED during this analysis may be killed as run-orphans.
        '-SinceMs', String(s.createdAt),
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, 15_000);
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
function cleanupAllSessions(): number {
  const rt0 = engineRuntime();
  let killed = 0;
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
      killed++;
    }
  }
  return killed;
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
    // stripShellPrologue (shared lib cmd-allowlist) also accepts the
    // `unset PORT &&` / `export VAR=… &&` guards the agent emits, so verified
    // configs are no longer flagged/dropped for carrying a shell prologue.
    if (!isAllowedCommand(cmd)) {
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

/** Probe the LLM gateway with a tiny completion before burning an attempt.
 *
 * dsh is completely silent while an LLM call is in flight (its session log
 * only records completed tool calls/turns), so an unresponsive backend turns
 * a whole attempt into 6-8 minutes of nothing — the cryoflow attempt-2 death
 * (killed having produced ZERO events). Pinging first costs one cheap
 * completion on a healthy backend and converts "spawn into a dead provider"
 * into a bounded, VISIBLE wait. Never blocks forever: gives up after
 * LLM_PRECHECK_WAIT_MS and spawns anyway (best effort). */
async function precheckLlmGateway(s: AnalysisSession, attemptNo: number): Promise<void> {
  const url = `${s.llmBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const probe = async (): Promise<boolean> => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_KEY}` },
        body: JSON.stringify({
          model: 'glm-4-plus',
          messages: [{ role: 'user', content: 'gateway health probe' }],
          max_tokens: 8,
          stream: false,
        }),
        signal: AbortSignal.timeout(LLM_PRECHECK_TIMEOUT_MS),
      });
      return res.ok;
    } catch { return false; }
  };
  if (await probe()) return; // healthy → no delay
  pushProgress(s, 'note', `LLM 网关预检未通过 — 第 ${attemptNo} 次尝试暂缓，等待后端恢复（最多 ${Math.round(LLM_PRECHECK_WAIT_MS / 60000)} 分钟，期间可安全取消）`);
  const deadline = Date.now() + LLM_PRECHECK_WAIT_MS;
  while (Date.now() < deadline && !s.cancelled) {
    await new Promise((r) => setTimeout(r, 20_000));
    if (s.cancelled || s.status !== 'running') return;
    if (await probe()) {
      pushProgress(s, 'note', 'LLM 网关已恢复 — 继续启动');
      return;
    }
  }
  pushProgress(s, 'note', 'LLM 网关仍未恢复 — 仍将启动本次尝试（若持续无响应会被看门狗终止并重试）');
}

async function startAttempt(s: AnalysisSession, feedback?: string): Promise<void> {
  // A session cancelled while still queued must never spawn a run.
  if (s.cancelled) return;
  s.attempt += 1;
  // NOTE: lastLogSize/lastEventLine are deliberately NOT reset here — they
  // follow the dsh session FILE identity (see pollDshLog). Resetting them at
  // attempt entry while the next dsh hasn't created its file yet made the
  // poller re-emit the dead attempt's events under the new number and then
  // size-shadow the new attempt's smaller file (the zero-event retry bug).
  // The identity switch handles the transition the moment the new file exists.
  s.stalledNote = false;
  s.attemptAlive = false;
  s.stalledNoEvent = false;
  // Clear orphans from a previous attempt BEFORE spawning — awaited so the
  // retry truly starts with free ports (on Windows this runs taskkill on
  // leftover dev servers; a zombie holding .next/dev/lock or the port is
  // the #1 cause of retry failures and "port occupied" cascades).
  await killProjectOrphans(s, `第 ${s.attempt} 次尝试前清扫`);
  if (s.cancelled) return; // cancelled while the sweep was running
  // One cheap probe first: never spawn a fresh dsh into a dead LLM backend.
  await precheckLlmGateway(s, s.attempt);
  if (s.cancelled || s.status !== 'running') return;
  pushProgress(s, 'start', `第 ${s.attempt}/${s.maxAttempts} 次分析启动（deepseek-harness agent）`);
  // Stall clock starts HERE (after sweep + pre-check), not at attempt entry.
  s.lastActivityAt = Date.now();

  const task = buildTask(s, feedback);
  const logFile = join(LOG_DIR, `${s.id}-attempt${s.attempt}.log`);
  const patchFile = writeTaskPatch(s.llmBaseUrl, join(LOG_DIR, `${s.id}-attempt${s.attempt}.yml`));
  s.logFile = logFile;

  const child = spawn('node', [DSH_BIN, '--profile', 'headless', '--patch', patchFile, task], {
    cwd: s.path,
    env: (() => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DSH_HOME,
        ZAI_GATEWAY_KEY: GATEWAY_KEY,
        DSH_TELEMETRY_DISABLED: '1',
        DSH_PERMISSION_MODE: 'danger-full-access',
      } as NodeJS.ProcessEnv;
      // The Next.js dev server mutates process.env AT RUNTIME (PORT=<dev port>
      // for its build workers, TURBOPACK=1, …). Passing those through hijacks
      // analyzed projects that read process.env.PORT onto the dashboard's own
      // port — the agent then "fixes" it with `unset PORT && …` command
      // prefixes, which the apply-analysis allowlist used to reject, losing
      // the whole verified result. Sever the leak chain at the source (same
      // class of fix as the start.bat TURBOPACK guard).
      delete env.PORT;
      delete env.TURBOPACK;
      return env;
    })(),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Process-group leader: killTree(-PGID) then reliably reaps dsh AND every
    // job it spawned (npm/node servers), instead of just the dsh process.
    detached: true,
    // The dsh agent runs headless — never flash a console window.
    windowsHide: true,
  });
  s.child = child;

  let stdout = '';
  child.stdout!.on('data', (c: Buffer) => {
    stdout += c.toString();
    s.lastActivityAt = Date.now();
    s.attemptAlive = true; // dsh printed something — the run is alive
    try { appendFileSync(logFile, c); } catch {}
  });
  child.stderr!.on('data', (c: Buffer) => {
    s.lastActivityAt = Date.now();
    s.attemptAlive = true;
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
  // Exit sweep — scheduled ONLY on the terminal branches below. The retry
  // branch must NOT schedule one: the next dsh spawns ~1.5-4s later with
  // cwd = project path, and a cwd-matching sweep fired around that moment
  // SIGTERMs the brand-new attempt (found live in E2E: attempts 2/3 died
  // instantly, no session, no output). The retry path re-sweeps inside
  // startAttempt BEFORE spawning, which is the race-free place for it.
  const exitSweep = () =>
    setTimeout(() => { void killProjectOrphans(s, '会话收尾校验'); }, 2000).unref?.();
  if (s.cancelled) {
    s.status = 'cancelled';
    pushProgress(s, 'error', '已取消');
    persistResult(s);
    exitSweep();
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
      // Server-side auto-apply: persist the result to the associated project
      // immediately — the wizard's "save" button becomes optional.
      if (s.projectId) {
        s.applyOutcome = { pending: true };
        persistResult(s);
        void autoApplyResult(s);
        exitSweep();
        return;
      }
      persistResult(s);
      exitSweep();
      return;
    }
    // Parsed, but sanitization dropped every environment — retry with the
    // concrete validation problems instead of a generic "invalid output".
    issueFeedback = `The returned JSON was structurally valid but failed validation and every environment was discarded. Fix these problems:\n${issues.map(i => `- ${i}`).join('\n')}\n`;
  }
  if (s.attempt < s.maxAttempts) {
    const tail = stdout.trim().slice(-600) || lastProgressTail(s, 600) || '(no output)';
    const stallNote = s.stalledAttempt === s.attempt
      ? (s.stalledNoEvent
        ? 'The previous attempt produced NO output at all — it never received its first LLM response (the backend was unresponsive) and the supervisor killed it. The gateway has been re-checked before this attempt. Keep your exploration minimal and, if calls feel slow, return your best-guess valid JSON earlier rather than later. '
        : 'The previous attempt STALLED — no agent activity for 6 minutes and the supervisor killed it (likely a hung command, an oversized tool result, or an unguarded network call). Never wrap a readiness check in a while-loop and never run one foreground command longer than 60 seconds; poll with separate short commands instead. Also NEVER read whole log files — oversized tool results make every later LLM call take minutes and the agent dies mid-call. ')
      : '';
    // Facts from the dead attempts — ACCUMULATED across ALL prior attempts,
    // not just the last one: a no-event attempt (killed waiting for its first
    // LLM response) has an empty progress list, and feeding ONLY that to the
    // retry threw away everything attempt 1 learned — the next attempt then
    // re-read package.json/.env and re-checked ports (the cryoflow attempt-3
    // behavior). Tag each fact with its attempt so the model can tell stale
    // from fresh.
    const facts = s.progress
      .filter((p) => p.attempt < s.attempt && (p.kind === 'command' || p.kind === 'file' || p.kind === 'note'))
      .slice(-45)
      .map((p) => `- [attempt ${p.attempt}] ${p.text.replace(/\s+/g, ' ').slice(0, 110)}`)
      .join('\n');
    const factsBlock = facts
      ? `\nFACTS earlier attempts already established (trust them, do NOT re-read these files or re-run these checks — continue from where they stopped):\n${facts}\nProcesses from earlier attempts have been swept by the supervisor, but VERIFY your chosen port is free with ONE short command before starting a server.\n`
      : '';
    pushProgress(s, 'error', `第 ${s.attempt} 次尝试未返回有效配置，准备重试`);
    setTimeout(() => {
      if (!s.cancelled && s.status === 'running') runAttempt(s, `${stallNote}${issueFeedback}The previous attempt exited with code ${code} and its final output was not a valid JSON config.${factsBlock}Last output:\n${tail}`);
    }, 1500);
  } else {
    s.status = 'failed';
    const lastNoEvent = s.stalledAttempt === s.attempt && s.stalledNoEvent
      ? `第 ${s.attempt} 次尝试自始至终没有任何输出（LLM 后端无响应，看门狗终止）。请检查 LLM 网关/Provider 可用性后重试。 `
      : '';
    s.error = `Agent 未能生成有效的启动配置（已尝试 ${s.attempt} 次）。${lastNoEvent}${issueFeedback ? `校验问题：${issueFeedback.replace(/\n/g, ' ').slice(0, 300)} ` : ''}最后输出: ${stdout.trim().slice(-400) || lastProgressTail(s, 400) || 'empty'}`;
    pushProgress(s, 'error', s.error);
    persistResult(s);
    exitSweep();
  }
}

// ============================= server-side auto-apply =============================

/**
 * Fire-and-forget: apply a completed session's result to its project through
 * the shared apply-analysis lib (the SAME code path as the wizard's manual
 * "save" button). Dynamic import keeps Prisma out of the engine's
 * module-evaluation path; failures are recorded on the session (and
 * persisted) so the wizard can fall back to the manual save button.
 */
async function autoApplyResult(s: AnalysisSession): Promise<void> {
  try {
    if (!s.projectId || s.status !== 'completed' || !s.result) return;
    const { applyAnalysisToProject } = await import('@/lib/apply-analysis');
    const outcome = await applyAnalysisToProject(s.projectId, s.result);
    s.applyOutcome = {
      ok: outcome.ok,
      status: outcome.status,
      applied: outcome.applied,
      dropped: outcome.dropped,
      suggestedName: outcome.suggestedName,
      summary: outcome.summary,
      envs: outcome.envs,
      error: outcome.error,
    };
    pushProgress(
      s,
      outcome.ok ? 'result' : 'error',
      outcome.ok
        ? `已自动保存 ${outcome.applied} 个环境配置到项目（关闭或刷新不会丢失）`
        : `自动保存失败：${outcome.error || outcome.status} — 可在向导中手动保存`,
    );
    persistResult(s);
  } catch (err: any) {
    s.applyOutcome = { ok: false, status: 'error', error: String(err?.message || err) };
    try { persistResult(s); } catch { /* ignore */ }
  }
}

// ============================= public engine API =============================

export function startAnalysis(
  path: string,
  name: string,
  usedPorts: number[],
  maxAttempts: number,
  llmBaseUrl: string,
  projectId?: string,
): AnalysisSession {
  // Hard backstop — the API layer already rejects these paths, but the
  // engine is the component that actually spawns an unrestricted shell agent
  // into the directory. Never let it run against the dashboard itself (or an
  // ancestor like the home dir, or an inside-tree dir whose walk-up lands on
  // the dashboard's package.json): the agent's pre-flight cleanup would read
  // our own .next/dev/lock and kill the live dashboard server.
  if (isUnsafeAnalysisPath(path)) {
    throw new Error(
      `Refusing to analyze "${path}": it contains the dashboard itself. ` +
      `The analysis agent would stop the dashboard's own dev server via the ` +
      `.next/dev/lock pre-flight kill.`,
    );
  }
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
    stalledNoEvent: false,
    attemptAlive: false,
    // Pre-own any session file a PREVIOUS analysis of this path left behind
    // (findSessionLogFile's 60s mtime window can still match it) so the
    // poller never adopts it as this session's — only files created AFTER
    // this point (our own dsh runs) trigger the identity switch.
    logTailFile: findSessionLogFile(path, Date.now()),
    stalledNote: false,
    llmBaseUrl,
    projectId: projectId || undefined,
  };
  rt0.sessions.set(id, s);
  pushProgress(s, 'note', `项目: ${name} (${path})`);
  runAttempt(s);

  // Live progress poller — tails the dsh session event log, and doubles as
  // the stall supervisor: an agent with no log growth, no stdout and no
  // progress events for 6 minutes is considered hung. EXCEPTION: before the
  // attempt's FIRST sign of life the deadline is 8 minutes — dsh is
  // legitimately silent while its first LLM call is in flight (the session
  // log only records completed tool calls/turns), so a cold backend must not
  // be misjudged as a stuck agent (the cryoflow attempt-2 death).
  s.poller = setInterval(() => {
    if (s.status !== 'running') {
      clearInterval(s.poller);
      return;
    }
    try { if (s.child) pollDshLog(s); } catch { /* ignore — no dsh running means nothing to tail; the pre-check pushes its own notes */ }
    const idleMs = Date.now() - s.lastActivityAt;
    const stallLimit = s.attemptAlive ? STALL_KILL_MS : FIRST_STALL_KILL_MS;
    if (s.child && idleMs > stallLimit) {
      s.stalledAttempt = s.attempt;
      s.stalledNoEvent = !s.attemptAlive;
      pushProgress(s, 'error', s.attemptAlive
        ? `Agent 已 ${Math.round(STALL_KILL_MS / 60000)} 分钟无任何活动，判定卡死，终止本次尝试`
        : `Agent 启动后 ${Math.round(FIRST_STALL_KILL_MS / 60000)} 分钟内没有任何输出（LLM 后端无响应），终止本次尝试`);
      killTree(s.child.pid);
      setTimeout(() => { void killProjectOrphans(s, '卡死清扫'); }, 2500).unref?.();
    } else if (s.child && idleMs > 120_000) {
      if (!s.stalledNote) {
        s.stalledNote = true;
        pushProgress(s, 'note', s.attemptAlive
          ? '（两分钟无新事件 — agent 可能正在执行安装/构建等耗时命令，继续等待）'
          : '（尚无任何输出 — agent 正在等待 LLM 首次响应，继续等待）');
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
  // Server-side auto-apply state for the wizard: registered sessions expose
  // {pending} until the outcome lands (undefined = not registered → the
  // wizard falls back to its manual save buttons).
  if (s.projectId) view.applied = s.applyOutcome ?? { pending: true };
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
    if (s.projectId) payload.projectId = s.projectId;
    if (s.applyOutcome !== undefined) payload.applied = s.applyOutcome;
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
          stalledNoEvent: false,
          attemptAlive: false,
          logTailFile: null,
          stalledNote: false,
          restored: true,
          llmBaseUrl: '',
          projectId: data.projectId ? String(data.projectId) : undefined,
          applyOutcome: data.applied,
        };
        engineRuntime().sessions.set(id, s);
        restored += 1;
        // A completed session that never got its result applied (the server
        // died mid-apply) → retry the server-side auto-apply now.
        if (s.projectId && s.status === 'completed' && s.result && !(s.applyOutcome as any)?.ok) {
          s.applyOutcome = { pending: true };
          void autoApplyResult(s);
        }
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
  // LOUD shutdown: the dashboard used to die SILENTLY on any stray SIGTERM
  // (process managers, port sweeps, shell cleanup) — the dev log just ended
  // mid-line with no explanation, which made "server died right after X"
  // reports undiagnosable. Always say WHY we are going down, and what we
  // cleaned up, before exiting.
  const shutdown = (signal: string) => {
    let cleaned = 0;
    try {
      cleaned = cleanupAllSessions();
    } catch { /* best-effort */ }
    try {
      console.error(`[harness] ${signal} received — shutting down dashboard server (killed ${cleaned} tracked child process group(s)). If you did NOT stop the server yourself, find the sender: check taskkill/pkill history, the mesh agent lifecycle (stopAgentOnPort), and any port-sweep scripts.`);
    } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (e) => {
    console.error('[harness] uncaughtException — dashboard server crashing:', e);
    try { cleanupAllSessions(); } catch { /* best-effort */ }
    process.exit(70);
  });
  process.on('unhandledRejection', (e) => {
    console.error('[harness] unhandledRejection (not fatal):', e);
  });
  console.log(`[harness] in-process engine ready (dsh available: ${existsSync(DSH_BIN)})`);
}

export function dshAvailable(): boolean {
  return existsSync(DSH_BIN);
}

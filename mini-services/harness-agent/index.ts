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
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, appendFileSync } from 'fs';
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
const MAX_ATTEMPTS = 3;
const LOG_DIR = join(tmpdir(), 'harness-agent-logs');
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

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
    if (!Array.isArray(obj.environments) || obj.environments.length === 0) return null;
    const dev = obj.environments.find((e: any) => e && e.cmd && Number(e.port) > 0);
    if (!dev) return null;
    return obj;
  } catch { return null; }
}

// ============================= run orchestration =============================

/** Serialize dsh runs — the LLM backend rate-limits concurrent agents hard. */
let runChain: Promise<void> = Promise.resolve();
function enqueueRun(fn: () => void): Promise<void> {
  const next = runChain.then(fn, fn);
  runChain = next.catch(() => {});
  return next;
}

function runAttempt(s: AnalysisSession, feedback?: string) {
  // Serialize across sessions — one dsh agent at a time (LLM rate limits).
  enqueueRun(() => startAttempt(s, feedback));
}

function startAttempt(s: AnalysisSession, feedback?: string) {
  s.attempt += 1;
  s.lastLogSize = 0;
  s.lastEventLine = 0;
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
  });
  s.child = child;

  let stdout = '';
  child.stdout!.on('data', (c: Buffer) => {
    stdout += c.toString();
    try { appendFileSync(logFile, c); } catch {}
  });
  child.stderr!.on('data', (c: Buffer) => {
    try { appendFileSync(logFile, c); } catch {}
    const line = c.toString().trim();
    if (line && !line.startsWith('dsh: ')) pushProgress(s, 'note', line.slice(0, 140));
  });

  const timeout = setTimeout(() => {
    pushProgress(s, 'error', '本次尝试超时，正在终止…');
    killTree(child.pid);
  }, ATTEMPT_TIMEOUT_MS);

  child.on('exit', (code) => {
    clearTimeout(timeout);
    s.child = null;
    if (s.cancelled) {
      s.status = 'cancelled';
      pushProgress(s, 'error', '已取消');
      return;
    }
    pollDshLog(s);
    const config = parseConfigJson(stdout);
    if (config) {
      s.result = {
        ...config,
        attempts: s.attempt,
        verified: true,
        finishedAt: Date.now(),
      };
      s.status = 'completed';
      pushProgress(s, 'result', `分析成功（${s.attempt} 次尝试）：${config.environments?.length ?? 0} 个环境配置已生成并验证`);
      return;
    }
    if (s.attempt < s.maxAttempts) {
      const tail = stdout.trim().slice(-600) || '(no output)';
      pushProgress(s, 'error', `第 ${s.attempt} 次尝试未返回有效配置，准备重试`);
      setTimeout(() => {
        if (!s.cancelled && s.status === 'running') runAttempt(s, `The previous attempt exited with code ${code} and its final output was not a valid JSON config. Last output:\n${tail}`);
      }, 1500);
    } else {
      s.status = 'failed';
      s.error = `Agent 未能生成有效的启动配置（已尝试 ${s.attempt} 次）。最后输出: ${stdout.trim().slice(-400) || 'empty'}`;
      pushProgress(s, 'error', s.error);
    }
  });
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
  };
  sessions.set(id, s);
  pushProgress(s, 'note', `项目: ${name} (${path})`);
  runAttempt(s);

  // Live progress poller — tails the dsh session event log.
  s.poller = setInterval(() => {
    if (s.status !== 'running') {
      clearInterval(s.poller);
      return;
    }
    try { pollDshLog(s); } catch { /* ignore */ }
  }, 2500);

  // Session GC after 1 hour.
  setTimeout(() => {
    if (s.status === 'running') {
      killTree(s.child?.pid);
      s.status = 'failed';
      s.error = 'Session timed out';
    }
    setTimeout(() => sessions.delete(id), 60 * 60 * 1000);
  }, 60 * 60 * 1000).unref?.();

  return s;
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
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function sessionView(s: AnalysisSession) {
  return {
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
        if (s.status === 'running') s.status = 'cancelled';
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
        send();
        const timer = setInterval(send, 2000);
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[harness-agent] listening on http://0.0.0.0:${PORT}`);
  console.log(`[harness-agent] dsh available: ${existsSync(DSH_BIN)}`);
});

/**
 * LLM repair AGENT — tool-dispatcher loop.
 *
 * Redesigned after the "blind diagnosis" incident: the old engine asked the
 * LLM for a one-shot fix plan from a stack trace alone, so the model guessed
 * (claimed files that existed were missing, suggested builds that deadlocked
 * on the dev-server lock, …). The new engine turns the LLM into a dispatcher:
 *
 *   ┌─ loop (max job.maxRounds steps) ──────────────────────────────┐
 *   │ LLM replies ONE JSON action → system executes the matching    │
 *   │ tool (inspect / probe / test / patch / update_env /           │
 *   │ run_retry / finish) → result is fed back as the next message  │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * Every claim the LLM makes can now be grounded in a tool result, and
 * run_retry verifies health by polling the port (not just the spawn result).
 *
 * Robustness layer (LLMs emit broken JSON more often than we'd like):
 *   - extractJson() already strips fences / repairs trailing commas
 *   - on parse failure the agent sends a corrective message and retries
 *     the same turn (up to 3 attempts), keeping the bad reply in context
 *   - replies that validate as the LEGACY one-shot plan format are executed
 *     through a fallback path (commands + config + retry) instead of failing
 *   - two consecutive unparseable turns abort the job cleanly
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, isAbsolute, relative, dirname } from 'path';
import { db } from '@/lib/db';
import { startProcess, stopProcess, checkPortStatus, getLogs } from '@/lib/process-manager';
import { callLLM, extractJson, type LlmMessage } from '@/lib/llm-providers';
// Canonical safety + exec primitives (tools/safety.ts, tools/exec.ts) —
// command classification, child-env sanitization and the hardened
// process-group runner all live there. No duplicate copies here.
import { classifyRepairCommand, isStartCmdSafe, buildChildEnv } from './llm-repair/tools/safety';
import { execTool, runShellProcess } from './llm-repair/tools/exec';
import { inspectTool } from './llm-repair/tools/inspect';
import { probeTool } from './llm-repair/tools/probe';
import type { RepairJob, RepairStep, RepairKind, StartRepairOptions } from './llm-repair';

const execp = promisify(exec);

// ============================= public surface =============================

export interface AgentHelpers {
  /** Append a step to the job log (rendered live in the repair dialog). */
  log: (level: RepairStep['level'], msg: string) => void;
  /** Pause for human approval of a dangerous command. */
  requestApproval: (cmd: string) => Promise<boolean>;
}

export interface AgentOutcome {
  status: 'success' | 'failed';
  error?: string;
}

const TOOL_NAMES = ['inspect', 'probe', 'test', 'patch', 'update_env', 'run_retry', 'finish'] as const;
type ToolName = (typeof TOOL_NAMES)[number];

type ParsedTurn =
  | { kind: 'tool'; thought: string; action: ToolName; args: Record<string, any> }
  | { kind: 'legacy'; plan: any };

interface EnvSnapshot {
  projectId: string;
  envId: string;
  projectName: string;
  envName: string;
  projectPath: string;
  cmd: string;
  port: number;
  envVars: Record<string, string>;
  status: string;
  kind: RepairKind;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ============================= shell runner =============================
// runShellProcess (spawn detached + whole-process-group kill on timeout)
// is imported from ./llm-repair/tools/exec — the single hardened runner.

// ============================= text helpers =============================

/** Keep the tail of a blob (defaults to 400 chars) — for logs/errors. */
function tail(text: string, max = 400): string {
  if (!text) return '';
  const t = text.trim();
  return t.length > max ? t.slice(-max) : t;
}

/** Keep head + tail with an ellipsis marker — for tool results where the
 *  beginning (file headers) and end (log tails) both matter. */
function headTail(text: string, max = 2200): string {
  if (!text) return '';
  const t = text.replace(/\r\n/g, '\n').trim();
  if (t.length <= max) return t;
  const headLen = Math.min(600, Math.floor(max * 0.35));
  const tailLen = max - headLen;
  return `${t.slice(0, headLen)}\n…(middle truncated, ${t.length} chars total)…\n${t.slice(-tailLen)}`;
}

// ============================= port / process probing =============================

export interface PortFacts {
  port: number;
  listening: boolean;
  /** Raw lsof/ss output showing the owning process, when listening. */
  detail: string;
  http: boolean;
  httpStatus?: number;
  httpErr?: string;
}

async function lsofLines(port: number): Promise<string> {
  try {
    const { stdout } = await execp(`lsof -iTCP:${port} -sTCP:LISTEN -n -P 2>/dev/null`, { timeout: 8000 });
    const s = (stdout || '').trim();
    if (s) return s.slice(0, 800);
  } catch { /* fall through to ss */ }
  try {
    const { stdout } = await execp(`ss -tlnp 2>/dev/null | grep ':${port} '`, { timeout: 8000 });
    if ((stdout || '').trim()) return `ss: ${stdout.trim().slice(0, 800)}`;
  } catch { /* not listening, or no tools */ }
  return '';
}

async function httpCheck(port: number, path: string, timeoutMs = 2500): Promise<{ ok: boolean; status?: number; err?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
      headers: { 'User-Agent': 'dashboard-repair-probe/1.0' },
    });
    // ANY HTTP response (even 4xx/5xx) proves a server is speaking HTTP.
    return { ok: true, status: res.status };
  } catch (e: any) {
    const code = e?.cause?.code || e?.code || e?.message || String(e);
    return { ok: false, err: String(code).slice(0, 120) };
  }
}

/** Probe a port: listening state, owning process, and a quick HTTP check. */
export async function probePort(port: number, doHttp = true): Promise<PortFacts> {
  const detail = await lsofLines(port);
  let http = false;
  let httpStatus: number | undefined;
  let httpErr: string | undefined;
  if (doHttp) {
    const r1 = await httpCheck(port, '/');
    if (r1.ok) {
      http = true;
      httpStatus = r1.status;
    } else {
      const r2 = await httpCheck(port, '/health');
      if (r2.ok) {
        http = true;
        httpStatus = r2.status;
      } else {
        httpErr = r2.err || r1.err;
      }
    }
  }
  const listening = !!detail || http || (await checkPortStatus(port));
  return { port, listening, detail, http, httpStatus, httpErr };
}

/** Poll a port until it listens (server boot grace) or the budget runs out. */
async function waitForPort(port: number, totalMs: number): Promise<PortFacts> {
  const deadline = Date.now() + totalMs;
  let facts = await probePort(port, false);
  while (!facts.listening && Date.now() < deadline) {
    await sleep(1000);
    facts = await probePort(port, false);
  }
  if (facts.listening) {
    const r1 = await httpCheck(port, '/');
    const r2 = r1.ok ? r1 : await httpCheck(port, '/health');
    return { ...facts, http: r2.ok, httpStatus: r2.status, httpErr: r2.ok ? undefined : r2.err || r1.err };
  }
  return facts;
}

/** `ps aux` lines whose command line contains `pattern` (filtered in JS — no
 *  shell injection through the pattern). */
async function psGrep(pattern: string, maxLines = 15): Promise<string[]> {
  const p = String(pattern || '').trim();
  if (!p || p.length > 200) return [];
  try {
    const { stdout } = await execp('ps aux', { timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
    const lower = p.toLowerCase();
    return stdout
      .split('\n')
      .filter((l) => l.toLowerCase().includes(lower))
      .slice(0, maxLines)
      .map((l) => l.slice(0, 200));
  } catch {
    return [];
  }
}

async function listeningLines(): Promise<string> {
  try {
    const { stdout } = await execp('ss -tlnp 2>/dev/null', { timeout: 8000, maxBuffer: 2 * 1024 * 1024 });
    return stdout
      .split('\n')
      .filter((l) => l.trim() && l.trim() !== 'State')
      .slice(0, 45)
      .map((l) => l.slice(0, 140))
      .join('\n');
  } catch {
    return '';
  }
}

// ============================= path safety =============================

/** Resolve `p` (absolute or project-relative) and enforce it stays inside the
 *  project root — blocks `..`, absolute escapes, and symlink escapes. */
function safeResolve(root: string, p: string): string | null {
  const raw = String(p || '').trim();
  if (!raw || raw.length > 500) return null;
  let abs: string;
  try {
    abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  } catch {
    return null;
  }
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    // The project root itself is fine for list/find, not for read/patch —
    // callers handle that; here we only reject escapes.
    if (abs !== resolve(root)) return null;
  }
  return abs;
}

function isBinary(buf: Buffer): boolean {
  return buf.slice(0, 8192).includes(0);
}

// ============================= file helpers =============================

function readPackageJsonSummary(projectPath: string): string {
  try {
    const p = join(projectPath, 'package.json');
    if (!existsSync(p)) return '(no package.json)';
    const pj = JSON.parse(readFileSync(p, 'utf8'));
    return JSON.stringify(
      {
        name: pj.name,
        packageManager: pj.packageManager,
        scripts: pj.scripts,
        dependencies: pj.dependencies ? Object.keys(pj.dependencies) : [],
        devDependencies: pj.devDependencies ? Object.keys(pj.devDependencies) : [],
      },
      null,
      1,
    ).slice(0, 3000);
  } catch {
    return '(package.json unreadable)';
  }
}

function readTopLevelFiles(projectPath: string): string {
  try {
    // Include dotfiles (.next, .env, …) — build/lock state matters for
    // diagnosis; only .git is noise.
    return readdirSync(projectPath)
      .filter((f) => f !== '.git')
      .slice(0, 60)
      .join(', ');
  } catch {
    return '(unreadable)';
  }
}

function listDirQuick(abs: string, max = 60): string {
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.name !== '.git')
      .slice(0, max)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join(', ');
  } catch {
    return '(unreadable)';
  }
}

// ============================= env snapshot =============================

async function loadEnvSnapshot(job: RepairJob): Promise<EnvSnapshot | null> {
  const env = await db.environment.findUnique({
    where: { id: job.envId },
    include: { project: true },
  });
  if (!env || !env.project || env.projectId !== job.projectId) return null;
  let envVars: Record<string, string> = {};
  try {
    envVars = JSON.parse(env.envVars);
  } catch {
    envVars = {};
  }
  return {
    projectId: job.projectId,
    envId: job.envId,
    projectName: env.project.name,
    envName: env.name,
    projectPath: env.project.path,
    cmd: env.cmd,
    port: env.port,
    envVars,
    status: env.status,
    kind: job.kind,
  };
}

// ============================= prompt =============================

function agentSystemPrompt(kind: RepairKind): string {
  const retryDesc =
    kind === 'rebuild'
      ? 'runs the production build (npm run build), then restarts the process and VERIFIES health by polling the port; returns the outcome plus fresh logs'
      : 'restarts the process and VERIFIES health by polling the port; returns the outcome plus fresh logs';
  return `You are a senior DevOps repair agent. You are repairing a project environment that failed to start or build. You work in a TOOL LOOP: every turn you reply with exactly ONE JSON action; the system executes it and sends you the result as the next user message. Keep acting until the environment is verifiably healthy, or the problem is proven unfixable.

Reply format — ONLY this JSON object, no markdown fences, no prose:
{"thought":"简短中文说明（展示给用户）","action":"<tool>","<tool arguments>": ...}

Available actions:
- {"action":"inspect","path":"relative/path","mode":"read|list|find","pattern":"server.js","tail":false}
    read: file content (head or tail 4000 chars; binary detected; secret files like .env/*.key/*.db are refused). list: directory entries (dotfiles included). find: recursive search by name substring (node_modules/.git skipped).
- {"action":"probe","port":4000,"ps":"node","listen":true}
    port: LISTENING? which pid/command owns it? quick HTTP check on / and /health. ps: process search — the query may only contain letters/digits/dot/dash/underscore (a single word like "node" or "server.js"). listen: all listening TCP ports with owning processes. You may combine several fields in one call.
- {"action":"test","cmd":"shell command","timeoutSec":20}
    Runs a short diagnostic command in the project directory (cwd = project root). Returns exit code + stdout/stderr tails. Non-zero exit is DATA, not a failure of the loop.
- {"action":"patch","file":"relative/path","search":"exact existing text","replace":"replacement","all":false}
    Precise in-place text patch. "search" must occur exactly once unless all:true. Prefer patch over sed.
- {"action":"update_env","cmd":"new start command","port":4001,"envVars":{"K":"v"}}
    Updates the environment configuration (any subset of fields).
- {"action":"run_retry"}
    ${retryDesc}. This is the ONLY way to actually (re)start the service — always call it to verify a fix.
- {"action":"finish","reason":"...","giveUp":true}
    Ends the repair. giveUp:true ONLY when the problem genuinely cannot be fixed automatically.

Non-negotiable rules:
1. VERIFY BEFORE YOU ASSERT. Never claim a file exists or is missing without inspect. Never claim a process is or is not running without probe. Never claim a command works without test. A wrong guess wastes a whole repair step.
2. The failure report you were given can be WRONG or stale — e.g. "start failed" while the service actually runs fine (started outside the dashboard, port already serving). When the error mentions a port or is unclear, probe that port FIRST.
3. NEVER run \`npm run build\` / \`next build\` while a dev server may be holding the build directory: first inspect .next/dev/lock and probe for dev-server processes. Building with a held lock DEADLOCKS (hangs for minutes with zero output). If a build under \`test\` times out, suspect exactly this deadlock.
4. Transient build-time warnings (symlink notices, deprecation notes) are usually NOT the root cause. Follow the actual error text.
5. Be minimal: prefer one precise patch or update_env over broad commands. After changing anything, call run_retry to verify, and iterate on its feedback (it returns fresh logs).
6. If the server listens on a different port than configured: probe with "listen":true, update_env the correct port, then run_retry.
7. Destructive commands (rm -rf …) go through a human approval gate — propose them ONLY when genuinely necessary. Never use sudo or cd.
8. Never use or suggest port 3000 — it is the dashboard's own port.
9. Exactly one action per reply. JSON only, no fences. "thought" is shown to the user — keep it one short Chinese sentence.`;
}

/** Cheap facts gathered before the first LLM turn so its first decision is
 *  grounded: port state, processes mentioning the project path, build locks,
 *  fresh logs. Directly answers the "phantom failure" class of incidents. */
async function preflight(snap: EnvSnapshot): Promise<string> {
  const lines: string[] = [];
  const pf = await probePort(snap.port);
  const firstDetail = pf.detail ? ` — owner: ${pf.detail.split('\n')[0].slice(0, 160)}` : '';
  lines.push(
    `- port ${snap.port}: ${pf.listening ? 'LISTENING' : 'not listening'}${firstDetail}` +
      (pf.http ? `; HTTP responds (status ${pf.httpStatus}) — a server IS running` : pf.listening ? `; no HTTP response (${pf.httpErr || 'connection failed'})` : ''),
  );
  const psLines = await psGrep(snap.projectPath, 12);
  lines.push(`- processes whose command line mentions the project path: ${psLines.length ? `\n  ${psLines.join('\n  ')}` : '(none)'}`);
  const nextDir = join(snap.projectPath, '.next');
  if (existsSync(nextDir)) {
    const lock = existsSync(join(nextDir, 'dev', 'lock'));
    lines.push(`- .next/ exists; .next/dev/lock present: ${lock ? 'YES — a dev server holds the build directory; DO NOT run npm run build' : 'no'}`);
  }
  const logs = getLogs(snap.projectId, snap.envName).slice(-15);
  if (logs.length) lines.push(`- last 15 process log lines:\n  ${logs.map((l) => l.slice(0, 200)).join('\n  ')}`);
  return lines.join('\n');
}

function buildContextMessage(snap: EnvSnapshot, opts: StartRepairOptions, pre: string, job: RepairJob): string {
  const { kind } = snap;
  return `A project environment failed and needs repair. Investigate with the tools, fix it, and verify with run_retry.

Project: ${snap.projectName} (at ${snap.projectPath})
Environment: ${snap.envName} (port ${snap.port})
Current start command: ${snap.cmd}
Current envVars: ${JSON.stringify(snap.envVars)}
Failure kind: ${kind === 'rebuild' ? 'production rebuild failed' : 'start command failed'}

=== ERROR REPORTED BY THE DASHBOARD ===
${opts.initialError || '(none)'}

${kind === 'rebuild' && opts.buildStderr ? `=== BUILD STDERR (tail) ===\n${tail(opts.buildStderr, 2500)}\n` : ''}=== RECENT PROCESS LOGS (tail) ===
${(() => {
    const logs = getLogs(snap.projectId, snap.envName).slice(-50);
    return logs.length ? logs.join('\n').slice(0, 4000) : '(no logs)';
  })()}

=== package.json (summary) ===
${readPackageJsonSummary(snap.projectPath)}

=== Top-level files (dotfiles included) ===
${readTopLevelFiles(snap.projectPath)}

=== PRE-FLIGHT FACTS (gathered by the system just now) ===
${pre}

You have ${job.maxRounds} tool steps in total. Begin with your first action.`;
}

// ============================= action parsing (robust layer) =============================

export function parseAgentAction(text: string): { ok: true; value: ParsedTurn } | { ok: false; err: string } {
  const obj = extractJson(text);
  if (obj == null) return { ok: false, err: 'no JSON object found in the reply' };
  if (typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, err: 'reply is JSON but not an object' };

  const nameRaw = obj.action ?? obj.tool ?? obj.name ?? obj.command;
  if (typeof nameRaw !== 'string' || !nameRaw.trim()) {
    // Older/looser models may answer with the legacy one-shot plan format —
    // execute it through the fallback path instead of burning a retry.
    if ('diagnosis' in obj || 'commands' in obj || 'giveUp' in obj) {
      return { ok: true, value: { kind: 'legacy', plan: obj } };
    }
    return { ok: false, err: `missing "action" field. Valid actions: ${TOOL_NAMES.join(', ')}` };
  }
  const action = String(nameRaw).trim().toLowerCase() as ToolName;
  if (!TOOL_NAMES.includes(action)) {
    return { ok: false, err: `unknown action "${action}". Valid actions: ${TOOL_NAMES.join(', ')}` };
  }
  const err = validateArgs(action, obj);
  if (err) return { ok: false, err };
  return {
    ok: true,
    value: {
      kind: 'tool',
      thought: typeof obj.thought === 'string' ? obj.thought : '',
      action,
      args: obj as Record<string, any>,
    },
  };
}

function validateArgs(action: ToolName, o: any): string | null {
  switch (action) {
    case 'inspect':
      if (typeof o.path !== 'string' || !o.path.trim()) return 'inspect requires "path" (string, relative to the project directory)';
      if (o.mode != null && !['read', 'list', 'find'].includes(o.mode)) return 'inspect "mode" must be one of "read" | "list" | "find"';
      if ((o.mode === 'find' || (o.pattern != null && !o.mode)) && (typeof o.pattern !== 'string' || !o.pattern.trim())) return 'inspect find mode requires "pattern" (substring matched against file/dir names)';
      return null;
    case 'probe':
      if (o.port == null && !o.ps && o.listen !== true) return 'probe requires at least one of: "port" (number), "ps" (string), "listen" (true)';
      return null;
    case 'test':
      if (typeof o.cmd !== 'string' || !o.cmd.trim()) return 'test requires "cmd" (shell command string, cwd is the project directory)';
      return null;
    case 'patch':
      if (typeof o.file !== 'string' || !o.file.trim()) return 'patch requires "file" (relative path)';
      if (typeof o.search !== 'string' || !o.search) return 'patch requires non-empty "search" (the exact text to find)';
      if (typeof o.replace !== 'string') return 'patch requires "replace" (may be an empty string to delete the text)';
      return null;
    case 'update_env':
      if (o.cmd == null && o.port == null && o.envVars == null) return 'update_env requires at least one of: "cmd", "port", "envVars"';
      return null;
    case 'run_retry':
      return null;
    case 'finish':
      if (typeof o.reason !== 'string' || !o.reason.trim()) return 'finish requires "reason" (why you are ending the repair)';
      return null;
  }
}

// ============================= tools =============================

function toolInspect(args: Record<string, any>, snap: EnvSnapshot): Promise<string> {
  const rawPath = String(args.path || '').trim() || '.';
  const mode = args.pattern && !args.mode ? 'find' : String(args.mode || 'read');
  const root = snap.projectPath;

  // find delegates to the committed inspect primitive (basename substring,
  // skips node_modules/.git, prunes symlink loops).
  if (mode === 'find') {
    const pattern = String(args.pattern ?? args.glob ?? '').trim();
    if (!pattern) return Promise.resolve('ERROR: find mode requires "pattern" (substring matched against file/dir names).');
    return inspectTool({ action: 'find', path: rawPath, pattern, max: 60 }, root).then((r) => {
      if (!r.ok) return `ERROR: ${r.error}`;
      const d = r.data as { count: number; matches: { path: string; name: string }[] };
      const rels = d.matches.map((m) => relative(root, m.path) || m.name);
      return rels.length
        ? `found ${rels.length} match(es) for "${pattern}" (node_modules/.git are skipped from the search):
${rels.join('\n')}`
        : `no matches for "${pattern}" (node_modules/.git are skipped from the search)`;
    });
  }

  if (mode === 'list') {
    return inspectTool({ action: 'ls', path: rawPath, max: 200 }, root).then((r) => {
      if (!r.ok) {
        // Not found / not a directory — offer the parent listing as a hint.
        const parent = dirname(resolve(root, rawPath));
        const hint = parent.startsWith(resolve(root)) ? `\nParent directory contains: ${listDirQuick(parent)}` : '';
        return `ERROR: ${r.error}${hint}`;
      }
      const d = r.data as { entries: { name: string; type: string }[]; truncated: boolean };
      return `# ${rawPath} (directory${d.truncated ? ', list truncated at 200 entries' : ''})\n${d.entries
        .map((e) => (e.type === 'dir' ? `${e.name}/` : e.name))
        .join(', ')}`;
    });
  }

  // read (mode "read") — cat via the committed primitive (refuses secret
  // files: .env, *.key, *.pem, *.db, …), then head/tail slice + binary check.
  return inspectTool({ action: 'cat', path: rawPath, max: 200_000 }, root).then((r) => {
    if (!r.ok) {
      const abs = resolve(root, rawPath);
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        return `Path is a DIRECTORY (use mode:"list" for entries). Entries: ${listDirQuick(abs)}`;
      }
      const parent = dirname(abs);
      const hint = parent.startsWith(resolve(root)) && existsSync(parent) ? `\nParent directory contains: ${listDirQuick(parent)}` : '';
      return `ERROR: ${r.error}${hint}`;
    }
    const d = r.data as { size: number; truncated: boolean; content: string };
    if (d.content.includes('\u0000')) return `# ${rawPath} — binary/non-UTF8 file (${d.size} bytes), cannot display as text.`;
    const tailMode = args.tail === true;
    const slice = tailMode ? d.content.slice(-4000) : d.content.slice(0, 4000);
    const marker = d.content.length > 4000 ? (tailMode ? ` (showing last 4000 of ${d.content.length} chars)` : ` (showing first 4000 of ${d.content.length} chars)`) : '';
    return `# ${rawPath} (${d.size} bytes${marker}${tailMode ? ', tail' : ''})\n${slice}`;
  });
}

async function toolProbe(args: Record<string, any>): Promise<string> {
  const sections: string[] = [];
  const portNum = Number(args.port);
  const hasPort = Number.isInteger(portNum) && portNum > 0 && portNum < 65536;
  const ps = typeof args.ps === 'string' ? args.ps.trim() : '';
  const listen = args.listen === true;
  if (!hasPort && !ps && !listen) return 'ERROR: probe requires at least one of "port" (number), "ps" (string), "listen" (true).';
  if (args.port != null && !hasPort) return `ERROR: "port" must be an integer, got: ${JSON.stringify(args.port)}`;

  if (hasPort) {
    // lsof via the committed probe primitive (machine-parsed owner info).
    const l = await probeTool({ action: 'lsof', port: portNum });
    const listening = l.ok && ((l.data as { entries: unknown[] }).entries?.length ?? 0) > 0;
    const lines = [`[port ${portNum}] ${listening ? 'LISTENING' : 'not listening'}`];
    if (l.ok) {
      const entries = (l.data as { entries: { pid: number; command: string; user?: string }[] }).entries;
      for (const e of entries.slice(0, 4)) {
        lines.push(`  owner: pid ${e.pid} (${e.command})${e.user ? ` user ${e.user}` : ''}`);
      }
    }
    const h1 = await httpCheck(portNum, '/');
    if (h1.ok) {
      lines.push(`HTTP probe /: OK (status ${h1.status}) — a server is responding on this port`);
    } else {
      const h2 = await httpCheck(portNum, '/health');
      if (h2.ok) lines.push(`HTTP probe /health: OK (status ${h2.status}) — a server is responding on this port`);
      else if (listening) lines.push(`HTTP probe: no response (${h2.err || h1.err || 'connection failed'}) — something binds the port but is not speaking HTTP (or is still booting)`);
    }
    sections.push(lines.join('\n'));
  }
  if (ps) {
    const r = await probeTool({ action: 'ps', query: ps });
    if (!r.ok) {
      sections.push(`[ps] ERROR: ${r.error}`);
    } else {
      const d = r.data as { count: number; processes: { pid: number; ppid: number; command: string }[] };
      sections.push(
        `[ps ~ "${ps}"]\n${d.count ? d.processes.map((p) => `  pid ${p.pid} (ppid ${p.ppid}) ${p.command.slice(0, 160)}`).join('\n') : '(no matching processes)'}`,
      );
    }
  }
  if (listen) {
    const raw = await listeningLines();
    sections.push(`[listening TCP ports]\n${raw || '(ss unavailable or nothing listening)'}`);
  }
  return sections.join('\n\n');
}

async function toolTest(args: Record<string, any>, snap: EnvSnapshot, helpers: AgentHelpers): Promise<string> {
  const cmd = String(args.cmd || '').trim();
  if (!cmd) return 'ERROR: test requires "cmd".';
  const timeoutSec = Math.max(3, Math.min(180, Number(args.timeoutSec) || 20));
  // Classification + execution both happen inside execTool (tools/exec.ts).
  // needsApproval is a structured envelope — THIS loop owns the human gate.
  let res = await execTool({ action: 'run', cmd, timeoutMs: timeoutSec * 1000 }, snap.projectPath);
  if (!res.ok) return `ERROR: ${res.error}`;
  if (res.needsApproval) {
    const why = `${res.reason}${res.detail ? ` (${res.detail})` : ''}`;
    helpers.log('approval', `$ ${cmd} — ${why}`);
    const approved = await helpers.requestApproval(cmd);
    if (!approved) {
      helpers.log('denied', cmd);
      return 'DENIED: the user declined to run this command. Choose a different approach.';
    }
    helpers.log('approved', cmd);
    const rerun = await execTool({ action: 'run', cmd, timeoutMs: timeoutSec * 1000, approved: true }, snap.projectPath);
    if (!rerun.ok) return `ERROR: ${rerun.error}`;
    res = rerun;
  }
  // Narrow the union: after the gate, an outcome must exist.
  if (res.needsApproval || !('outcome' in res)) {
    return 'ERROR: command still flagged after human approval — refusing to execute.';
  }
  helpers.log('command', `$ ${cmd}`);
  const o = res.outcome;
  const parts: string[] = [];
  if (o.kind === 'spawn-failed') {
    parts.push(`spawn failed: ${o.error}`);
    helpers.log('output', headTail(`[spawn failed] ${o.error}`, 320));
    return parts.join('\n');
  }
  const exitLabel = o.kind === 'timed-out' ? 'TIMEOUT' : String(o.exitCode);
  parts.push(
    `exit code: ${exitLabel}`,
    `duration: ${(o.durationMs / 1000).toFixed(1)}s${o.kind === 'timed-out' ? ' — TIMED OUT and the whole process group was killed; treat a long silent hang as a probable deadlock, not as success' : ''}`,
  );
  if (o.stdout.trim()) parts.push(`--- stdout ---\n${headTail(o.stdout, 1400)}`);
  if (o.stderr.trim()) parts.push(`--- stderr ---\n${headTail(o.stderr, 700)}`);
  helpers.log('output', headTail(`[exit ${exitLabel} ${(o.durationMs / 1000).toFixed(1)}s] ${tail(o.stdout || o.stderr || '', 220)}`, 320));
  return parts.join('\n');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

async function toolPatch(args: Record<string, any>, snap: EnvSnapshot): Promise<string> {
  const file = String(args.file || '').trim();
  const search = typeof args.search === 'string' ? args.search : '';
  const replace = typeof args.replace === 'string' ? args.replace : '';
  if (!file) return 'ERROR: patch requires "file".';
  if (!search) return 'ERROR: patch requires non-empty "search".';
  if (search.length > 2000) return 'ERROR: "search" too long (max 2000 chars).';
  if (replace.length > 4000) return 'ERROR: "replace" too long (max 4000 chars).';
  const abs = safeResolve(snap.projectPath, file);
  if (!abs) return 'ERROR: file must stay inside the project directory.';
  if (!existsSync(abs) || !statSync(abs).isFile()) return `ERROR: file does not exist: ${file} (use inspect to find the right path).`;
  const st = statSync(abs);
  if (st.size > 1024 * 1024) return `ERROR: file too large to patch (${st.size} bytes > 1MB).`;
  const buf = readFileSync(abs);
  if (isBinary(buf)) return 'ERROR: binary file — patch only works on text files.';
  const content = buf.toString('utf8');
  const count = countOccurrences(content, search);
  if (count === 0) return 'ERROR: "search" text not found in the file. Inspect the exact content and retry (copy the text verbatim).';
  if (count > 1 && args.all !== true) {
    return `ERROR: "search" text found ${count} times. Provide a longer/unique search string, or set "all": true to replace every occurrence.`;
  }
  const next = args.all === true ? content.split(search).join(replace) : content.replace(search, replace);
  writeFileSync(abs, next);
  return `patched ${file}: replaced ${args.all === true ? count : 1} occurrence(s)\n- search:  ${headTail(search, 150)}\n+ replace: ${headTail(replace, 150)}`;
}

async function toolUpdateEnv(args: Record<string, any>, snap: EnvSnapshot): Promise<string> {
  const fresh = await db.environment.findUnique({ where: { id: snap.envId } });
  if (!fresh) return 'ERROR: environment no longer exists.';
  const updates: Record<string, unknown> = {};
  const notes: string[] = [];

  if (args.cmd != null) {
    const cmd = String(args.cmd).trim();
    if (!cmd) return 'ERROR: "cmd" must be a non-empty string.';
    if (!isStartCmdSafe(cmd)) {
      return `ERROR: start command rejected by the safety gate: ${cmd.slice(0, 120)} (allowed: npm/npx/yarn/pnpm/bun/python/node/make/go/cargo/… no cd, no shell pipelines).`;
    }
    if (cmd !== fresh.cmd) {
      updates.cmd = cmd;
      notes.push(`cmd → ${cmd}`);
    }
  }
  if (args.port != null) {
    const port = Number(args.port);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return `ERROR: "port" must be an integer in 1..65535, got ${JSON.stringify(args.port)}.`;
    if (port === 3000) return 'ERROR: port 3000 is reserved for the dashboard itself.';
    if (port !== fresh.port) {
      updates.port = port;
      notes.push(`port: ${fresh.port} → ${port}`);
    }
  }
  if (args.envVars != null) {
    if (typeof args.envVars !== 'object' || Array.isArray(args.envVars)) return 'ERROR: "envVars" must be an object of string → string.';
    let cur: Record<string, string> = {};
    try {
      cur = JSON.parse(fresh.envVars);
    } catch {
      cur = {};
    }
    const merged: Record<string, string> = { ...cur };
    const keys: string[] = [];
    for (const [k, v] of Object.entries(args.envVars)) {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        return `ERROR: envVars[${JSON.stringify(k)}] must be a string (or number/boolean).`;
      }
      merged[k] = String(v);
      keys.push(k);
    }
    updates.envVars = JSON.stringify(merged);
    notes.push(`envVars set: ${keys.join(', ')}`);
  }
  if (notes.length === 0) return 'No changes applied — the provided values equal the current configuration.';
  await db.environment.update({ where: { id: snap.envId }, data: updates });
  return `environment updated: ${notes.join('; ')}`;
}

/** Restart + health-verified retry — the heart of the loop. Success is
 *  defined by the PORT actually listening (polled for up to 25s), not by
 *  startProcess() merely having spawned a child. */
async function toolRunRetry(
  job: RepairJob,
  log: AgentHelpers['log'],
  snap: EnvSnapshot,
): Promise<{ outcome: 'success' | 'failed'; message: string; error?: string }> {
  const fresh = await db.environment.findUnique({ where: { id: snap.envId }, include: { project: true } });
  if (!fresh || !fresh.project) return { outcome: 'failed', message: 'ERROR: environment disappeared — cannot retry.', error: 'environment disappeared' };
  let envVars: Record<string, string> = {};
  try {
    envVars = JSON.parse(fresh.envVars);
  } catch {
    envVars = {};
  }

  // 1. Maybe someone (the user, another job) already fixed it while we thought.
  if (fresh.status === 'running') {
    const pf = await probePort(fresh.port);
    if (pf.listening) {
      log('info', `环境已处于运行状态且端口 ${fresh.port} 健康 — 无需重启`);
      return {
        outcome: 'success',
        message: `The environment is already running and port ${fresh.port} is listening${pf.http ? ` (HTTP status ${pf.httpStatus})` : ''}. Nothing to do.`,
      };
    }
    log('warn', `数据库标记为运行中，但端口 ${fresh.port} 无监听 — 按故障继续处理`);
  }

  // 2. Orphaned occupant (previous dashboard session) — stop it instead of
  //    letting startProcess fail with "port in use" and the LLM "fix" that by
  //    forking a second instance on a new port.
  if (await checkPortStatus(fresh.port)) {
    log('info', `端口 ${fresh.port} 被占用，先停止旧进程…`);
    await stopProcess(job.projectId, fresh.name, fresh.port);
  }

  // 3. Rebuild jobs: build before start.
  if (job.kind === 'rebuild') {
    log('command', '$ npm run build');
    const r = await runShellProcess('npm run build', {
      cwd: fresh.project.path,
      timeoutMs: 300_000,
      env: buildChildEnv({ NODE_ENV: 'production' }),
    });
    if (tail(r.stdout, 300)) log('output', tail(r.stdout, 300));
    if (r.exitCode !== 0) {
      const detail = headTail(`exit ${String(r.exitCode)}\n${r.stderr || r.stdout || r.err || ''}`, 1600);
      log('error', `构建仍然失败: ${tail(r.stderr || r.stdout || r.err || '', 300)}`);
      return {
        outcome: 'failed',
        error: `build failed: ${tail(r.stderr || r.stdout || '', 400)}`,
        message: `BUILD FAILED (exit ${String(r.exitCode)}):\n${detail}\nFix the build error, then call run_retry again.`,
      };
    }
    log('success', '构建成功 — 准备重启');
  }

  // 4. Start.
  log('info', `重试启动: ${fresh.cmd} (port ${fresh.port})`);
  const result = await startProcess(job.projectId, fresh.name, fresh.cmd, fresh.project.path, envVars, fresh.port);
  if (!result.success) {
    const logs = getLogs(job.projectId, fresh.name).slice(-30).join('\n');
    return {
      outcome: 'failed',
      error: result.error || 'retry failed',
      message: `START FAILED: ${result.error}\nrecent process logs:\n${headTail(logs, 1200) || '(no logs)'}`,
    };
  }

  // 5. Wait for the port to actually listen (boot grace).
  const pf = await waitForPort(fresh.port, 25_000);
  if (pf.listening) {
    await db.environment.update({ where: { id: fresh.id }, data: { status: 'running', pid: result.pid ?? null } });
    log('success', `修复成功 — 环境已在端口 ${fresh.port} 上运行 (pid ${result.pid})${pf.http ? `，HTTP ${pf.httpStatus}` : ''}`);
    return {
      outcome: 'success',
      message: `RETRY SUCCEEDED: the process started and port ${fresh.port} is listening${pf.http ? ` (HTTP status ${pf.httpStatus})` : ''}.`,
    };
  }

  // 6. Spawned but never listened — clean up the zombie, feed logs back.
  await stopProcess(job.projectId, fresh.name, fresh.port);
  await db.environment.update({ where: { id: fresh.id }, data: { status: 'stopped', pid: null } });
  const logs = getLogs(job.projectId, fresh.name).slice(-40).join('\n');
  return {
    outcome: 'failed',
    error: 'started but the port never listened',
    message: `RETRY FAILED: the process was spawned (pid ${result.pid}) but port ${fresh.port} never became listening within 25s — the process was stopped again.\nrecent process logs:\n${headTail(logs, 1600) || '(no logs)'}\nHint: if the server actually listens on a DIFFERENT port, use probe with "listen":true to find it, then update_env the correct port and run_retry again.`,
  };
}

// ============================= legacy plan fallback =============================

/** Execute an old-style one-shot plan (commands + config + retry) — keeps
 *  weaker models that ignore the tool protocol useful instead of failing. */
async function execLegacyPlan(
  plan: any,
  job: RepairJob,
  helpers: AgentHelpers,
  snap: EnvSnapshot,
): Promise<{ outcome: 'success' | 'failed'; message: string }> {
  const { log, requestApproval } = helpers;
  log('warn', 'LLM 返回了旧版一次性 plan 格式 — 走兜底执行路径');
  const diagnosis = String(plan.diagnosis || '');
  if (diagnosis) {
    job.diagnosis = diagnosis.slice(0, 300);
    log('llm', `诊断: ${job.diagnosis}`);
  }
  if (plan.giveUp === true) {
    return { outcome: 'failed', message: `give up: ${diagnosis}` };
  }

  const commands: string[] = Array.isArray(plan.commands) ? plan.commands.slice(0, 6) : [];
  for (const raw of commands) {
    const c = String(raw || '').trim();
    if (!c) continue;
    if (!classifyRepairCommand(c).safe) {
      log('approval', c);
      const approved = await requestApproval(c);
      if (!approved) {
        log('denied', c);
        continue;
      }
      log('approved', c);
    }
    log('command', `$ ${c}`);
    const r = await runShellProcess(c, { cwd: snap.projectPath, timeoutMs: 240_000, env: buildChildEnv() });
    if (tail(r.stdout, 300)) log('output', tail(r.stdout, 300));
    if (tail(r.stderr, 300)) log('output', `[stderr] ${tail(r.stderr, 300)}`);
  }

  if (plan.cmd != null || plan.port != null || plan.envVars != null) {
    const r = await toolUpdateEnv(plan, snap);
    log(r.startsWith('ERROR') ? 'error' : 'info', headTail(r, 300));
  }

  const rr = await toolRunRetry(job, log, snap);
  return { outcome: rr.outcome, message: rr.message };
}

// ============================= main agent loop =============================

function inspectLabel(args: Record<string, any>): string {
  const mode = args.pattern && !args.mode ? 'find' : String(args.mode || 'read');
  return `${String(args.path || '')}${mode !== 'read' ? ` (${mode})` : ''}`;
}

function probeLabel(args: Record<string, any>): string {
  const parts: string[] = [];
  if (args.port != null) parts.push(`port ${args.port}`);
  if (args.ps) parts.push(`ps "${args.ps}"`);
  if (args.listen === true) parts.push('listen');
  return parts.join(' + ') || 'invalid';
}

export async function runAgentRepair(job: RepairJob, opts: StartRepairOptions, helpers: AgentHelpers): Promise<AgentOutcome> {
  const { log } = helpers;

  let snap = await loadEnvSnapshot(job);
  if (!snap) return { status: 'failed', error: 'Environment or project disappeared during repair' };
  job.projectName = snap.projectName;
  job.envName = snap.envName;

  const messages: LlmMessage[] = [
    { role: 'user', content: buildContextMessage(snap, opts, await preflight(snap), job) },
  ];

  let lastError = opts.initialError || 'unknown error';
  let parseFail = 0;
  let transportFail = 0;

  for (let step = 1; step <= job.maxRounds; step++) {
    job.round = step;

    // Refresh the snapshot every step — update_env may have changed it, and
    // someone outside may have fixed the env while we were thinking.
    snap = await loadEnvSnapshot(job);
    if (!snap) return { status: 'failed', error: 'Environment or project disappeared during repair' };
    if (snap.status === 'running') {
      const pf = await probePort(snap.port);
      if (pf.listening) {
        log('success', '环境已处于运行状态且端口健康（可能被手动修复）— 结束修复');
        return { status: 'success' };
      }
      log('warn', `数据库标记运行中但端口 ${snap.port} 无监听 — 继续修复`);
    }

    log('info', `第 ${step}/${job.maxRounds} 步：请求 LLM 下一步动作…`);

    // ---- LLM turn (+ corrective retries on unparseable output) ----
    let parsed: ParsedTurn | null = null;
    let transportErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        res = await callLLM({
          system: agentSystemPrompt(snap.kind),
          messages,
          temperature: 0.2,
          maxTokens: 1000,
        });
      } catch (e: any) {
        transportErr = String(e?.message || e);
        break;
      }
      const raw = res.text || '';
      messages.push({ role: 'assistant', content: raw });
      const r = parseAgentAction(raw);
      if (r.ok) {
        parsed = r.value;
        break;
      }
      log('warn', `LLM 输出无法解析（${r.err}）— 已要求其重新输出严格 JSON`);
      messages.push({
        role: 'user',
        content: `Your last reply could not be parsed: ${r.err}\nReply again with ONLY the JSON action object — {"thought":"…","action":"<one of ${TOOL_NAMES.join('|')}>","…": "<arguments>"}. No markdown fences, no prose.`,
      });
    }
    if (transportErr) {
      log('error', `LLM 调用失败: ${tail(transportErr, 200)}`);
      transportFail++;
      if (transportFail >= 2) return { status: 'failed', error: `LLM 调用连续失败: ${tail(transportErr, 200)}` };
      continue;
    }
    transportFail = 0;
    if (!parsed) {
      parseFail++;
      if (parseFail >= 2) return { status: 'failed', error: 'LLM 连续返回无法解析的内容，自动修复中止' };
      log('error', 'LLM 本轮多次解析失败 — 进入下一轮重试');
      continue;
    }
    parseFail = 0;

    // ---- Legacy one-shot plan → fallback executor ----
    if (parsed.kind === 'legacy') {
      const r = await execLegacyPlan(parsed.plan, job, helpers, snap);
      if (r.outcome === 'success') return { status: 'success' };
      lastError = r.message;
      messages.push({
        role: 'user',
        content: `TOOL_RESULT (legacy plan + retry):\n${headTail(r.message, 1800)}\nContinue with proper tool actions (inspect / probe / test / patch / update_env / run_retry) to finish the repair.`,
      });
      continue;
    }

    // ---- Dispatch the tool ----
    const { action, args, thought } = parsed;
    if (thought) {
      job.diagnosis = String(thought).slice(0, 300);
      log('llm', `思路: ${job.diagnosis}`);
    }

    switch (action) {
      case 'inspect': {
        log('tool', `inspect ${inspectLabel(args)}`);
        const r = await toolInspect(args, snap);
        log(r.startsWith('ERROR') ? 'error' : 'output', headTail(r, 300));
        messages.push({ role: 'user', content: `TOOL_RESULT (inspect):\n${headTail(r, 2200)}` });
        break;
      }
      case 'probe': {
        log('tool', `probe ${probeLabel(args)}`);
        const r = await toolProbe(args);
        log(r.startsWith('ERROR') ? 'error' : 'output', headTail(r, 300));
        messages.push({ role: 'user', content: `TOOL_RESULT (probe):\n${headTail(r, 2000)}` });
        break;
      }
      case 'test': {
        // toolTest logs the command / approval / output itself.
        const r = await toolTest(args, snap, helpers);
        messages.push({ role: 'user', content: `TOOL_RESULT (test):\n${headTail(r, 1800)}` });
        break;
      }
      case 'patch': {
        log('tool', `patch ${String(args.file || '')}`);
        const r = await Promise.resolve(toolPatch(args, snap));
        log(r.startsWith('ERROR') ? 'error' : 'output', headTail(r, 300));
        messages.push({ role: 'user', content: `TOOL_RESULT (patch):\n${headTail(r, 800)}` });
        break;
      }
      case 'update_env': {
        log('tool', 'update_env — 更新环境配置');
        const r = await toolUpdateEnv(args, snap);
        log(r.startsWith('ERROR') ? 'error' : 'info', headTail(r, 300));
        messages.push({ role: 'user', content: `TOOL_RESULT (update_env):\n${headTail(r, 600)}` });
        break;
      }
      case 'run_retry': {
        log('tool', 'run_retry — 重启并验证健康');
        const r = await toolRunRetry(job, log, snap);
        if (r.outcome === 'success') return { status: 'success' };
        lastError = r.error || r.message;
        messages.push({
          role: 'user',
          content: `TOOL_RESULT (run_retry):\n${headTail(r.message, 2000)}\nAnalyze the logs above and continue (inspect / probe / test / patch / update_env), or call finish with giveUp:true if truly unfixable.`,
        });
        break;
      }
      case 'finish': {
        const reason = String(args.reason || '');
        if (args.giveUp === true) {
          job.diagnosis = job.diagnosis || reason.slice(0, 300);
          return { status: 'failed', error: `LLM 判定无法自动修复: ${reason || job.diagnosis}` };
        }
        // finish without giveUp — verify before accepting the claim.
        const fresh = await loadEnvSnapshot(job);
        const pf = fresh ? await probePort(fresh.port) : null;
        if (pf?.listening) {
          log('success', `LLM 结束修复 — 端口 ${fresh?.port} 实际监听，视为成功`);
          await db.environment.update({ where: { id: job.envId }, data: { status: 'running' } });
          return { status: 'success' };
        }
        messages.push({
          role: 'user',
          content: `TOOL_RESULT (finish): REFUSED — port ${fresh?.port} is not listening, so the repair is not verified. Use run_retry to actually start and health-check the service, or call finish with giveUp:true to end the repair.`,
        });
        break;
      }
    }

    // Bound the conversation: keep the initial context + the most recent
    // exchanges (drop an even count so user/assistant alternation survives).
    if (messages.length > 40) {
      const drop = messages.length - 34 + ((messages.length - 34) % 2);
      if (drop > 0) messages.splice(1, drop);
    }
  }

  return { status: 'failed', error: `未能在 ${job.maxRounds} 个工具步内完成修复: ${tail(lastError, 200)}` };
}

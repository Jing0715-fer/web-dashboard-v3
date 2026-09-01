/**
 * LLM auto-repair engine.
 *
 * When starting or rebuilding a project environment fails, the start/rebuild
 * routes kick off a repair job (fire-and-forget). Each round the engine
 * gathers the failure context (error message, process logs, package.json,
 * current env config), asks the configured LLM for a JSON fix plan
 * (diagnosis + shell commands + optional cmd/envVars/port updates), executes
 * the safe commands in the project directory and retries. Up to maxRounds
 * rounds; progress is recorded on an in-memory job that the frontend polls
 * via /api/repair-jobs/[jobId].
 */

import { db } from '@/lib/db';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { startProcess, stopProcess, checkPortStatus, getLogs } from '@/lib/process-manager';
import { callLLM, extractJson } from '@/lib/llm-providers';
import { logActivity } from '@/lib/activity';

const execp = promisify(exec);

export type RepairKind = 'start' | 'rebuild';

export interface RepairStep {
  ts: number;
  level: 'info' | 'command' | 'output' | 'llm' | 'success' | 'error' | 'warn' | 'approval' | 'approved' | 'denied';
  msg: string;
  /** Repair round this step belongs to (0 = pre-round setup). Lets the
   *  dialog render "Round N" dividers between diagnosis/fix attempts. */
  round?: number;
}

export interface PendingApproval {
  cmd: string;
  ts: number;
  /** Epoch-ms when the server auto-denies if nobody answers (ts + 10min). */
  expiresAt: number;
}

export interface RepairJob {
  id: string;
  projectId: string;
  projectName: string;
  envId: string;
  envName: string;
  kind: RepairKind;
  status: 'running' | 'success' | 'failed';
  steps: RepairStep[];
  diagnosis?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  round: number;
  maxRounds: number;
  /** Non-null while the job is paused waiting for a human to approve (or
   *  deny) a command that failed the safe-allowlist check. The dialog polls
   *  this and renders an approve/deny panel. */
  pendingApproval?: PendingApproval | null;
}

// In-memory job registry. Stored on globalThis because Next.js dev mode
// instantiates lib modules per route bundle — a plain module-level Map would
// not be shared between the route that creates jobs and the one that polls them.
const globalForRepair = globalThis as unknown as {
  __llmRepairJobs?: Map<string, RepairJob>;
  __llmRepairActiveByEnv?: Map<string, string>;
  __llmRepairApprovals?: Map<string, (approved: boolean) => void>;
};
const jobs: Map<string, RepairJob> = globalForRepair.__llmRepairJobs ?? new Map();
globalForRepair.__llmRepairJobs = jobs;
// envId → active (running) job id. Prevents duplicate concurrent repair jobs
// for the same environment (double-start races + orphaned duplicate processes).
const activeByEnv: Map<string, string> = globalForRepair.__llmRepairActiveByEnv ?? new Map();
globalForRepair.__llmRepairActiveByEnv = activeByEnv;
// jobId → resolver for the pending manual-approval request.
const approvals: Map<string, (approved: boolean) => void> = globalForRepair.__llmRepairApprovals ?? new Map();
globalForRepair.__llmRepairApprovals = approvals;
let jobSeq = 0;

export function getRepairJob(id: string): RepairJob | null {
  return jobs.get(id) ?? null;
}

function pruneOldJobs() {
  if (jobs.size <= 30) return;
  const sorted = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const job of sorted.slice(0, jobs.size - 30)) {
    // Never prune running jobs
    if (job.status === 'running') continue;
    jobs.delete(job.id);
  }
}

export interface StartRepairOptions {
  projectId: string;
  envId: string;
  kind: RepairKind;
  initialError: string;
  buildStderr?: string;
  buildStdout?: string;
}

/** Create a repair job and run it in the background. Returns the job id. */
export function startRepairJob(opts: StartRepairOptions): string {
  // Mutex per environment: if a repair job is already running for this env,
  // hand back its id instead of spawning a second concurrent one (two jobs
  // racing startProcess produced duplicate instances on different ports).
  const existingId = activeByEnv.get(opts.envId);
  if (existingId) {
    const existing = jobs.get(existingId);
    if (existing && existing.status === 'running') {
      return existing.id;
    }
  }
  const id = `rj_${Date.now().toString(36)}_${++jobSeq}`;
  const job: RepairJob = {
    id,
    projectId: opts.projectId,
    projectName: '',
    envId: opts.envId,
    envName: '',
    kind: opts.kind,
    status: 'running',
    steps: [],
    startedAt: Date.now(),
    round: 0,
    maxRounds: 3,
  };
  jobs.set(id, job);
  activeByEnv.set(opts.envId, id);
  pruneOldJobs();
  void runRepair(job, opts)
    .catch((err) => {
      finishJob(job, 'failed', String(err?.message || err));
    })
    .finally(() => {
      if (activeByEnv.get(opts.envId) === id) activeByEnv.delete(opts.envId);
    });
  return id;
}

// ====================== activity feed (fire-and-forget) ======================

/** Finalize a job (status/error/finishedAt) and persist the lifecycle event. */
function finishJob(job: RepairJob, status: 'success' | 'failed', error?: string): void {
  job.status = status;
  if (error !== undefined) job.error = error;
  job.finishedAt = Date.now();
  logRepairCompletion(job);
}

function logRepairCompletion(job: RepairJob): void {
  const durationMs = job.finishedAt != null ? job.finishedAt - job.startedAt : undefined;
  const envLabel = job.envName || job.envId;
  const base = {
    projectId: job.projectId,
    projectName: job.projectName || undefined,
    envId: job.envId,
    envName: job.envName || undefined,
    durationMs,
  };
  if (job.status === 'success') {
    logActivity({
      ...base,
      type: 'repair',
      level: 'success',
      message: `LLM auto-repair succeeded for '${envLabel}'`,
      detail: job.diagnosis ? String(job.diagnosis).slice(0, 300) : undefined,
    });
  } else {
    logActivity({
      ...base,
      type: 'repair',
      level: 'error',
      message: `LLM auto-repair failed for '${envLabel}'`,
      detail: job.error ? String(job.error).slice(0, 300) : undefined,
    });
  }
}

// ============================= helpers =============================

function log(job: RepairJob, level: RepairStep['level'], msg: string) {
  job.steps.push({ ts: Date.now(), level, msg: String(msg).slice(0, 500), round: job.round });
  if (job.steps.length > 400) job.steps.splice(0, job.steps.length - 400);
}

// ====================== manual approval gate ======================

/** How long a job waits for a human decision before auto-denying. Background
 *  jobs (dialog closed with "keep running") must never hang forever. */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** Pause the job until resolveRepairApproval() is called (or the timeout
 *  auto-denies). The pending command is exposed on job.pendingApproval for
 *  the polling dialog to render an approve/deny panel. */
function requestApproval(job: RepairJob, cmd: string): Promise<boolean> {
  job.pendingApproval = { cmd, ts: Date.now(), expiresAt: Date.now() + APPROVAL_TIMEOUT_MS };
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      approvals.delete(job.id);
      if (job.pendingApproval) job.pendingApproval = null;
      resolve(v);
    };
    const timer = setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS);
    approvals.set(job.id, settle);
  });
}

/** Resolve a pending approval request (called from the approve API route).
 *  Returns false when the job / request no longer exists. */
export function resolveRepairApproval(jobId: string, approved: boolean): boolean {
  const job = jobs.get(jobId);
  if (!job || !job.pendingApproval) return false;
  const settle = approvals.get(jobId);
  if (!settle) return false;
  settle(approved);
  return true;
}

function tail(text: string, max = 400): string {
  if (!text) return '';
  const t = text.trim();
  return t.length > max ? t.slice(-max) : t;
}

/** Child-process env without Next.js internals leaking into the project. */
function buildChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('__NEXT_PRIVATE_')) continue;
    if (k === 'NEXT_DEPLOYMENT_ID' || k === '__NEXT_PROCESSED_ENV') continue;
    if (k === 'TURBOPACK' || k === 'NEXT_RUNTIME') continue;
    // DATABASE_* points at the dashboard's own SQLite — leaking it into repair
    // commands (npm install postinstalls, prisma db push, …) would let them
    // mutate the dashboard's database instead of the child project's.
    if (k === 'DATABASE_URL' || k.startsWith('DATABASE_')) continue;
    if (v === undefined) continue;
    env[k] = v;
  }
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}

const SAFE_REPAIR_PREFIXES = [
  'npm', 'npx', 'yarn', 'pnpm', 'bun',
  'pip', 'pip3', 'python', 'python3', 'uv', 'poetry', 'pipenv',
  'go', 'cargo', 'rustc', 'make',
  'node', 'deno', 'tsc', 'eslint', 'prettier', 'prisma', 'next', 'vite',
  'bundle', 'composer', 'artisan', 'dotnet', 'mvn', 'gradle', 'php',
  'ruby', 'rails', 'gem',
  'mkdir', 'touch', 'cp', 'mv', 'sed', 'echo',
];

const DANGEROUS_PATTERNS = [
  /rm\s+(-[a-z]*r[a-z]*f?|[a-z]*f[a-z]*r?|-rf|-fr)/i,
  /\bsudo\b/,
  /:\s*\(\)\s*\{/, // fork bomb
  /dd\s+if=/,
  /mkfs/,
  />\s*\/dev\//,
  /chmod\s+777/,
  /wget.*\|\s*(ba)?sh/,
  /curl.*\|\s*(ba)?sh/,
  /\bcd\s/,
  /\/etc\/|\/usr\/(?!local\/bin)|\/var\//,
];

/** Validate a repair command from the LLM before executing it. */
function isRepairCommandSafe(cmd: string): boolean {
  const trimmed = (cmd || '').trim();
  if (!trimmed || trimmed.length > 400) return false;
  if (DANGEROUS_PATTERNS.some((p) => p.test(trimmed))) return false;

  // Strip leading VAR=value env prefixes (same as process-manager).
  let firstToken = trimmed.split(/\s+/)[0] || '';
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(firstToken)) {
    firstToken = trimmed.split(/\s+/)[1] || '';
  }
  if (!firstToken) return false;
  return SAFE_REPAIR_PREFIXES.some((prefix) => firstToken === prefix || firstToken.startsWith(prefix + ' '));
}

const SAFE_START_PREFIXES = [
  'npm', 'npx', 'yarn', 'pnpm', 'bun', 'python', 'python3', 'go', 'cargo', 'make',
  'node', 'deno', 'flask', 'gunicorn', 'uvicorn', 'django', 'dotnet', 'php',
  'ruby', 'rails', 'bundle', 'docker', 'sh', 'bash', './', 'PORT=',
];

function isStartCmdSafe(cmd: string): boolean {
  const c = (cmd || '').trim();
  return c.length > 0 && c.length <= 500 && SAFE_START_PREFIXES.some((p) => c.startsWith(p));
}

function readPackageJsonSummary(projectPath: string): string {
  try {
    const p = join(projectPath, 'package.json');
    if (!existsSync(p)) return '(no package.json)';
    const content = readFileSync(p, 'utf8');
    const pj = JSON.parse(content);
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
    return readdirSync(projectPath)
      .filter((f) => !f.startsWith('.'))
      .slice(0, 40)
      .join(', ');
  } catch {
    return '(unreadable)';
  }
}

// ============================= LLM repair prompt =============================

const REPAIR_SYSTEM =
  'You are a senior DevOps repair agent. You receive a failing project environment (a start command or a production build that failed) together with its logs and configuration. You diagnose the root cause and reply with ONLY a valid JSON object (no markdown fences, no prose) describing a minimal fix plan. You are precise and minimal, preferring non-destructive commands; when a destructive command (e.g. clearing a corrupted build cache) is genuinely required, propose it — a human will review and approve it before it runs.';

function buildRepairPrompt(ctx: {
  kind: RepairKind;
  projectName: string;
  projectPath: string;
  envName: string;
  cmd: string;
  port: number;
  envVars: Record<string, string>;
  error: string;
  buildStderr?: string;
  logs: string[];
  packageJson: string;
  topLevelFiles: string;
  round: number;
  maxRounds: number;
}): string {
  const { kind } = ctx;
  return `A project environment failed and must be repaired.

Project: ${ctx.projectName} (at ${ctx.projectPath})
Environment: ${ctx.envName} (port ${ctx.port})
Current start command: ${ctx.cmd}
Current envVars: ${JSON.stringify(ctx.envVars)}

Failure kind: ${kind === 'rebuild' ? 'production rebuild (npm run build) failed' : 'start command failed'}

=== ERROR MESSAGE ===
${ctx.error || '(none)'}

${kind === 'rebuild' && ctx.buildStderr ? `=== BUILD STDERR (tail) ===\n${tail(ctx.buildStderr, 2500)}\n` : ''}
=== RECENT PROCESS LOGS (tail) ===
${ctx.logs.length > 0 ? ctx.logs.slice(-50).join('\n').slice(0, 4000) : '(no logs)'}

=== package.json (summary) ===
${ctx.packageJson}

=== Top-level files ===
${ctx.topLevelFiles}

This is repair round ${ctx.round} of ${ctx.maxRounds}. Reply with ONLY this JSON object:
{
  "diagnosis": "one paragraph explaining the root cause in Chinese",
  "commands": ["shell commands to run in the project directory to fix the problem, e.g. 'npm install dayjs', 'sed -i ...' — empty array if none needed"],
  "cmd": "OPTIONAL: replacement start command (only if the current one is wrong). For production environments of Next.js projects prefer 'npm run build && npm run start'. Keep it a single shell command.",
  "port": OPTIONAL_NUMBER,
  "envVars": {"OPTIONAL": "merged into the environment variables"},
  "giveUp": false
}

Rules:
- Commands run with the project directory as cwd. Prefer minimal, non-destructive fixes (install a missing dependency, patch a config with sed).
- Destructive commands (e.g. 'rm -rf .next' for a stale build cache, 'rm -rf node_modules' for a corrupted install) are permitted but will be held for human approval before execution — propose one ONLY when it is genuinely the right fix. Never use sudo or cd.
- Typical fixes: missing dependency → install it; syntax/config error → patch the file with sed; wrong command → provide the corrected "cmd"; port conflict → provide a different "port".
- Never occupy port 3000 (reserved for the dashboard itself).
- If the failure is clearly not fixable by commands (e.g. requires a rewrite), set giveUp=true with an explanation in diagnosis.
- envVars values must be strings. Include HOST=0.0.0.0 and PORT when the server needs them.
- Respond with ONLY the JSON object.`;
}

// ============================= main loop =============================

async function runRepair(job: RepairJob, opts: StartRepairOptions) {
  log(
    job,
    'info',
    `${job.kind === 'rebuild' ? 'Rebuild' : '启动'}失败 — LLM 自动修复已启动（最多 ${job.maxRounds} 轮诊断）`,
  );

  let lastError = opts.initialError || 'unknown error';
  let buildStderr = opts.buildStderr;

  for (let round = 1; round <= job.maxRounds; round++) {
    job.round = round;

    const env = await db.environment.findUnique({
      where: { id: job.envId },
      include: { project: true },
    });
    if (!env || env.projectId !== job.projectId || !env.project) {
      finishJob(job, 'failed', 'Environment or project disappeared during repair');
      return;
    }
    job.projectName = env.project.name;
    job.envName = env.name;

    if (round === 1) {
      logActivity({
        type: 'repair',
        level: 'info',
        message: `LLM auto-repair started for '${env.name}'`,
        projectId: job.projectId,
        projectName: env.project.name,
        envId: job.envId,
        envName: env.name,
        detail: opts.initialError ? String(opts.initialError).slice(0, 300) : undefined,
      });
    }

    let envVars: Record<string, string> = {};
    try {
      envVars = JSON.parse(env.envVars);
    } catch {
      envVars = {};
    }

    log(job, 'info', `第 ${round}/${job.maxRounds} 轮：收集错误上下文并调用 LLM 诊断…`);

    // ---- 1. Ask the LLM for a fix plan ----
    let plan: any;
    try {
      const res = await callLLM({
        system: REPAIR_SYSTEM,
        prompt: buildRepairPrompt({
          kind: job.kind,
          projectName: env.project.name,
          projectPath: env.project.path,
          envName: env.name,
          cmd: env.cmd,
          port: env.port,
          envVars,
          error: lastError,
          buildStderr,
          logs: getLogs(job.projectId, env.name),
          packageJson: readPackageJsonSummary(env.project.path),
          topLevelFiles: readTopLevelFiles(env.project.path),
          round,
          maxRounds: job.maxRounds,
        }),
        temperature: 0.2,
        maxTokens: 2048,
      });
      plan = extractJson(res.text);
    } catch (err: any) {
      log(job, 'error', `LLM 调用失败: ${tail(err?.message || String(err), 200)}`);
      continue; // retry next round (transient LLM errors are common)
    }

    if (!plan) {
      log(job, 'error', 'LLM 返回内容无法解析为 JSON — 重试下一轮');
      continue;
    }

    job.diagnosis = String(plan.diagnosis || '');
    log(job, 'llm', `诊断: ${job.diagnosis}`);

    if (plan.giveUp === true) {
      finishJob(job, 'failed', `LLM 判定无法自动修复: ${job.diagnosis}`);
      return;
    }

    // ---- 2. Execute the repair commands ----
    // Commands that pass the safe-allowlist check run automatically. Anything
    // else (rm -rf on a stale build dir, cd-chains, …) is NOT silently
    // skipped — the job pauses and surfaces the command for manual approval
    // in the repair dialog; denying (or a 10-minute timeout) skips it.
    const commands: string[] = Array.isArray(plan.commands) ? plan.commands.slice(0, 6) : [];
    for (const cmd of commands) {
      const c = String(cmd || '').trim();
      if (!c) continue;
      if (!isRepairCommandSafe(c)) {
        log(job, 'approval', c);
        const approved = await requestApproval(job, c);
        if (!approved) {
          log(job, 'denied', c);
          continue;
        }
        log(job, 'approved', c);
      }
      log(job, 'command', `$ ${c}`);
      try {
        const { stdout, stderr } = await execp(c, {
          cwd: env.project.path,
          timeout: 240_000,
          maxBuffer: 8 * 1024 * 1024,
          env: buildChildEnv(),
        });
        if (tail(stdout, 300)) log(job, 'output', tail(stdout, 300));
        if (tail(stderr, 300)) log(job, 'output', `[stderr] ${tail(stderr, 300)}`);
      } catch (e: any) {
        log(job, 'error', `命令失败: ${tail(e?.stderr || e?.stdout || e?.message || String(e), 300)}`);
      }
    }

    // ---- 3. Apply configuration updates ----
    const updates: Record<string, unknown> = {};
    if (typeof plan.cmd === 'string' && plan.cmd.trim() && !isStartCmdSafe(plan.cmd)) {
      log(job, 'warn', `替换启动命令未通过安全校验，已忽略: ${String(plan.cmd).slice(0, 120)}`);
    }
    if (typeof plan.cmd === 'string' && isStartCmdSafe(plan.cmd) && plan.cmd.trim() !== env.cmd) {
      updates.cmd = plan.cmd.trim();
      log(job, 'info', `更新启动命令: ${updates.cmd}`);
    }
    if (
      Number.isInteger(Number(plan.port)) &&
      Number(plan.port) > 0 &&
      Number(plan.port) < 65536 &&
      Number(plan.port) !== env.port &&
      Number(plan.port) !== 3000
    ) {
      updates.port = Number(plan.port);
      log(job, 'info', `更新端口: ${env.port} → ${updates.port}`);
    }
    if (plan.envVars && typeof plan.envVars === 'object' && !Array.isArray(plan.envVars)) {
      const merged: Record<string, string> = { ...envVars };
      for (const [k, v] of Object.entries(plan.envVars)) {
        if (typeof k === 'string' && (typeof v === 'string' || typeof v === 'number')) {
          merged[k] = String(v);
        }
      }
      updates.envVars = JSON.stringify(merged);
    }
    if (Object.keys(updates).length > 0) {
      await db.environment.update({ where: { id: job.envId }, data: updates });
    }

    // ---- 4. Retry ----
    const fresh = await db.environment.findUnique({ where: { id: job.envId } });
    if (!fresh) {
      finishJob(job, 'failed', 'Environment disappeared during repair');
      return;
    }
    // Another actor (the user, another job) already got this env running
    // while the repair was thinking — treat as success instead of racing it.
    if (fresh.status === 'running') {
      log(job, 'success', `环境已处于运行状态（可能被手动启动），无需继续修复`);
      finishJob(job, 'success');
      return;
    }
    let freshEnvVars: Record<string, string> = {};
    try {
      freshEnvVars = JSON.parse(fresh.envVars);
    } catch {
      freshEnvVars = {};
    }

    if (job.kind === 'rebuild') {
      log(job, 'command', '$ npm run build');
      try {
        const { stdout } = await execp('npm run build', {
          cwd: env.project.path,
          timeout: 300_000,
          maxBuffer: 8 * 1024 * 1024,
          env: buildChildEnv({ NODE_ENV: 'production' }),
        });
        if (tail(stdout, 300)) log(job, 'output', tail(stdout, 300));
        log(job, 'success', '构建成功');
      } catch (e: any) {
        lastError = `Build failed: ${tail(e?.message || '', 500)}`;
        buildStderr = tail(e?.stderr || e?.stdout || '', 4000);
        log(job, 'error', `构建仍然失败: ${tail(e?.stderr || e?.message, 300)}`);
        continue;
      }
    }

    log(job, 'info', `重试启动: ${fresh.cmd} (port ${fresh.port})`);
    // If the port is still occupied (e.g. an orphaned process from a previous
    // dashboard session — the in-memory registry is empty after a restart),
    // stop it first instead of letting startProcess fail with "port in use"
    // and letting the LLM "fix" it by forking a second instance on a new port.
    if (await checkPortStatus(fresh.port)) {
      log(job, 'info', `端口 ${fresh.port} 仍被占用，先尝试停止旧进程…`);
      await stopProcess(job.projectId, fresh.name, fresh.port);
    }
    const result = await startProcess(
      job.projectId,
      fresh.name,
      fresh.cmd,
      env.project.path,
      freshEnvVars,
      fresh.port,
    );

    if (result.success) {
      await db.environment.update({
        where: { id: job.envId },
        data: { status: 'running', pid: result.pid ?? null },
      });
      log(job, 'success', `修复成功 — 环境已在端口 ${fresh.port} 上运行 (pid ${result.pid})`);
      finishJob(job, 'success');
      return;
    }

    lastError = result.error || 'retry failed';
    log(job, 'error', `重试失败: ${tail(lastError, 300)}`);
  }

  finishJob(job, 'failed', lastError);
  log(job, 'error', `自动修复未能在 ${job.maxRounds} 轮内解决问题: ${tail(lastError, 200)}`);
}

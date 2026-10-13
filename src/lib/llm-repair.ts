/**
 * LLM auto-repair job orchestration.
 *
 * When starting or rebuilding a project environment fails, the start/rebuild
 * routes kick off a repair job (fire-and-forget). Two engines, selected in
 * the LLM settings dialog (LlmConfig.repairMode):
 *   - 'legacy' (default): the diagnosis+fix loop in repair-agent.ts
 *     (LLM-as-dispatcher with inspect / probe / test / patch / update_env /
 *     run_retry tools).
 *   - 'cli': llm-repair/cli-delegate.ts delegates the whole diagnose+fix
 *     phase to an installed agent CLI (Claude Code / Codex / Hermes / …),
 *     then independently health-verifies; falls back to legacy when no CLI
 *     is installed.
 * This module owns the job registry, the human-approval gate for dangerous
 * commands, lifecycle logging and the /api/repair-jobs polling surface —
 * shared by both engines.
 */

import { db } from '@/lib/db';
import { logActivity } from '@/lib/activity';
import { runAgentRepair, type AgentHelpers } from './repair-agent';
import { runCliRepair, resolveRepairCli, CLI_ROUNDS, CLI_ROUND_TIMEOUT_MS } from './llm-repair/cli-delegate';
import { scheduleThumbnailCapture } from './thumbnail';

export type RepairKind = 'start' | 'rebuild';

/** How long a job waits for a human decision before auto-denying. Background
 *  jobs (dialog closed with "keep running") must never hang forever. Defined
 *  up here so the watchdog window can reference it — the two stay in sync by
 *  construction, not by a copy-pasted magic number. */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** How long a job may make ZERO progress (no new log steps) before the
 * watchdog declares the engine hung and force-fails the job.
 *
 * Why this exists (the codex incident): a delegated CLI round is legitimately
 * silent for up to CLI_ROUND_TIMEOUT_MS (10 min) while the agent works, and
 * the legacy loop pauses up to APPROVAL_TIMEOUT_MS on an approval request.
 * Anything beyond that with no new steps is not "thinking" — it is a hung
 * spawn/await that would otherwise leave the job 'running' FOREVER: the
 * dialog keeps showing “修复中 / LLM 处理中”， and no completion toast or
 * activity event ever fires. The watchdog guarantees every job settles.
 * Calibrated to: max(CLI round, approval wait) + 2 min margin. */
const WATCHDOG_INACTIVITY_MS = Math.max(CLI_ROUND_TIMEOUT_MS, APPROVAL_TIMEOUT_MS) + 2 * 60_000;
const WATCHDOG_TICK_MS = 30_000;

/** Stable marker prefix for watchdog force-finish errors. job.error is a
 *  backend string, but the polling dialog renders it in the user's locale —
 *  the frontend matches this marker and swaps in a localized sentence,
 *  falling back to the raw text. Format: [watchdog_timeout:<minutes>]. */
export const WATCHDOG_ERROR_MARKER = /^\[watchdog_timeout:(\d+)\]\s*/;

export interface RepairStep {
  ts: number;
  level: 'info' | 'command' | 'output' | 'llm' | 'tool' | 'success' | 'error' | 'warn' | 'approval' | 'approved' | 'denied';
  msg: string;
  /** Agent step this entry belongs to (0 = pre-loop setup). Lets the dialog
   *  render "Step N" dividers between diagnosis/fix attempts. */
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
  /** Current agent step (1..maxRounds). */
  round: number;
  /** Total agent step budget (LLM turns), NOT fix attempts. */
  maxRounds: number;
  /** Non-null while the job is paused waiting for a human to approve (or
   *  deny) a command that failed the safe-allowlist check. The dialog polls
   *  this and renders an approve/deny panel. */
  pendingApproval?: PendingApproval | null;
  /** Monotonic count of log() calls EVER made for this job. steps[] is a
   *  rolling window trimmed to the last 400 entries, so steps.length FREEZES
   *  at 400 once the window fills — the watchdog must not use it as its
   *  progress signal or an actively-logging job gets falsely killed. */
  stepSeq?: number;
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
    // Agent step budget: each step = one LLM turn + one tool call. 15 steps
    // cover inspect → probe → patch → update_env → run_retry plus a corrective
    // iteration or two. Raised from 12 after the SciWrite prod incident, where
    // a stream of unreadable-log shell workarounds (now fixed by log decoding
    // + the interactive-command refusal) starved the budget before a single
    // repair attempt happened — the margin absorbs LLM flakiness too.
    maxRounds: 15,
  };
  jobs.set(id, job);
  activeByEnv.set(opts.envId, id);
  pruneOldJobs();
  armWatchdog(job);
  void runRepair(job, opts)
    .catch((err) => {
      finishJob(job, 'failed', String(err?.message || err));
    })
    .finally(() => {
      if (activeByEnv.get(opts.envId) === id) activeByEnv.delete(opts.envId);
      disarmWatchdog(job);
    });
  return id;
}

// ====================== inactivity watchdog ======================
//
// Every job gets one. It does NOT bound how long a job may legitimately take
// (a real 2-round CLI repair with builds can run ~30 min) — it bounds how
// long a job may show ZERO progress. On trigger the job is force-failed with
// a self-explaining error so the polling dialog can settle, fire its
// completion toast, and never show "LLM 处理中" forever (see header comment).

interface WatchdogState { lastStepSeq: number; lastChangeAt: number; timer: ReturnType<typeof setInterval> }
// On globalThis for the same reason as the jobs Map: Next.js dev builds one
// module instance per route bundle — a plain module-level Map would not be
// shared by the bundle that armed the timer and one that tries to disarm it.
const globalForWatchdogs = globalThis as unknown as { __llmRepairWatchdogs?: Map<string, WatchdogState> };
const watchdogs: Map<string, WatchdogState> = globalForWatchdogs.__llmRepairWatchdogs ?? new Map();
globalForWatchdogs.__llmRepairWatchdogs = watchdogs;

function armWatchdog(job: RepairJob): void {
  const state: WatchdogState = { lastStepSeq: job.stepSeq ?? 0, lastChangeAt: Date.now(), timer: 0 as unknown as ReturnType<typeof setInterval> };
  state.timer = setInterval(() => {
    if (job.status !== 'running') { disarmWatchdog(job); return; }
    // Progress signal is the MONOTONIC stepSeq, never steps.length (which
    // freezes at the 400-entry cap while the job keeps logging — that false
    // "no progress" verdict is what this fix exists to prevent).
    const seq = job.stepSeq ?? job.steps.length;
    if (seq !== state.lastStepSeq || job.pendingApproval) {
      // progress happened (or an approval is deliberately holding the job) —
      // the approval pause is bounded by APPROVAL_TIMEOUT_MS auto-deny anyway.
      state.lastStepSeq = seq;
      state.lastChangeAt = Date.now();
      return;
    }
    if (Date.now() - state.lastChangeAt < WATCHDOG_INACTIVITY_MS) return;
    const minutes = Math.round(WATCHDOG_INACTIVITY_MS / 60_000);
    // [watchdog_timeout:N] marker → the dialog swaps in a localized sentence.
    const error = `[watchdog_timeout:${minutes}] 修复引擎看门狗：连续 ${minutes} 分钟无任何进展，判定引擎挂死（未预见的 spawn/await 卡住）。已强制结束本任务 — 可重新触发启动让修复重试。`;
    job.stepSeq = (job.stepSeq ?? 0) + 1;
    job.steps.push({ ts: Date.now(), level: 'error', msg: error, round: job.round });
    finishJob(job, 'failed', error);
    disarmWatchdog(job);
  }, WATCHDOG_TICK_MS);
  watchdogs.set(job.id, state);
}

function disarmWatchdog(job: RepairJob): void {
  const state = watchdogs.get(job.id);
  if (state) {
    clearInterval(state.timer);
    watchdogs.delete(job.id);
  }
}

// ====================== activity feed (fire-and-forget) ======================

/** Finalize a job (status/error/finishedAt) and persist the lifecycle event.
 *  Idempotent: a job that was already settled (typically force-failed by the
 *  watchdog while the engine was hung, then the engine's late verdict arrives)
 *  is never flipped or double-logged — a settled job stays settled. */
function finishJob(job: RepairJob, status: 'success' | 'failed', error?: string): void {
  if (job.status !== 'running') return;
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
    // v1.23: a successful repair just re-ran the ORIGINAL start command
    // during its health verification, so the page is warm — refresh the
    // card's live preview immediately instead of waiting for the next
    // manual start/restart to trigger a capture (fire-and-forget).
    void captureAfterRepair(job);
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

/** After a SUCCESSFUL repair, schedule a live-preview capture for the env.
 *  Best-effort by design: a thumbnail issue must never be able to look like
 *  a repair problem — every failure path here is silent. */
async function captureAfterRepair(job: RepairJob): Promise<void> {
  try {
    const env = await db.environment.findUnique({ where: { id: job.envId } });
    if (!env) return;
    scheduleThumbnailCapture({
      projectId: job.projectId,
      projectName: job.projectName,
      envId: job.envId,
      envName: job.envName || env.name,
      port: env.port,
    });
  } catch {
    // Cosmetic — see doc comment.
  }
}

// ============================= helpers =============================

function log(job: RepairJob, level: RepairStep['level'], msg: string) {
  job.steps.push({ ts: Date.now(), level, msg: String(msg).slice(0, 500), round: job.round });
  // Monotonic progress counter for the watchdog — see RepairJob.stepSeq.
  job.stepSeq = (job.stepSeq ?? 0) + 1;
  if (job.steps.length > 400) job.steps.splice(0, job.steps.length - 400);
}

// ====================== manual approval gate ======================

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

// ============================= orchestration =============================

async function runRepair(job: RepairJob, opts: StartRepairOptions) {
  // Resolve names early so activity logs and the dialog header are correct
  // from the very first poll, even before the first LLM turn.
  try {
    const env = await db.environment.findUnique({
      where: { id: job.envId },
      include: { project: true },
    });
    if (env?.project) {
      job.projectName = env.project.name;
      job.envName = env.name;
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
  } catch {
    // Names/activity are cosmetic — never block the repair on them.
  }

  const helpers: AgentHelpers = {
    log: (level, msg) => log(job, level, msg),
    requestApproval: (cmd) => requestApproval(job, cmd),
  };

  // ---- engine selection (switchable in the LLM settings dialog) ----
  // 'legacy' = the built-in LLM tool loop (default, kept forever);
  // 'cli'    = delegate the diagnose+fix phase to an installed agent CLI
  //            (Claude Code / Codex / Hermes / custom) — falls back to
  //            legacy when no CLI is installed, so 'cli' can never strand
  //            a user without a repair engine.
  let engine: 'legacy' | 'cli' = 'legacy';
  let cli: Awaited<ReturnType<typeof resolveRepairCli>> = null;
  try {
    const cfg = await db.llmConfig.findUnique({ where: { id: 'default' } });
    if (cfg?.repairMode === 'cli') {
      cli = await resolveRepairCli(String(cfg.repairCli ?? ''));
      if (cli) {
        engine = 'cli';
      } else {
        log(
          job,
          'warn',
          'Agent CLI 模式已开启，但未找到可用的 CLI（未安装或不在 PATH）— 本任务自动回退 legacy 工具循环',
        );
      }
    }
  } catch {
    // Config unreadable → default legacy; never block a repair on config DB.
  }

  let outcome;
  if (engine === 'cli' && cli) {
    // Round budget reinterpreted for the CLI engine: each round = one full
    // headless CLI delegation + independent health verification.
    job.maxRounds = CLI_ROUNDS;
    log(
      job,
      'info',
      `${job.kind === 'rebuild' ? 'Rebuild' : '启动'}失败 — AI 修复代理已启动（Agent CLI 模式：${cli.label}，最多 ${CLI_ROUNDS} 轮，每轮最长 ${Math.round(CLI_ROUND_TIMEOUT_MS / 60000)} 分钟）`,
    );
    outcome = await runCliRepair(job, opts, helpers, cli);
  } else {
    log(
      job,
      'info',
      `${job.kind === 'rebuild' ? 'Rebuild' : '启动'}失败 — AI 修复代理已启动（工具循环，最多 ${job.maxRounds} 步）`,
    );
    outcome = await runAgentRepair(job, opts, helpers);
  }

  // The watchdog may have force-failed this job while the engine was hung;
  // if the engine belatedly returns anyway, its verdict is discarded — never
  // flip a settled job (failed → success) and never log a second completion
  // activity event on top of the watchdog's.
  if (job.status !== 'running') {
    log(job, 'warn', '修复引擎在超时后返回了结果 — 任务已被看门狗判定挂死并结束，忽略该迟到结果');
    return;
  }
  if (outcome.status === 'success') {
    log(job, 'success', '修复流程结束 — 成功');
    finishJob(job, 'success');
  } else {
    finishJob(job, 'failed', outcome.error);
    log(job, 'error', `自动修复未成功: ${String(outcome.error || '').slice(0, 200)}`);
  }
}

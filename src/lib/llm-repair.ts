/**
 * LLM auto-repair job orchestration.
 *
 * When starting or rebuilding a project environment fails, the start/rebuild
 * routes kick off a repair job (fire-and-forget). The actual diagnosis+fix
 * loop lives in repair-agent.ts (LLM-as-dispatcher with inspect / probe /
 * test / patch / update_env / run_retry tools); this module owns the job
 * registry, the human-approval gate for dangerous commands, lifecycle
 * logging and the /api/repair-jobs polling surface.
 */

import { db } from '@/lib/db';
import { logActivity } from '@/lib/activity';
import { runAgentRepair, type AgentHelpers } from './repair-agent';

export type RepairKind = 'start' | 'rebuild';

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
    // Agent step budget: each step = one LLM turn + one tool call. 12 steps
    // comfortably covers inspect → probe → patch → update_env → run_retry →
    // one corrective iteration, with room to spare.
    maxRounds: 12,
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

// ============================= orchestration =============================

async function runRepair(job: RepairJob, opts: StartRepairOptions) {
  log(
    job,
    'info',
    `${job.kind === 'rebuild' ? 'Rebuild' : '启动'}失败 — AI 修复代理已启动（工具循环，最多 ${job.maxRounds} 步）`,
  );

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

  const outcome = await runAgentRepair(job, opts, helpers);

  if (outcome.status === 'success') {
    log(job, 'success', '修复流程结束 — 成功');
    finishJob(job, 'success');
  } else {
    finishJob(job, 'failed', outcome.error);
    log(job, 'error', `自动修复未成功: ${String(outcome.error || '').slice(0, 200)}`);
  }
}

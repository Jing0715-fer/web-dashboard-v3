import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db';
import { proxyToAgent } from '@/lib/remote-agent';
import { applyRemoteAnalysis } from '@/lib/remote-apply';

/**
 * Remote-analysis AUTO-APPLY watcher (server-side).
 *
 * Problem it fixes: a remote device auto-debug job used to keep its result
 * ONLY inside the RemoteProjectDialog. If the user closed the dialog /
 * refreshed before clicking "add", the verified environments were silently
 * lost.
 *
 * Local harness sessions are auto-applied directly inside the engine
 * (src/lib/harness/engine.ts — it runs in-process and knows when a session
 * completes). Remote device jobs still need a poller on the dashboard side,
 * which is what this module provides:
 *   - POST /api/devices/:id/analyze-remote registers the job here
 *     (persisted to db/harness-apply-queue.json, survives dev-server restarts)
 *   - a globalThis-singleton watcher polls the device agent until the job
 *     reaches a terminal state and applies the result on the device through
 *     the SAME shared code path as the manual "add" button
 *     (src/lib/remote-apply.ts) — no user interaction required
 *   - the job GET responses are enriched with `applied` so the dialog can
 *     render the auto-saved state
 */

const QUEUE_FILE = join(process.cwd(), 'db', 'harness-apply-queue.json');
const POLL_INTERVAL_MS = 3000;
/** Pending jobs whose device agent can no longer be reached are expired
 *  after this long (the device agent keeps finished jobs ~60min in memory). */
const PENDING_TTL_MS = 20 * 60_000;
/** Finished outcomes are kept (for dialog restore + debugging) this long. */
const OUTCOME_TTL_MS = 24 * 60 * 60_000;

export interface AutoApplyJob {
  jobId: string;
  deviceId: string;
  remotePath: string;
  remoteName?: string;
  createdAt: number;
  status: 'pending' | 'done';
  outcome?: any;
  appliedAt?: number;
  /** consecutive polls where the device agent / job was unreachable */
  misses?: number;
}

interface AutoApplyGlobal {
  __remoteAutoApplyJobs?: Map<string, AutoApplyJob>;
  __remoteAutoApplyTimer?: any;
  __remoteAutoApplyHydrated?: boolean;
  __remoteAutoApplyBusy?: boolean;
}
const g = globalThis as unknown as AutoApplyGlobal;

const jobs: Map<string, AutoApplyJob> = g.__remoteAutoApplyJobs ?? new Map();
g.__remoteAutoApplyJobs = jobs;

// ============================= persistence =============================

function loadQueueFromDisk() {
  if (g.__remoteAutoApplyHydrated) return;
  g.__remoteAutoApplyHydrated = true;
  try {
    if (!existsSync(QUEUE_FILE)) return;
    const raw = JSON.parse(readFileSync(QUEUE_FILE, 'utf8'));
    const arr: any[] = Array.isArray(raw?.jobs) ? raw.jobs : Array.isArray(raw) ? raw : [];
    const now = Date.now();
    for (const j of arr) {
      if (!j?.jobId || !j?.deviceId) continue;
      const age = now - Number(j.createdAt || 0);
      if (j.status === 'done' && age > OUTCOME_TTL_MS) continue;
      if (j.status === 'pending' && age > PENDING_TTL_MS) continue;
      jobs.set(String(j.jobId), {
        jobId: String(j.jobId),
        deviceId: String(j.deviceId),
        remotePath: String(j.remotePath || ''),
        remoteName: j.remoteName ? String(j.remoteName) : undefined,
        createdAt: Number(j.createdAt) || Date.now(),
        status: j.status === 'done' ? 'done' : 'pending',
        outcome: j.outcome,
        appliedAt: Number(j.appliedAt) || undefined,
        misses: Number(j.misses) || 0,
      });
    }
  } catch { /* corrupt file — start fresh */ }
}

function persistQueue() {
  try {
    const arr = [...jobs.values()].map((j) => ({
      jobId: j.jobId,
      deviceId: j.deviceId,
      remotePath: j.remotePath,
      remoteName: j.remoteName,
      createdAt: j.createdAt,
      status: j.status,
      outcome: j.outcome,
      appliedAt: j.appliedAt,
    }));
    mkdirSync(join(process.cwd(), 'db'), { recursive: true });
    writeFileSync(QUEUE_FILE, JSON.stringify({ version: 1, jobs: arr }, null, 2));
  } catch (err: any) {
    console.error('[remote-auto-apply] persistQueue failed:', err?.message || err);
  }
}

// ============================= registration =============================

/**
 * Associate a REMOTE device analyze-job with the device+path so its result is
 * auto-applied on the device (project + environments created via the agent
 * API, then the dashboard sync mirrors it) when the job completes.
 */
export async function registerRemoteAutoApply(jobId: string, deviceId: string, remotePath: string, remoteName?: string): Promise<boolean> {
  loadQueueFromDisk();
  if (!jobId || !deviceId || !remotePath) return false;
  try {
    const device = await db.device.findUnique({ where: { id: deviceId }, select: { id: true } });
    if (!device) return false;
  } catch {
    return false;
  }
  jobs.set(jobId, {
    jobId,
    deviceId,
    remotePath,
    remoteName: remoteName || undefined,
    createdAt: Date.now(),
    status: 'pending',
    misses: 0,
  });
  persistQueue();
  ensureWatcher();
  return true;
}

/** Outcome for UI enrichment:
 *   undefined → no auto-apply registered (manual add fallback)
 *   {pending: true} → watcher still waiting/applying
 *   {ok, ...} → terminal outcome of the server-side apply
 */
export function getAutoApplyOutcome(jobId: string): any {
  loadQueueFromDisk();
  const job = jobs.get(jobId);
  if (!job) return undefined;
  if (job.status === 'pending') return { pending: true };
  return job.outcome ?? { ok: false, status: 'unknown', error: 'auto-apply outcome missing' };
}

// ============================= watcher =============================

function ensureWatcher() {
  if (g.__remoteAutoApplyTimer) return;
  const timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  timer.unref?.();
  g.__remoteAutoApplyTimer = timer;
  console.log('[remote-auto-apply] watcher started');
}

async function tick() {
  if (g.__remoteAutoApplyBusy) return; // previous tick still applying
  g.__remoteAutoApplyBusy = true;
  let dirty = false;
  try {
    const now = Date.now();
    // GC finished outcomes.
    for (const [id, job] of jobs) {
      if (job.status === 'done' && job.appliedAt && now - job.appliedAt > OUTCOME_TTL_MS) {
        jobs.delete(id);
        dirty = true;
      }
    }
    for (const job of [...jobs.values()]) {
      if (job.status !== 'pending') continue;
      // Expire hopelessly old pending jobs.
      if (now - job.createdAt > PENDING_TTL_MS) {
        job.status = 'done';
        job.appliedAt = now;
        job.outcome = { ok: false, status: 'expired', error: '远程分析任务长时间不可达，自动应用已过期' };
        dirty = true;
        console.warn(`[remote-auto-apply] job ${job.jobId} expired (unreachable too long)`);
        continue;
      }
      try {
        dirty = (await pollRemoteJob(job)) || dirty;
      } catch (err: any) {
        job.misses = (job.misses ?? 0) + 1;
        console.error('[remote-auto-apply] poll error:', err?.message || err);
      }
    }
  } finally {
    g.__remoteAutoApplyBusy = false;
    if (dirty) persistQueue();
  }
}

/** Poll a remote device analyze-job; apply the result on the device when it completes. */
async function pollRemoteJob(job: AutoApplyJob): Promise<boolean> {
  if (!job.deviceId) return false;
  const device = await db.device.findUnique({ where: { id: job.deviceId } });
  if (!device) {
    job.status = 'done';
    job.appliedAt = Date.now();
    job.outcome = { ok: false, status: 'device-gone', error: '设备已被删除，无法自动应用分析结果' };
    return true;
  }
  const result = await proxyToAgent(
    { ip: device.ip, port: device.port, apiKey: device.apiKey },
    `/analyze-project/${job.jobId}`,
    'GET',
  );
  if (result.status === 404) {
    job.misses = (job.misses ?? 0) + 1;
    return false;
  }
  if (!result.ok) return false;
  const data: any = result.data;
  if (!data || data.status === 'running') return false;
  job.misses = 0;

  if (data.status === 'completed' && data.result && job.remotePath) {
    const outcome = await applyRemoteAnalysis({
      device: { id: device.id, ip: device.ip, port: device.port, apiKey: device.apiKey },
      path: job.remotePath,
      name: job.remoteName,
      analysis: data.result,
      autoStart: false, // auto-start stays a user decision
    });
    job.status = 'done';
    job.appliedAt = Date.now();
    job.outcome = {
      ok: outcome.ok,
      status: outcome.ok ? 'applied-remote' : 'error',
      applied: outcome.environments,
      projectId: outcome.projectId,
      error: outcome.error,
    };
    console.log(`[remote-auto-apply] job ${job.jobId} → ${outcome.ok ? `applied on device ${device.name}` : `apply failed: ${outcome.error}`}`);
    return true;
  }

  job.status = 'done';
  job.appliedAt = Date.now();
  job.outcome = { ok: false, status: String(data.status || 'failed'), error: data.error || `远程分析状态: ${data.status}` };
  return true;
}

// Start recovering queued jobs the moment any route first imports this module.
loadQueueFromDisk();
if ([...jobs.values()].some((j) => j.status === 'pending')) {
  ensureWatcher();
}

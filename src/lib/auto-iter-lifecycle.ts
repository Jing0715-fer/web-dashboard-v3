import { spawn, execSync, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { registerMeshServicePort } from '@/lib/ports';

/**
 * Supervisor for the auto-iter mini-service (mini-services/auto-iter, port
 * 3111) — the unattended continuous-iteration loop that patrols dev.log and
 * pushes a guarded round every 30 minutes.
 *
 * WHY A SUPERVISOR: in the sandboxed deployment the dashboard process is the
 * only long-lived root; background processes started from user shells are
 * reaped when those sessions end (observed in production). Spawning the
 * service as a DETACHED child of the running dashboard — the exact pattern
 * ensureLocalAgent uses for the mesh agent — gives it the dashboard's
 * lifetime. On every dashboard boot (instrumentation) and on demand
 * (POST /api/mesh/ensure-iter) a dead service is respawned.
 *
 * The service keeps ALL of its mutable state (state.json / iter.log / .env)
 * inside its own directory, gitignored — a supervisor restart never loses
 * the PAT or the round counter. (If the sandbox wipes those files, the
 * service starts fresh at round 1 and reports the missing PAT in its
 * status payload — re-provision .env and it resumes pushing.)
 */

const ITER_PORT = 3111;
const ITER_DIR = path.join(process.cwd(), 'mini-services', 'auto-iter');

export interface AutoIterStatus {
  running: boolean
  started: boolean
  port: number
  error?: string
}

let spawnLock = false;

async function probeIter(timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${ITER_PORT}/`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Wait for the status endpoint to answer, up to `ms`. */
async function waitForIter(ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probeIter(1000)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Ensure the auto-iter service is running, respawning it as a detached
 * dashboard child when needed. Safe to call repeatedly (instrumentation
 * boot, mesh route, manual curl); a concurrent spawn is guarded by a lock.
 */
export async function ensureAutoIterService(): Promise<AutoIterStatus> {
  if (await probeIter()) {
    // Already running (typical boot path) — its port is the dashboard's own
    // infrastructure; keep the stray sweeper from ever killing it.
    registerMeshServicePort(ITER_PORT);
    return { running: true, started: false, port: ITER_PORT };
  }

  if (!existsSync(path.join(ITER_DIR, 'index.ts'))) {
    return { running: false, started: false, port: ITER_PORT, error: 'mini-services/auto-iter not present' };
  }
  if (spawnLock) {
    // Another spawn is in flight — give it a moment and re-probe.
    return { running: await waitForIter(10_000), started: false, port: ITER_PORT };
  }
  spawnLock = true;
  try {
    let bunAvailable = false;
    try {
      execSync('bun --version', { stdio: 'ignore', timeout: 3000, windowsHide: true });
      bunAvailable = true;
    } catch { /* no bun CLI */ }
    if (!bunAvailable) {
      return { running: false, started: false, port: ITER_PORT, error: 'bun CLI not available' };
    }

    // Fresh clone / wiped sandbox: deps must exist before `bun run dev`.
    if (!existsSync(path.join(ITER_DIR, 'node_modules'))) {
      try {
        execSync('bun install', { cwd: ITER_DIR, stdio: 'ignore', timeout: 120_000, windowsHide: true });
      } catch {
        return { running: false, started: false, port: ITER_PORT, error: 'bun install failed in mini-services/auto-iter' };
      }
    }

    const child: ChildProcess = spawn('bun', ['run', 'dev'], {
      cwd: ITER_DIR,
      detached: true,          // survive the spawning request/shell
      stdio: 'ignore',         // no pipes to hold the parent open
      windowsHide: true,        // headless background service — no console window
      env: { ...process.env, AUTO_ITER_INTERVAL_MS: String(30 * 60_000) },
    });
    child.unref();             // let the dashboard not wait on it
    registerMeshServicePort(ITER_PORT);

    const running = await waitForIter(15_000);
    return {
      running,
      started: running,
      port: ITER_PORT,
      error: running ? undefined : 'spawned but status endpoint did not answer within 15s',
    };
  } finally {
    spawnLock = false;
  }
}

/** Hostname-tagged log line helper (mirrors agent-lifecycle logging style). */
export function autoIterLogLine(msg: string): string {
  return `[auto-iter:${os.hostname()}] ${msg}`;
}

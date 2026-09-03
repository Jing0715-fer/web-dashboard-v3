import { spawn, execSync } from 'child_process';
import { existsSync, openSync, closeSync } from 'fs';
import * as path from 'path';
import { logActivity } from '@/lib/activity';

/**
 * Harness services lifecycle — mirrors agent-lifecycle.ts.
 *
 * The LLM analysis chain for "add project" is:
 *   dashboard :3000 → /api/harness/analyze → harness-agent :3022
 *   harness-agent spawns dsh → llm-gateway :3021 → provider (z-ai SDK or proxy)
 *
 * Neither service is started by anything else on a fresh clone (the mesh
 * agent has its own lifecycle). Before this module, adding a project on a
 * machine where the services weren't manually started failed with
 * "harness-agent 不可达" (502) even though the LLM was configured — the
 * config was stored but nothing executed it.
 *
 * ensureHarnessServices() is called from instrumentation.register() on every
 * server boot: health-probes both ports and respawns anything missing.
 */

const GATEWAY_PORT = 3021;
const HARNESS_PORT = 3022;

interface ServiceSpec {
  name: string;
  port: number;
  dir: string;
  entry: string;
  healthPath: string;
}

const SERVICES: ServiceSpec[] = [
  {
    name: 'llm-gateway',
    port: GATEWAY_PORT,
    dir: 'llm-gateway',
    entry: 'index.ts',
    healthPath: '/health',
  },
  {
    name: 'harness-agent',
    port: HARNESS_PORT,
    dir: 'harness-agent',
    entry: 'index.ts',
    healthPath: '/api/harness/health',
  },
];

async function probeHttp(port: number, healthPath: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${healthPath}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Any HTTP answer (even 404) proves the listener exists; only
    // connection-level failure means "not running".
    return true;
  } catch (e: any) {
    return e?.name !== 'TimeoutError' && e?.name !== 'AbortError' ? false : true;
  }
}

function bunAvailable(): boolean {
  try {
    execSync('bun --version', { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a detached mini-service with bun (preferred) or node fallback.
 * Returns the child pid, or null when the entry doesn't exist.
 */
function spawnService(spec: ServiceSpec, runtime: 'bun' | 'node'): number | null {
  const root = process.cwd();
  const base = path.join(root, 'mini-services', spec.dir);
  const entry = path.join(base, spec.entry);
  if (!existsSync(entry)) return null;

  const logFile = path.join('/tmp', `dashboard-${spec.name}.log`);
  const out = openSync(logFile, 'a');
  const child = spawn(runtime, [entry], {
    cwd: base,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env },
  });
  child.unref();
  if (out !== 1 && out !== 2) {
    try { closeSync(out); } catch { /* already closed */ }
  }
  return child.pid ?? null;
}

export interface HarnessEnsureResult {
  gateway: { running: boolean; started: boolean };
  harness: { running: boolean; started: boolean };
}

/**
 * Health-probe both services; (re)spawn anything that is not answering.
 * Safe to call repeatedly — running services are left untouched.
 */
export async function ensureHarnessServices(): Promise<HarnessEnsureResult> {
  const useBun = bunAvailable();
  const result: HarnessEnsureResult = {
    gateway: { running: false, started: false },
    harness: { running: false, started: false },
  };

  for (const spec of SERVICES) {
    const target = spec.name === 'llm-gateway' ? result.gateway : result.harness;
    const alive = await probeHttp(spec.port, spec.healthPath);
    if (alive) {
      target.running = true;
      target.started = false;
      continue;
    }
    // Port answered nothing — spawn it.
    const pid = spawnService(spec, useBun ? 'bun' : 'node');
    if (pid != null) {
      // Give the listener a moment, then re-probe so `running` reflects reality.
      await new Promise((r) => setTimeout(r, 1500));
      const nowAlive = await probeHttp(spec.port, spec.healthPath);
      target.running = nowAlive;
      target.started = true;
      logActivity({
        type: 'pair',
        level: nowAlive ? 'info' : 'warning',
        message: nowAlive
          ? `${spec.name} started (port ${spec.port})`
          : `${spec.name} spawned but not healthy yet`,
        detail: `${spec.dir} · pid ${pid}`,
      });
    } else {
      logActivity({
        type: 'pair',
        level: 'warning',
        message: `${spec.name} could not start`,
        detail: `mini-services/${spec.dir}/${spec.entry} not found — project LLM analysis unavailable`,
      });
    }
  }

  return result;
}

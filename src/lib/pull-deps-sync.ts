/**
 * Post-pull dependency synchronization (v1.24).
 *
 * The classic pull→start failure chain: `git pull` brings in a new
 * package.json / lockfile, the pull reports SUCCESS, and the very next
 * start of the project dies with "Cannot find module …" — node_modules is
 * stale relative to the fresh manifest. The repair loop would fix it
 * (module-missing pattern → install), but why break it at all: right after
 * a pull that touched dependency files, run the matching install in the
 * background. Deterministic, invisible when nothing changed, best-effort.
 *
 * Used by both pull routes (v1.17 plain pull + v1.20 agent pull). Remote
 * projects pull on their own device — the device's agent handles its own
 * side; this module only ever runs for LOCAL project paths.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import { logActivity } from '@/lib/activity';
import { installCmdFor } from '@/lib/repair-lesson';
import { runShellProcess } from '@/lib/llm-repair/tools/exec';
import { buildChildEnv } from '@/lib/llm-repair/tools/safety';

const execFileAsync = promisify(execFile);

/** Files whose change means "dependencies may have moved". Matched on the
 *  path's basename so monorepo workspace manifests count too. */
const DEP_FILE_BASENAMES = new Set([
  'package.json',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);

export interface DepsSyncOptions {
  projectPath: string;
  projectId?: string;
  projectName?: string;
  /** Commit before the pull (empty = unknown → skip). */
  before?: string;
  /** Commit after the pull (empty = unknown → skip). */
  after?: string;
}

/**
 * Fire-and-forget: when the pull range touched dependency files and the
 * project has node_modules, run the lockfile-appropriate install in the
 * background and record the outcome as an activity event. NEVER throws and
 * NEVER blocks the caller — a dependency problem must not turn a successful
 * pull into a failed one.
 */
export function syncDepsAfterPull(opts: DepsSyncOptions): void {
  void runDepsSync(opts).catch(() => { /* best-effort by contract */ });
}

async function runDepsSync(opts: DepsSyncOptions): Promise<void> {
  const { projectPath, projectId, projectName } = opts;
  const before = String(opts.before || '').trim();
  const after = String(opts.after || '').trim();
  if (!before || !after || before === after) return; // up-to-date / unknown range

  // Only Node-style projects benefit (a Python/Go repo with a stray
  // package.json in docs would just waste an install attempt).
  if (!existsSync(join(projectPath, 'package.json'))) return;
  // No node_modules → the next start's repair fast path (module-missing
  // pattern) installs anyway; avoid surprising the user with a fresh
  // multi-hundred-MB install they didn't ask for.
  if (!existsSync(join(projectPath, 'node_modules'))) return;

  // Which dependency files moved in this pull range?
  let changed: string[] = [];
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--name-only', before, after],
      { cwd: projectPath, timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    changed = String(stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return; // range unreadable (shallow, force-moved) — nothing to sync on
  }
  const depChanges = changed.filter((f) => DEP_FILE_BASENAMES.has(f.split('/').pop() || ''));
  if (depChanges.length === 0) return;

  const installCmd = installCmdFor(projectPath);
  const label = projectName || projectPath;
  try {
    logActivity({
      type: 'pull',
      level: 'info',
      message: `Dependencies changed in pull (${depChanges.join(', ')}) — running ${installCmd} automatically`,
      projectId: projectId || undefined,
      projectName: projectName || undefined,
      detail: `Changed: ${depChanges.slice(0, 8).join(', ')}`,
    });
    const r = await runShellProcess(installCmd, {
      cwd: projectPath,
      timeoutMs: 300_000,
      env: buildChildEnv(),
      stdoutCap: 16_000,
      stderrCap: 8_000,
    });
    if (r.exitCode === 0) {
      logActivity({
        type: 'pull',
        level: 'success',
        message: `${installCmd} finished after pull — dependencies are in sync`,
        projectId: projectId || undefined,
        projectName: projectName || undefined,
        durationMs: r.durationMs,
      });
    } else {
      logActivity({
        type: 'pull',
        level: 'warn',
        message: `${installCmd} failed after pull (exit ${String(r.exitCode)}) — the next start may need a repair`,
        projectId: projectId || undefined,
        projectName: projectName || undefined,
        detail: String(r.stderr || r.stdout || '').slice(0, 300),
      });
    }
  } catch (e: unknown) {
    logActivity({
      type: 'pull',
      level: 'warn',
      message: `${installCmd} could not run after pull — the next start may need a repair`,
      projectId: projectId || undefined,
      projectName: projectName || undefined,
      detail: String((e as Error)?.message || e).slice(0, 200),
    });
  }
}

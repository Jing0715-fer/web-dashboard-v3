import { db } from './db';
import { startProcess, stopProcess } from './process-manager';

export interface FrozenEnv {
  name: string;
  port: number;
  cmd: string;
  cwd: string;
  envVars: Record<string, string>;
}

/**
 * Stop the environments of a project that are currently running, so a git
 * operation on the working tree can rewrite the files they hold open.
 *
 * Why this is needed: a running dev server keeps its SQLite database open,
 * and on Windows a file that is open cannot be unlinked. `git stash` (and
 * the reset --hard inside it) therefore dies with
 *
 *     error: unable to unlink old 'db/custom.db': Invalid argument
 *     fatal: Could not reset index file to revision 'HEAD'
 *
 * and the pull fails before it ever reaches the network. Freezing the
 * environments releases the lock — and it is the right thing to do anyway,
 * since the pull is about to replace the code those servers are running.
 */
export async function freezeProjectEnvs(projectId: string): Promise<FrozenEnv[]> {
  const envs = await db.environment.findMany({
    where: { projectId, status: 'running' },
    select: { name: true, port: true, cmd: true, envVars: true },
  });
  const project = await db.project.findUnique({ where: { id: projectId }, select: { path: true } });
  if (!project?.path) return [];

  const frozen: FrozenEnv[] = [];
  for (const e of envs) {
    let envVars: Record<string, string> = {};
    try {
      envVars = JSON.parse(e.envVars || '{}');
    } catch {
      envVars = {};
    }
    const r = await stopProcess(projectId, e.name, e.port);
    if (r.success) frozen.push({ name: e.name, port: e.port, cmd: e.cmd, cwd: project.path, envVars });
  }
  return frozen;
}

/** Start the environments a pull froze, once the pull is done. */
export async function thawProjectEnvs(
  projectId: string,
  frozen: FrozenEnv[],
): Promise<{ name: string; ok: boolean; error?: string }[]> {
  const out: { name: string; ok: boolean; error?: string }[] = [];
  for (const f of frozen) {
    const r = await startProcess(projectId, f.name, f.cmd, f.cwd, f.envVars, f.port);
    out.push({ name: f.name, ok: r.success, error: r.error });
    if (r.success) {
      await db.environment.update({
        where: { id: (await db.environment.findFirst({ where: { projectId, name: f.name }, select: { id: true } }))?.id ?? '' },
        data: { status: 'running', pid: r.pid ?? null },
      }).catch(() => { /* the env row may have been removed meanwhile */ });
    }
  }
  return out;
}

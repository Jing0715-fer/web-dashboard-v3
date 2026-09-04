import { NextRequest, NextResponse } from 'next/server';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync, openSync, cpSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { db } from '@/lib/db';
import { requireApprovedUser } from '@/lib/auth';
import { getPidOnPort } from '@/lib/process-manager';
import { killTree } from '@/lib/port-utils';

const execAsync = promisify(exec);

// Strip Next.js internal env vars and bundler flags so child Next.js projects
// can build without inheriting the dashboard's TURBOPACK=1.
function buildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('__NEXT_PRIVATE_')) continue;
    if (k === 'NEXT_DEPLOYMENT_ID') continue;
    if (k === '__NEXT_PROCESSED_ENV') continue;
    if (k === 'TURBOPACK') continue;
    if (k === 'NEXT_RUNTIME') continue;
    if (v === undefined) continue;
    env[k] = v;
  }
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}

export async function POST(req: NextRequest) {
  // Auth guard (Task 11-a)
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const { projectId } = await req.json();
    if (!projectId) {
      return NextResponse.json({ success: false, error: 'projectId required' }, { status: 400 });
    }

    // Get project and its production environment
    const project = await db.project.findUnique({
      where: { id: projectId },
      include: { environments: true },
    });

    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }

    const prodEnv = project.environments.find(e => e.name === 'production');
    if (!prodEnv) {
      return NextResponse.json({ success: false, error: 'No production environment configured' }, { status: 400 });
    }

    const projectDir = project.path;
    const cmd = prodEnv.cmd;

    // Determine build and start commands based on the cmd
    // For Next.js projects: build = "bun run build", start = cmd
    // For non-Next.js: just restart using the cmd

    // Kill existing process on the port — cross-platform (lsof is Unix-only;
    // on Windows getPidOnPort resolves the owner via netstat and killTree
    // uses taskkill /T /F so `next dev` workers die with their parent).
    try {
      const pid = await getPidOnPort(prodEnv.port);
      if (pid) {
        killTree(pid);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch {
      // Port not in use
    }

    // Check if it's a Next.js project (has next.config)
    const isNextJs = ['next.config.js', 'next.config.mjs', 'next.config.ts'].some(
      (f) => existsSync(join(projectDir, f)),
    );

    if (isNextJs) {
      // Build Next.js project
      console.log(`[RebuildProject] Building Next.js project ${project.name}...`);
      const { stdout: buildOut, stderr: buildErr } = await execAsync('npm run build', {
        cwd: projectDir,
        env: buildEnv({ NODE_ENV: 'production' }),
        timeout: 300000,
      });
      console.log('[RebuildProject] Build output:', buildOut);
      if (buildErr) console.log('[RebuildProject] Build stderr:', buildErr);

      // Copy static assets for standalone mode — fs.cpSync is cross-platform
      // (the previous `cp -r` shell call does not exist on Windows).
      const standaloneDir = join(projectDir, '.next', 'standalone');
      const hasStandalone = existsSync(standaloneDir);

      if (hasStandalone) {
        try {
          cpSync(join(projectDir, '.next', 'static'), join(standaloneDir, '.next', 'static'), { recursive: true });
        } catch { /* static dir optional */ }
        try {
          cpSync(join(projectDir, 'public'), join(standaloneDir, 'public'), { recursive: true });
        } catch { /* public dir optional */ }

        // Start from standalone — detached spawn with env passed explicitly
        // (no `sh -c 'KEY=v node server.js &'` — that syntax is POSIX-only).
        let envObj: Record<string, string> = {};
        try { envObj = JSON.parse(prodEnv.envVars || '{}'); } catch { /* ignore */ }
        const logFile = rebuildLogPath(project.name);
        startDetachedLogged({ command: 'node', args: ['server.js'] }, standaloneDir, buildEnv({
          NODE_ENV: 'production',
          PORT: String(prodEnv.port),
          ...envObj,
        }), logFile);
      } else {
        // Start using the cmd (e.g., "npm run start")
        const logFile = rebuildLogPath(project.name);
        startDetachedLogged({ shellCmd: cmd }, projectDir, buildEnv(), logFile);
      }
    } else {
      // Non-Next.js: just restart using the cmd
      console.log(`[RebuildProject] Restarting ${project.name}...`);
      const logFile = rebuildLogPath(project.name);
      startDetachedLogged({ shellCmd: cmd }, projectDir, buildEnv(), logFile);
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    return NextResponse.json({ success: true, message: `Rebuilt and restarted ${project.name}` });
  } catch (error: any) {
    console.error('[RebuildProject] Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Internal server error' }, { status: 500 });
  }
}

// Log file for the rebuilt service — os.tmpdir() so it also works on Windows.
function rebuildLogPath(projectName: string): string {
  return join(tmpdir(), `${projectName.toLowerCase().replace(/\s+/g, '-')}.log`);
}

/** Fire-and-forget detached start with stdout/stderr appended to a log file.
 *  Replaces the previous `sh -c 'cd … && cmd >> log 2>&1 &'` — POSIX-only
 *  syntax that failed with ENOENT on Windows. `shellCmd` runs through the
 *  platform shell; `command`+`args` spawn directly (no shell quoting at all). */
function startDetachedLogged(
  target: { shellCmd: string } | { command: string; args?: string[] },
  cwd: string,
  env: NodeJS.ProcessEnv,
  logFile: string,
): void {
  try {
    const out = openSync(logFile, 'a');
    const err = openSync(logFile, 'a');
    const child =
      'shellCmd' in target
        ? spawn(target.shellCmd, {
            shell: true,
            cwd,
            env,
            detached: true,
            stdio: ['ignore', out, err],
            windowsHide: true,
          })
        : spawn(target.command, target.args ?? [], {
            cwd,
            env,
            detached: true,
            stdio: ['ignore', out, err],
            windowsHide: true,
          });
    child.on('error', () => {
      /* logged via the log file / route error path */
    });
    child.unref();
  } catch (e: unknown) {
    console.error('[RebuildProject] detached start failed:', e);
  }
}

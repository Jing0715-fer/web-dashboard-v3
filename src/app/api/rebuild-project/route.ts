import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { db } from '@/lib/db';

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
  return { ...env, ...extra };
}

export async function POST(req: NextRequest) {
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

    // Kill existing process on the port
    try {
      const { stdout: pids } = await execAsync(`lsof -ti :${prodEnv.port}`, {
        env: buildEnv(),
      });
      if (pids.trim()) {
        for (const pid of pids.trim().split('\n')) {
          try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
        try {
          await execAsync(`kill -9 ${pids.trim().split('\n').join(' ')}`, {
            env: buildEnv(),
          });
        } catch {}
      }
    } catch {
      // Port not in use
    }

    // Check if it's a Next.js project (has next.config)
    const isNextJs = await execAsync(`test -f ${projectDir}/next.config.js || test -f ${projectDir}/next.config.mjs || test -f ${projectDir}/next.config.ts`, {
      env: buildEnv(),
    })
      .then(() => true)
      .catch(() => false);

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

      // Copy static assets for standalone mode
      const standaloneDir = `${projectDir}/.next/standalone`;
      const hasStandalone = await execAsync(`test -d ${standaloneDir}`, {
        env: buildEnv(),
      })
        .then(() => true)
        .catch(() => false);

      if (hasStandalone) {
        await execAsync(`cp -r ${projectDir}/.next/static ${standaloneDir}/.next/`, {
          env: buildEnv(),
        });
        try {
          await execAsync(`cp -r ${projectDir}/public ${standaloneDir}/`, {
            env: buildEnv(),
          });
        } catch {}

        // Start from standalone
        let envObj: Record<string, string> = {};
        try { envObj = JSON.parse(prodEnv.envVars || '{}'); } catch { /* ignore */ }
        const envStr = Object.entries(envObj)
          .map(([k, v]) => `${k}=${shellQuote(v)}`)
          .join(' ');
        const portStr = `PORT=${prodEnv.port}`;
        const logFile = `/tmp/${project.name.toLowerCase().replace(/\s+/g, '-')}.log`;
        execAsync(
          `sh -c 'cd ${shellQuote(standaloneDir)} && ${envStr} ${portStr} NODE_ENV=production node server.js >> ${shellQuote(logFile)} 2>&1 &'`,
          { env: buildEnv() }
        );
      } else {
        // Start using the cmd (e.g., "npm run start")
        const logFile = `/tmp/${project.name.toLowerCase().replace(/\s+/g, '-')}.log`;
        execAsync(
          `sh -c 'cd ${shellQuote(projectDir)} && ${cmd} >> ${shellQuote(logFile)} 2>&1 &'`,
          { env: buildEnv() }
        );
      }
    } else {
      // Non-Next.js: just restart using the cmd
      console.log(`[RebuildProject] Restarting ${project.name}...`);
      const logFile = `/tmp/${project.name.toLowerCase().replace(/\s+/g, '-')}.log`;
      execAsync(
        `sh -c 'cd ${shellQuote(projectDir)} && ${cmd} >> ${shellQuote(logFile)} 2>&1 &'`,
        { env: buildEnv() }
      );
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    return NextResponse.json({ success: true, message: `Rebuilt and restarted ${project.name}` });
  } catch (error: any) {
    console.error('[RebuildProject] Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Internal server error' }, { status: 500 });
  }
}

// Minimal shell quoting — wraps in single quotes, escapes any embedded single quotes.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

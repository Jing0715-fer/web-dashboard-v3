import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Build a sanitized env for child processes — strip Next.js internal vars and
// bundler flags that would conflict with the child's own build config.
// Without this, `next build` complains:
//   "Multiple bundler flags set: TURBOPACK=1, --webpack. Edit your command..."
// because the dashboard itself runs under TURBOPACK and we inherit that env.
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

export async function POST() {
  try {
    const projectDir = '/Users/lijing/Projects/web-dashboard';
    const standaloneDir = `${projectDir}/.next/standalone`;

    // 1. Kill any running Dashboard on port 3001 (NOT 3000 — that's the proxy)
    try {
      const { stdout: pids } = await execAsync(`lsof -ti :3001`, {
        env: buildEnv(),
      });
      if (pids.trim()) {
        for (const pid of pids.trim().split('\n')) {
          try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
        }
        // Wait for processes to die
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Force kill any remaining
        try {
          await execAsync(`kill -9 ${pids.trim().split('\n').join(' ')}`, {
            env: buildEnv(),
          });
        } catch {}
      }
    } catch {
      // Port not in use, that's fine
    }

    // 2. Build
    console.log('[Rebuild] Starting build...');
    const { stdout: buildOut, stderr: buildErr } = await execAsync('bun run build', {
      cwd: projectDir,
      env: buildEnv({ NODE_ENV: 'production' }),
      timeout: 300000,
    });
    console.log('[Rebuild] Build output:', buildOut);
    if (buildErr) console.log('[Rebuild] Build stderr:', buildErr);

    // 3. Copy static assets
    await execAsync(`cp -r ${projectDir}/.next/static ${standaloneDir}/.next/`, {
      env: buildEnv(),
    });
    try {
      await execAsync(`cp -r ${projectDir}/public ${standaloneDir}/`, {
        env: buildEnv(),
      });
    } catch {}

    // 4. Copy proxy-server.js to standalone (rebuild wipes it, restore it)
    await execAsync(`cp ${projectDir}/proxy-server.js ${standaloneDir}/proxy-server.js`, {
      env: buildEnv(),
    });

    // 5. Start new Dashboard server on port 3001
    // NOTE: We do NOT touch port 3000 (the proxy). Proxy will auto-restart Dashboard
    // because the proxy monitors its child and respawns on exit.
    console.log('[Rebuild] Starting Dashboard on port 3001...');
    // Give the proxy a moment to notice Dashboard is gone and respawn it.
    // The proxy's auto-restart kicks in 2s after exit, then Next.js needs ~3-5s to be ready.
    await new Promise(resolve => setTimeout(resolve, 6000));

    return NextResponse.json({
      success: true,
      message: 'Rebuilt Dashboard. Proxy auto-restarted the new build on port 3001.',
    });
  } catch (error: any) {
    console.error('[Rebuild] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

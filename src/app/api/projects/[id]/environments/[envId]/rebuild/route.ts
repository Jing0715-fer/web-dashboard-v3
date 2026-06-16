import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { stopProcess, startProcess } from '@/lib/process-manager'
import { exec } from 'child_process'
import { promisify } from 'util'

const execp = promisify(exec)

// 构建子进程用的安全环境变量 — 过滤掉 Next.js 内部变量和 bundler flags
function buildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('__NEXT_PRIVATE_')) continue
    if (k === 'NEXT_DEPLOYMENT_ID') continue
    if (k === '__NEXT_PROCESSED_ENV') continue
    if (k === 'TURBOPACK') continue
    if (k === 'NEXT_RUNTIME') continue
    if (v === undefined) continue
    env[k] = v
  }
  return { ...env, ...extra }
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; envId: string }> }
) {
  try {
    const { id, envId } = await params

    const env = await db.environment.findUnique({
      where: { id: envId },
      include: { project: true },
    })

    if (!env) {
      return NextResponse.json({ error: 'Environment not found' }, { status: 404 })
    }
    if (env.projectId !== id) {
      return NextResponse.json({ error: 'Environment does not belong to this project' }, { status: 403 })
    }

    // 1. Stop the process
    await stopProcess(id, env.name, env.port)

    // 2. Run build command
    try {
      await execp('npm run build', {
        cwd: env.project.path,
        env: buildEnv({ NODE_ENV: 'production' }),
        timeout: 300000,
      })
    } catch (buildErr: any) {
      const stderr = buildErr.stderr?.trim() || ''
      const stdout = buildErr.stdout?.trim() || ''
      const message = buildErr.message?.trim() || 'Unknown build error'
      return NextResponse.json({
        error: `Build failed: ${message}`,
        stderr: stderr.slice(-2000),
        stdout: stdout.slice(-1000),
      }, { status: 500 })
    }

    // 3. Copy build artifacts to standalone
    try {
      await execp('cp -r .next/static .next/standalone/.next/', {
        cwd: env.project.path,
        env: buildEnv(),
      })
      await execp('cp -r public .next/standalone/', {
        cwd: env.project.path,
        env: buildEnv(),
      })
    } catch {
      // ignore copy errors
    }

    // 4. Start the process
    let envVars: Record<string, string> = {}
    try {
      envVars = JSON.parse(env.envVars)
    } catch {
      // ignore
    }

    const result = await startProcess(
      id,
      env.name,
      env.cmd,
      env.project.path,
      envVars,
      env.port
    )

    if (result.success) {
      await db.environment.update({
        where: { id: envId },
        data: { status: 'running', pid: result.pid },
      })
      return NextResponse.json({ ok: true, pid: result.pid })
    } else {
      await db.environment.update({
        where: { id: envId },
        data: { status: 'stopped', pid: null },
      })
      return NextResponse.json({ ok: false, error: result.error }, { status: 400 })
    }
  } catch (e: any) {
    console.error('Failed to rebuild environment:', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

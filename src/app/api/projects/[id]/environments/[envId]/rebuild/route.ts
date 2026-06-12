import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { stopProcess, startProcess } from '@/lib/process-manager'
import { exec } from 'child_process'
import { promisify } from 'util'

const execp = promisify(exec)

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
        env: { ...process.env, NODE_ENV: 'production' },
        timeout: 120000,
      })
    } catch (buildErr: any) {
      return NextResponse.json({
        error: `Build failed: ${buildErr.message}`,
        stderr: buildErr.stderr?.slice(-500),
      }, { status: 500 })
    }

    // 3. Copy build artifacts to standalone
    try {
      await execp('cp -r .next/static .next/standalone/.next/', { cwd: env.project.path })
      await execp('cp -r public .next/standalone/', { cwd: env.project.path })
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
      // Update DB status
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

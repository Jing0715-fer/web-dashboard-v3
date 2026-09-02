import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { killProcessByPid, listListeningPorts } from '@/lib/ports';
import { logActivity } from '@/lib/activity';
import { requireApprovedUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/ports/kill — manually kill a process by pid (or by port: resolves
 * the pid first). Guards: the dashboard's own process chain can never be
 * killed; killing pid 1 is refused. After a successful kill the env registry
 * is reconciled (envs whose pid/port matched are marked stopped) so the UI
 * does not show a running environment for a dead process.
 *
 * Body: { pid?: number, port?: number } — exactly one is required.
 */
export async function POST(req: NextRequest) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const body = await req.json().catch(() => ({}));
    let pid = typeof body.pid === 'number' ? body.pid : null;
    let port = typeof body.port === 'number' ? body.port : null;

    if (pid == null && port == null) {
      return NextResponse.json({ error: 'Provide pid or port' }, { status: 400 });
    }

    // One listing serves both resolution and safety checks.
    const entries = await (async () => {
      try {
        return await listListeningPorts();
      } catch {
        return [];
      }
    })();
    const reserved = new Set<number>([3000]);
    const envPort = parseInt(process.env.PORT || '', 10);
    if (Number.isFinite(envPort) && envPort > 0) reserved.add(envPort);

    // Resolve port → pid (first listener on that port)
    if (pid == null && port != null) {
      const hit = entries.find((e) => e.port === port && e.pid != null);
      if (!hit || hit.pid == null) {
        return NextResponse.json({ error: `No process found listening on port ${port}` }, { status: 404 });
      }
      if (hit.self || reserved.has(port)) {
        return NextResponse.json({ error: `Port ${port} belongs to the dashboard itself — refusing to kill` }, { status: 403 });
      }
      pid = hit.pid;
    }

    // Belt-and-suspenders: refuse to kill whatever is listening on a reserved
    // port even when the request came as a raw pid (covers the case where the
    // route runs in a Turbopack worker whose parent-chain check cannot see
    // the main next-server process).
    if (pid != null && entries.some((e) => e.pid === pid && reserved.has(e.port))) {
      return NextResponse.json({ error: `Process ${pid} is listening on the dashboard's reserved port — refusing to kill` }, { status: 403 });
    }

    const command = entries.find((e) => e.pid === pid)?.command || '';

    const result = await killProcessByPid(pid);
    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Failed to kill process' }, { status: 400 });
    }

    // Reconcile the env registry: any env whose pid OR port matched the killed
    // process is now dead — mark it stopped so cards/logs don't lie. Ports are
    // unique among environments, so a port match is unambiguous.
    let envName = '';
    let projectId = '';
    let projectName = '';
    let matchedPort = port;
    if (pid != null) {
      const envs = await db.environment.findMany({ include: { project: true } });
      for (const env of envs) {
        if (env.pid === pid || (matchedPort != null && env.port === matchedPort)) {
          await db.environment.update({
            where: { id: env.id },
            data: { status: 'stopped', pid: null },
          });
          envName = env.name;
          projectId = env.project.id;
          projectName = env.project.name;
          if (matchedPort == null) matchedPort = env.port;
        }
      }
    }

    logActivity({
      type: 'process',
      level: 'warn',
      message: envName
        ? `Killed process for '${envName}' (pid ${pid}, port ${matchedPort ?? '?'})`
        : `Manually killed pid ${pid}${matchedPort ? ` (port ${matchedPort})` : ''}`,
      projectId: projectId || undefined,
      projectName: projectName || undefined,
      envName: envName || undefined,
      detail: command ? `command: ${command.slice(0, 200)}` : undefined,
    });

    return NextResponse.json({ ok: true, pid, port: matchedPort ?? null });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message || 'Failed to kill process' }, { status: 500 });
  }
}

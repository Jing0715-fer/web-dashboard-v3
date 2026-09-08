import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db';
import { logActivity } from '@/lib/activity';
import { requireApprovedUser } from '@/lib/auth';
import { proxyProjectAction } from '@/lib/route-decision';
import { invalidateUpdateCache } from '@/lib/git-update-check';
import { probeRemoteAgentHealth } from '@/lib/agent-health';

const execFileAsync = promisify(execFile);

/** Strip credentials (tokens) from a git URL before echoing it anywhere. */
function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    // ssh-style or plain text — mask anything that looks like a token
    return url.replace(/(https?:\/\/)[^@/]+@/i, '$1');
  }
}

function isValidRepoUrl(url: string): boolean {
  if (!url) return false;
  const trimmed = url.trim().toLowerCase();
  if (!/^https?:\/\//.test(trimmed)) return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * POST /api/projects/:id/pull — one-click `git pull` for a project with a
 * configured GitHub repository.
 *
 * Local project: runs `git pull --ff-only` in the project directory here.
 * Remote project: proxies to the device agent's
 * POST /api/agent/projects/:id/pull (the code lives on that machine — git
 * runs THERE). Legacy agents without the endpoint return 404, which is
 * reported as an actionable "update the agent" error. A missing Device
 * row is reported separately (it is NOT an agent-version problem).
 * Fails with a clear message when the directory is not a git checkout or
 * the remote diverged.
 *
 * The exported POST is a crash-proof wrapper: an unhandled error inside a
 * route handler makes Next answer with an HTML 500 page, which the frontend
 * can only render as a bare "Server error" (real user report — pull said
 * "server error" while every coded path returns JSON). EVERY failure mode
 * must answer JSON with an `error` field.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    return await handlePull(req, ctx);
  } catch (e: any) {
    return NextResponse.json(
      {
        error: 'Pull request failed on the dashboard',
        detail: String(e?.message || e).slice(0, 400),
      },
      { status: 500 },
    );
  }
}

async function handlePull(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;

  const { id } = await params;

  const project = await db.project.findUnique({ where: { id } });
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Remote project → proxy the pull to its device agent.
  if (project.deviceId) {
    const result = await proxyProjectAction(project.deviceId, `/projects/${id}/pull`, 'POST');
    if (result.ok) {
      // The checkout moved on the device — drop the cached freshness hint
      // (the UI also re-checks with ?refresh=1; this is belt-and-braces).
      invalidateUpdateCache([project.id]);
      await logActivity({
        type: 'pull',
        level: 'success',
        message: `Pulled ${project.name}${result.data?.summary ? ` (${result.data.summary})` : ''}`,
        projectId: project.id,
        projectName: project.name,
        detail: String(result.data?.output || '').split('\n').slice(-3).join(' · ').slice(0, 300),
      });
    } else if (result.data?.error === 'Device not found') {
      // The Device ROW is gone (removed on the devices page) — pointing the
      // user at an agent update would send them to fix the wrong thing.
      return NextResponse.json(
        {
          error: 'This project still points at a device that no longer exists on this dashboard — move it to another device (or make it local), then retry',
        },
        { status: 404 },
      );
    } else if (result.status === 404 && result.data?.error === 'Project not found') {
      // The agent ANSWERED (it has the route) but its own DB has no such row:
      // a dash-managed mirror row (the code lives on that machine's dashboard
      // DB, not the agent DB). That is NOT an agent-version problem — don't
      // send the user to upgrade a perfectly current agent.
      return NextResponse.json(
        {
          error:
            'This project is a mirror of a dashboard-managed project — the code lives on that machine but outside the agent\'s own database, so remote pull is not available for it',
        },
        { status: 404 },
      );
    } else if (result.status === 404) {
      // Best-effort: ask the agent's OPEN /health endpoint which version it
      // is actually RUNNING — confirms the diagnosis in the message and
      // warns about the restart requirement (git pull hot-reloads the
      // dashboard but NOT a spawned agent process).
      let running = '';
      try {
        const device = await db.device.findUnique({ where: { id: project.deviceId } });
        if (device) {
          const h = await probeRemoteAgentHealth({ id: device.id, ip: device.ip, port: device.port });
          if (h.version) running = ` — its agent reports v${h.version}`;
        }
      } catch { /* best-effort; version unknown */ }
      return NextResponse.json(
        {
          error:
            `This device agent is too old to pull remotely${running} — on that machine: git pull the repo, then RESTART the agent (git pull cannot hot-reload a running agent process)`,
        },
        { status: 502 },
      );
    } else {
      return NextResponse.json(
        {
          error: result.data?.error || 'Remote pull failed',
          detail: result.data?.detail,
        },
        { status: result.status },
      );
    }
    return NextResponse.json(result.data, { status: 200 });
  }
  if (!project.repoUrl) {
    return NextResponse.json(
      { error: 'No repository URL configured — edit the project and add one first' },
      { status: 400 },
    );
  }
  if (!isValidRepoUrl(project.repoUrl)) {
    return NextResponse.json(
      { error: `Invalid repository URL: ${sanitizeUrl(project.repoUrl)}` },
      { status: 400 },
    );
  }
  if (!existsSync(project.path) || !existsSync(join(project.path, '.git'))) {
    return NextResponse.json(
      { error: `Not a git repository: ${project.path}` },
      { status: 400 },
    );
  }

  try {
    // Current commit before pulling — for the "x → y" summary.
    let before = '';
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: project.path,
        timeout: 15000,
        maxBuffer: 1024 * 512,
      });
      before = stdout.trim();
    } catch { /* unborn HEAD on a fresh repo */ }

    // `git pull --ff-only` fails with "no tracking information" when the
    // branch has no upstream configured (common for freshly cloned/mirrored
    // checkouts). Detect that and fall back to pulling origin/<branch>.
    const pullArgs = ['pull', '--ff-only'];
    try {
      await execFileAsync('git', ['rev-parse', '--abbrev-ref', '@{u}'], {
        cwd: project.path,
        timeout: 15000,
        maxBuffer: 1024 * 512,
      });
    } catch {
      // No upstream configured — fall back to origin/<current-branch>.
      try {
        const { stdout: branchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: project.path,
          timeout: 15000,
          maxBuffer: 1024 * 512,
        });
        const branch = branchOut.trim();
        if (branch && branch !== 'HEAD') pullArgs.push('origin', branch);
      } catch { /* detached HEAD — let the pull surface its own error */ }
    }

    const { stdout, stderr } = await execFileAsync('git', pullArgs, {
      cwd: project.path,
      timeout: 5 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });

    let after = '';
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: project.path,
        timeout: 15000,
        maxBuffer: 1024 * 512,
      });
      after = stdout.trim();
    } catch { /* unborn HEAD */ }

    const output = (stdout || stderr || '').trim();
    // Locale-independent up-to-date detection: git output text ("Already up
    // to date") only works on English git installs; identical before/after
    // SHAs is the ground truth.
    const upToDate = /Already up to date/i.test(output) || (before !== '' && before === after);
    const range = before && after && before !== after ? ` (${before} → ${after})` : '';

    // Fresh HEAD now matches the remote — drop the stale "behind" hint.
    invalidateUpdateCache([project.id]);

    await logActivity({
      type: 'pull',
      level: 'success',
      message: `Pulled ${project.name}${range}`,
      projectId: project.id,
      projectName: project.name,
      detail: upToDate ? 'Already up to date' : output.split('\n').slice(-3).join(' · ').slice(0, 300),
    });

    return NextResponse.json({
      ok: true,
      upToDate,
      before,
      after,
      summary: upToDate ? 'Already up to date' : before || after ? `${before} → ${after}` : 'done',
      output: output.slice(0, 4000),
    });
  } catch (e: any) {
    const detail = String(e?.stderr || e?.stdout || e?.message || '').trim().slice(0, 400);
    await logActivity({
      type: 'pull',
      level: 'error',
      message: `Pull failed: ${project.name}`,
      projectId: project.id,
      projectName: project.name,
      detail: detail || 'git pull error',
    });
    return NextResponse.json(
      { error: 'git pull failed', detail: detail || undefined, repo: sanitizeUrl(project.repoUrl) },
      { status: 500 },
    );
  }
}

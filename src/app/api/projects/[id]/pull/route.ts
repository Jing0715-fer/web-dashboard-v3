import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db';
import { logActivity } from '@/lib/activity';
import { requireApprovedUser } from '@/lib/auth';

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
 * Runs `git pull --ff-only` in the project directory (local projects only —
 * a remote project's code lives on its own machine). Fails with a clear
 * message when the directory is not a git checkout or the remote diverged.
 */
export async function POST(
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
  if (project.deviceId) {
    return NextResponse.json(
      { error: 'Remote projects are pulled on their own machine — use the device dashboard there' },
      { status: 400 },
    );
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

    const { stdout, stderr } = await execFileAsync('git', ['pull', '--ff-only'], {
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
    const upToDate = /Already up to date/i.test(output);
    const range = before && after && before !== after ? ` (${before} → ${after})` : '';

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
      summary: upToDate ? 'Already up to date' : `${before} → ${after}`,
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

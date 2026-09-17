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
import { isValidBranchName, switchGitBranch } from '@/lib/git-branches';
import { execGitNetwork, isTransientGitNetworkError } from '@/lib/git-retry';
import {
  parsePullConflict, sanitizeConflictFiles, discardTrackedChanges, removeUntrackedBlockers,
  stashLocalChanges, popStash, isValidPullStrategy,
} from '@/lib/pull-conflict';

// execFile with windowsHide ON by default: git.exe / git-remote-https.exe
// are console-subsystem programs — from a console-less dashboard server
// (supervisor/scheduled start) every git call allocates a WINDOW on the
// user's desktop. CREATE_NO_WINDOW on Windows, no-op elsewhere.
const execFileRawAsync = promisify(execFile);
const execFileAsync = (file: string, args: string[], opts: any = {}): Promise<{ stdout: string; stderr: string }> =>
  execFileRawAsync(file, args, { windowsHide: true, ...opts }) as unknown as Promise<{ stdout: string; stderr: string }>;

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
 * Optional JSON body:
 *   { "branch": "feature-x" } — switches the checkout to that branch first
 *   { "strategy": "stash" | "force", "modified": [...], "untracked": [...] } —
 *     conflict resolution chosen in the UI after a 409 { conflict: true }
 *     answer (the file lists are the 409's own lists, round-tripped):
 *     - "stash": git stash --include-untracked → pull → git stash pop
 *       (local changes are KEPT and re-applied; pop conflicts are reported
 *       as stashConflict without failing the pull)
 *     - "force": discard ONLY the listed blocking files (git checkout HEAD
 *       -- / clean) and take the remote version — irreversible for those
 *       files, but unrelated local edits are preserved
 *
 * When the pull is blocked by local changes the answer is 409 with
 * { conflict: true, modified, untracked } so the frontend can ask the user
 * instead of dead-ending on git's raw stderr.
 *
 * Local project: runs the git commands in the project directory here.
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

  // Optional { branch } body — validated before it reaches any git argv.
  // A missing/empty body keeps the legacy same-branch pull behaviour.
  let branch = '';
  // Conflict-resolution strategy + the exact blocking file lists from the
  // earlier 409 (round-tripped by the conflict dialog). Untrusted input —
  // both go through the shared validators.
  let strategy: 'force' | 'stash' | null = null;
  let modifiedFiles: string[] = [];
  let untrackedFiles: string[] = [];
  try {
    const body = await req.json();
    if (body && typeof body.branch === 'string') branch = body.branch.trim();
    if (body && isValidPullStrategy(body.strategy)) strategy = body.strategy;
    modifiedFiles = sanitizeConflictFiles(body?.modified);
    untrackedFiles = sanitizeConflictFiles(body?.untracked);
  } catch { /* no body / not JSON — plain pull */ }
  if (branch && !isValidBranchName(branch)) {
    return NextResponse.json(
      { error: `Invalid branch name: ${branch.slice(0, 80)}` },
      { status: 400 },
    );
  }
  // "force" without the exact blocking file lists would mean discarding
  // EVERYTHING (or nothing) — the UI always sends the lists; a bare force
  // request is rejected rather than guessed at.
  if (strategy === 'force' && modifiedFiles.length === 0 && untrackedFiles.length === 0) {
    return NextResponse.json(
      { error: 'Force pull requires the blocking file lists from a conflict answer (modified/untracked)' },
      { status: 400 },
    );
  }

  const project = await db.project.findUnique({ where: { id } });
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Remote project → proxy the pull to its device agent.
  if (project.deviceId) {
    // Carry THIS dashboard's repoUrl for the project in the body. The GitHub
    // link was very likely saved HERE (remote-project rows live in the
    // CALLING dashboard's DB) — the executing agent can only look it up in
    // its own machine's databases, where it is often ''. Without this, pull
    // dies with "No 'origin' remote is configured" even though the UI shows
    // the link. The agent treats a body repoUrl as the highest-priority
    // source for wiring up a missing 'origin' (v1.9.0+; older agents ignore
    // the extra field harmlessly).
    const proxyBody: Record<string, unknown> = {};
    if (branch) proxyBody.branch = branch;
    if (isValidRepoUrl(project.repoUrl || '')) {
      proxyBody.repoUrl = String(project.repoUrl).trim();
    }
    // Conflict resolution (v1.17 agents): pass the chosen strategy + the
    // blocking file lists through — older agents ignore the extra fields.
    if (strategy) proxyBody.strategy = strategy;
    if (modifiedFiles.length > 0) proxyBody.modified = modifiedFiles;
    if (untrackedFiles.length > 0) proxyBody.untracked = untrackedFiles;
    const result = await proxyProjectAction(
      project.deviceId,
      `/projects/${id}/pull`,
      'POST',
      Object.keys(proxyBody).length > 0 ? proxyBody : undefined,
    );
    if (result.ok) {
      // The checkout moved on the device — drop the cached freshness hint
      // (the UI also re-checks with ?refresh=1; this is belt-and-braces).
      invalidateUpdateCache([project.id]);
      await logActivity({
        type: 'pull',
        level: 'success',
        message: `Pulled ${project.name}${result.data?.switchedTo ? ` → ${result.data.switchedTo}` : ''}${result.data?.summary ? ` (${result.data.summary})` : ''}`,
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
    } else if (result.status === 409 && result.data?.conflict) {
      // v1.17 agent: the pull on that machine is blocked by local changes —
      // pass the file lists through so THIS dashboard's UI can offer the
      // stash / discard / cancel choice instead of a dead-end error.
      return NextResponse.json(result.data, { status: 409 });
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
      // Pass the agent's actionable hint through (its 400s carry `hint`,
      // e.g. "No 'origin' remote … — save the project's GitHub URL so pull
      // can wire it up"); dropping it left the user with a bare error title.
      //
      // EXTRA: since agent v1.9.0 the dashboard SENDS its saved repoUrl in
      // the pull body and the agent wires 'origin' up automatically. An
      // "No 'origin' remote" answer therefore usually means the RUNNING
      // agent predates that (it ignored the field) — probe /health (no
      // auth) and, when confirmed old, tell the user the actual fix:
      // git pull + RESTART the agent on that machine.
      let upgradeHint = '';
      if (/no 'origin' remote/i.test(String(result.data?.error || ''))) {
        try {
          const device = await db.device.findUnique({ where: { id: project.deviceId } });
          if (device) {
            const h = await probeRemoteAgentHealth({ id: device.id, ip: device.ip, port: device.port });
            const ver = parseFloat(h.version || '0');
            if (h.version && ver < 1.9) {
              upgradeHint =
                `The device agent (v${h.version}) is older than v1.9.0 and ignores the GitHub URL this dashboard already sent with the pull — on that machine: git pull the repo, then RESTART the agent, then pull again (it will wire 'origin' up automatically)`;
            }
          }
        } catch { /* best-effort probe */ }
      }
      return NextResponse.json(
        {
          error: result.data?.error || 'Remote pull failed',
          detail: result.data?.detail || result.data?.hint,
          ...(upgradeHint ? { upgradeHint } : {}),
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

  // ---- Conflict-resolution strategies (LOCAL projects) ----
  // Applied BEFORE the switch/pull so both the checkout and merge phases
  // run on a tree the strategy just unblocked.
  const strategyNotes: string[] = [];
  let stashedForPull = false;
  if (strategy === 'force') {
    try {
      const n1 = await discardTrackedChanges(project.path, modifiedFiles);
      if (n1) strategyNotes.push(`[dashboard] ${n1}`);
      const n2 = await removeUntrackedBlockers(project.path, untrackedFiles);
      if (n2) strategyNotes.push(`[dashboard] ${n2}`);
    } catch (e: any) {
      return NextResponse.json(
        {
          error: 'Discarding the local changes failed',
          detail: String(e?.stderr || e?.message || '').trim().slice(0, 400),
          repo: sanitizeUrl(project.repoUrl),
        },
        { status: 500 },
      );
    }
  } else if (strategy === 'stash') {
    try {
      stashedForPull = await stashLocalChanges(project.path, new Date().toISOString());
      if (stashedForPull) strategyNotes.push('[dashboard] stashed local changes (--include-untracked)');
    } catch (e: any) {
      return NextResponse.json(
        {
          error: 'Stashing the local changes failed',
          detail: String(e?.stderr || e?.message || '').trim().slice(0, 400),
          repo: sanitizeUrl(project.repoUrl),
        },
        { status: 500 },
      );
    }
  }

  try {
    // Optional branch switch BEFORE the pull (checkout / checkout -b track
    // origin/<branch>). Uncommitted local changes are never stashed or
    // overwritten — git itself refuses a clobbering checkout and that error
    // is surfaced to the caller (as a 409 with file lists when it is the
    // conflict class — the UI then offers stash/discard).
    let switchedTo = '';
    if (branch) {
      let currentBranch = '';
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: project.path,
          timeout: 15000,
          maxBuffer: 1024 * 512,
        });
        currentBranch = stdout.trim();
      } catch { /* detached HEAD */ }
      if (currentBranch !== branch) {
        // Fresh remote refs so remote-only branches resolve (the picker's
        // fetch may be stale by the time the user clicks). Transient network
        // flakes (SSL_ERROR_SYSCALL…) are auto-retried inside.
        await execGitNetwork(['fetch', 'origin', '--prune'], {
          cwd: project.path,
          timeout: 60_000,
          maxBuffer: 1024 * 512,
        }).catch(() => { /* offline — switchGitBranch reports the miss */ });
        const sw = await switchGitBranch(project.path, branch);
        if (!sw.ok) {
          // The clobbering-checkout class becomes a 409 with the file lists.
          const cf = parsePullConflict(String(sw.error || ''));
          if (cf) {
            await logActivity({
              type: 'pull', level: 'warn',
              message: `Pull blocked by local changes: ${project.name}`,
              projectId: project.id, projectName: project.name,
              detail: [...cf.modified, ...cf.untracked].slice(0, 20).join(', ').slice(0, 300),
            });
            return NextResponse.json(
              {
                error: 'Local changes block the checkout/pull',
                conflict: true,
                modified: cf.modified,
                untracked: cf.untracked,
                detail: String(sw.error || '').slice(0, 600),
                hint: 'Stash the local changes (kept, restored after the pull) or discard them and take the remote version',
              },
              { status: 409 },
            );
          }
          await logActivity({
            type: 'pull',
            level: 'error',
            message: `Branch switch failed: ${project.name} → ${branch}`,
            projectId: project.id,
            projectName: project.name,
            detail: sw.error?.slice(0, 300) || 'git checkout error',
          });
          // Stash strategy: restore the user's changes before failing out.
          if (stashedForPull) await popStash(project.path).catch(() => {});
          return NextResponse.json(
            { error: `git checkout ${branch} failed`, detail: sw.error, repo: sanitizeUrl(project.repoUrl) },
            { status: 500 },
          );
        }
        switchedTo = branch;
      }
    }

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

    // Self-heal a missing 'origin' remote: copied/zipped checkouts carry
    // .git but no origin, and `git pull` then fails with the cryptic
    // "fatal: 'origin' does not appear to be a git repository". repoUrl was
    // validated above — wire it up automatically.
    let originUrl = '';
    try {
      const { stdout: urlOut } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd: project.path,
        timeout: 15000,
        maxBuffer: 1024 * 512,
      });
      originUrl = urlOut.trim();
    } catch { /* no origin remote configured */ }
    let originRepaired = '';
    if (!originUrl) {
      await execFileAsync('git', ['remote', 'add', 'origin', project.repoUrl.trim()], {
        cwd: project.path,
        timeout: 15000,
        maxBuffer: 1024 * 512,
      });
      originUrl = project.repoUrl.trim();
      originRepaired = "wired up 'origin' (it was missing)";
    }

    // `git pull --ff-only` fails with "no tracking information" when the
    // branch has no upstream configured (common for freshly cloned/mirrored
    // checkouts). Detect that and fall back to pulling origin/<branch>.
    const buildPullArgs = async (): Promise<string[]> => {
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
      return pullArgs;
    };

    let pullResult: { stdout: string; stderr: string } | null = null;
    let pullRetries = 0;
    try {
      // Transient network flakes to github.com:443 (classic:
      // `OpenSSL SSL_connect: SSL_ERROR_SYSCALL`) succeed on the next
      // attempt — auto-retry them instead of surfacing the error (v1.18).
      const pr = await execGitNetwork(await buildPullArgs(), {
        cwd: project.path,
        timeout: 5 * 60 * 1000,
        maxBuffer: 1024 * 1024,
      });
      pullRetries = pr.retried;
      pullResult = pr;
    } catch (e: any) {
      // 'origin' exists but is unreadable (dead local path from a copied
      // repo, wrong URL…) AND differs from the configured repoUrl → repoint
      // once and retry. A WORKING origin is never touched.
      const errText = String(e?.stderr || e?.stdout || e?.message || '');
      const wantUrl = project.repoUrl.trim();
      if (originUrl !== wantUrl &&
          /does not appear to be a git repository|Could not read from remote repository|Repository not found/i.test(errText)) {
        try {
          try {
            await execFileAsync('git', ['remote', 'set-url', 'origin', wantUrl], {
              cwd: project.path,
              timeout: 15000,
              maxBuffer: 1024 * 512,
            });
          } catch {
            await execFileAsync('git', ['remote', 'add', 'origin', wantUrl], {
              cwd: project.path,
              timeout: 15000,
              maxBuffer: 1024 * 512,
            });
          }
          originRepaired = "repointed 'origin' (its old URL was unreadable)";
          const pr2 = await execGitNetwork(await buildPullArgs(), {
            cwd: project.path,
            timeout: 5 * 60 * 1000,
            maxBuffer: 1024 * 1024,
          });
          pullRetries += pr2.retried;
          pullResult = pr2;
        } catch (e2: any) {
          // Surface BOTH the original failure and the retry failure through
          // the outer handler.
          throw Object.assign(
            new Error(String(e2?.stderr || e2?.stdout || e2?.message || '').trim() || 'git pull failed'),
            {
              stderr: [
                String(e?.stderr || e?.stdout || e?.message || ''),
                String(e2?.stderr || e2?.stdout || e2?.message || ''),
              ]
                .filter(Boolean)
                .join('\n')
                .slice(0, 400),
            },
          );
        }
      } else {
        throw e;
      }
    }
    if (!pullResult) throw new Error('git pull failed');
    const { stdout, stderr } = pullResult;

    // Auto-retry note: a transient network flake was recovered in-process —
    // surface it so the user knows why the pull took a few seconds longer
    // (and that the error they used to see by hand-retrying is now handled).
    if (pullRetries > 0) {
      strategyNotes.push(`[dashboard] transient network error — auto-retry succeeded (retry #${pullRetries})`);
    }

    let after = '';
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: project.path,
        timeout: 15000,
        maxBuffer: 1024 * 512,
      });
      after = stdout.trim();
    } catch { /* unborn HEAD */ }

    const output = [
      switchedTo ? `[dashboard] switched to branch '${switchedTo}'` : '',
      originRepaired ? `[dashboard] ${originRepaired} → ${sanitizeUrl(project.repoUrl)}` : '',
      ...strategyNotes,
      (stdout || stderr || '').trim(),
    ].filter(Boolean).join('\n');
    // Locale-independent up-to-date detection: git output text ("Already up
    // to date") only works on English git installs; identical before/after
    // SHAs is the ground truth.
    const upToDate = /Already up to date/i.test(output) || (before !== '' && before === after);
    const range = before && after && before !== after ? ` (${before} → ${after})` : '';

    // Fresh HEAD now matches the remote — drop the stale "behind" hint.
    invalidateUpdateCache([project.id]);

    // Stash strategy, final step — re-apply the user's local changes on top
    // of the pulled code. A conflicting pop does NOT fail the pull: the code
    // IS updated and the changes are safe in the stash entry (git keeps it);
    // surface stashConflict so the UI can tell the user exactly that.
    let stashConflict = false;
    let stashPartial = false;
    let stashDetail = '';
    if (stashedForPull) {
      const pop = await popStash(project.path);
      if (pop.ok) {
        strategyNotes.push('[dashboard] re-applied stashed local changes');
        if (pop.partial) {
          stashPartial = true;
          stashDetail = pop.detail;
          strategyNotes.push(`[dashboard] ${pop.detail}`);
        }
      } else {
        stashConflict = true;
        stashDetail = pop.detail;
      }
    }

    await logActivity({
      type: 'pull',
      level: stashConflict ? 'warn' : 'success',
      message: `Pulled ${project.name}${switchedTo ? ` → ${switchedTo}` : ''}${range}`,
      projectId: project.id,
      projectName: project.name,
      detail: stashConflict
        ? `Pulled, but restoring the stashed local changes hit conflicts — they are kept in the git stash (${stashDetail.slice(0, 200)})`
        : stashPartial
          ? `Pulled; local changes re-applied (${stashDetail.slice(0, 200)})`
          : upToDate ? 'Already up to date' : output.split('\n').slice(-3).join(' · ').slice(0, 300),
    });

    return NextResponse.json({
      ok: true,
      upToDate,
      before,
      after,
      ...(pullRetries > 0 ? { retried: pullRetries } : {}),
      ...(switchedTo ? { switchedTo } : {}),
      ...(stashedForPull ? { stashRestored: !stashConflict } : {}),
      ...(stashPartial ? { stashPartial, stashDetail: stashDetail.slice(0, 600) } : {}),
      ...(stashConflict ? { stashConflict, stashDetail: stashDetail.slice(0, 600) } : {}),
      summary: (upToDate ? 'Already up to date' : before || after ? `${before} → ${after}` : 'done')
        + (switchedTo ? ` @ ${switchedTo}` : ''),
      output: [...strategyNotes, (stdout || stderr || '').trim()].filter(Boolean).join('\n').slice(0, 4000),
    });
  } catch (e: any) {
    const detail = String(e?.stderr || e?.stdout || e?.message || '').trim().slice(0, 400);

    // Stash strategy, failure path — restore the user's changes before
    // reporting (nothing was lost, the tree is back to its pre-pull state).
    if (stashedForPull) await popStash(project.path).catch(() => {});

    // The blocked-by-local-changes class becomes a 409 carrying the exact
    // file lists — the UI opens the conflict dialog (stash / discard /
    // cancel) instead of dead-ending on git's raw stderr.
    const cf = parsePullConflict(String(e?.stderr || e?.stdout || e?.message || ''));
    if (cf) {
      await logActivity({
        type: 'pull',
        level: 'warn',
        message: `Pull blocked by local changes: ${project.name}`,
        projectId: project.id,
        projectName: project.name,
        detail: [...cf.modified, ...cf.untracked].slice(0, 20).join(', ').slice(0, 300),
      });
      return NextResponse.json(
        {
          error: 'Local changes block the pull',
          conflict: true,
          modified: cf.modified,
          untracked: cf.untracked,
          detail: detail || undefined,
          hint: 'Stash the local changes (kept, restored after the pull) or discard them and take the remote version',
        },
        { status: 409 },
      );
    }

    await logActivity({
      type: 'pull',
      level: 'error',
      message: `Pull failed: ${project.name}`,
      projectId: project.id,
      projectName: project.name,
      detail: detail || 'git pull error',
    });
    // Transient-network class: every auto-retry attempt failed too — the
    // classic "click again and it works" situation, just rarer now. Flag it
    // so the UI can say "try again in a moment" instead of a scary error.
    const transientNet = isTransientGitNetworkError(e);
    return NextResponse.json(
      {
        error: 'git pull failed',
        detail: detail || undefined,
        repo: sanitizeUrl(project.repoUrl),
        ...(transientNet ? { transient: true } : {}),
      },
      { status: 500 },
    );
  }
}

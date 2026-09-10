/**
 * exec tool — run shell commands inside the project directory.
 *
 * Why this tool exists:
 *   The repair agent needs to install missing dependencies, regenerate
 *   Prisma clients, etc. But executing arbitrary shell from an LLM is
 *   dangerous, so this tool layers:
 *
 *     1. Allowlist check (SAFE_REPAIR_PREFIXES from safety.ts).
 *     2. Dangerous-pattern check (rm -rf, sudo, cd, fork bombs, …).
 *     3. When a command fails either check, returns needsApproval: true
 *        with a structured reason. The agent loop is responsible for
 *        pausing the job and surfacing an approve/deny panel; when the
 *        human approves, the loop calls back with approved: true.
 *     4. Sanitized env (no Next.js internals, no DATABASE_URL leak).
 *     5. Bounded stdout/stderr capture (4KB each) to keep token usage low.
 *
 * Safety invariants this tool preserves:
 *   - Never blocks the agent loop: the approval handoff is a structured
 *     response, not a blocking UI prompt.
 *   - Never invokes the shell directly: the command is checked first, then
 *     run via runShellProcess with the project's cwd and sanitized env.
 *   - Never sends Authorization / Cookie headers — that's the health tool's job.
 *
 * Runtime hardening (why runShellProcess exists and Node's exec() is not
 * used for the actual run): exec()'s built-in timeout only kills the shell
 * process itself — grandchildren (the actual build/test workers) survive,
 * keep running, and hold locks. That is exactly how a stuck
 * `npm run build` kept holding .next/dev/lock in the incident that
 * triggered the agent rewrite: the "timed out" build left a live build
 * process behind, and every subsequent build deadlocked. runShellProcess
 * spawns the command as its own process-group leader (detached) and, on
 * timeout, SIGTERMs (then SIGKILLs) the WHOLE group.
 */

import { spawn } from 'child_process';
import { buildChildEnv, classifyRepairCommand } from './safety';
// Tree kill — kill(-pid) process-group signals are a POSIX concept that
// throws on Windows, so a timed-out command was never actually killed there.
import { killTree } from '../../port-utils';

const STDOUT_CAP = 4_000;
const STDERR_CAP = 4_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 240_000;

// Interactive pagers / editors / window-openers hang forever in a headless
// shell (stdio stdin is 'ignore' — `more` still waits on some platforms,
// notepad/vim block on a console that doesn't exist). The incident log showed
// `type build.log | more +9999` burning a 10s timeout step. Match the token
// only as a command start or after a pipe/sequence separator so quoted
// strings containing e.g. "more" mid-command don't false-positive.
const INTERACTIVE_CMD_RE = /(?:^|[|;&]\s*)(more|less|man|view|vim|vi|nano|emacs|notepad|code|start|ed)\b/i;

// ---- Shared envelope --------------------------------------------------

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

// ---- Structured outcome ------------------------------------------------
//
// Returned to the LLM. The four-state shape lets the agent decide what to
// do without parsing free-form error strings.

export type ExecOutcome =
  | {
      kind: 'ran';
      exitCode: number;
      stdout: string;
      stdoutTruncated: boolean;
      stderr: string;
      stderrTruncated: boolean;
      durationMs: number;
      timedOut: false;
    }
  | {
      kind: 'timed-out';
      durationMs: number;
      stdout: string;
      stdoutTruncated: boolean;
      stderr: string;
      stderrTruncated: boolean;
      timedOut: true;
    }
  | {
      kind: 'spawn-failed';
      error: string;
    };

// ---- Validation -------------------------------------------------------

function clampTimeout(ms: number | undefined): number {
  if (!Number.isFinite(ms) || (ms as number) <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(ms as number, MAX_TIMEOUT_MS);
}

// ---- Hardened process runner -------------------------------------------

export interface ShellResult {
  exitCode: number | 'TIMEOUT' | 'ERROR';
  signal?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  err?: string;
}

/**
 * Run a shell command with a HARD timeout that kills the whole process
 * group (spawn detached → kill(-pid)). Node exec()'s timeout only kills
 * the shell, orphaning grandchildren — exactly how a stuck `npm run build`
 * kept holding the build lock in the incident that triggered this.
 *
 * Exported because the repair agent's rebuild path (run_retry →
 * `npm run build`) needs the same group-kill guarantee with different
 * output caps and a longer timeout than execTool allows.
 */
export function runShellProcess(
  cmd: string,
  opts: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    stdoutCap?: number;
    stderrCap?: number;
  },
): Promise<ShellResult> {
  const stdoutCap = opts.stdoutCap ?? 256 * 1024;
  const stderrCap = opts.stderrCap ?? 256 * 1024;
  return new Promise<ShellResult>((resolveRun) => {
    const started = Date.now();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, {
        shell: true,
        cwd: opts.cwd,
        env: opts.env,
        detached: true, // own process group → we can kill(-pid) the whole tree
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true, // no console-window flash on the user's desktop
      });
    } catch (e: unknown) {
      resolveRun({
        exitCode: 'ERROR',
        stdout: '',
        stderr: '',
        durationMs: 0,
        err: String((e as Error)?.message || e),
      });
      return;
    }
    let out = '';
    let errOut = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole tree: on Windows kill(-pid) throws and NOTHING dies
      // (taskkill /T /F is the only reliable group kill there); on Unix the
      // group signal fires exactly as before.
      killTree(child.pid);
      setTimeout(() => killTree(child.pid, true), 4000);
    }, opts.timeoutMs);
    const finish = (r: ShellResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(r);
    };
    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < stdoutCap) out += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (errOut.length < stderrCap) errOut += d.toString();
    });
    child.on('error', (e: Error) => {
      finish({
        exitCode: 'ERROR',
        stdout: out,
        stderr: errOut,
        durationMs: Date.now() - started,
        err: String(e?.message || e),
      });
    });
    child.on('close', (code, signal) => {
      finish({
        exitCode: timedOut ? 'TIMEOUT' : code ?? (signal ? 127 : 0),
        signal: signal ?? undefined,
        stdout: out.length >= stdoutCap ? `${out}\n…(stdout truncated)` : out,
        stderr: errOut.length >= stderrCap ? `${errOut}\n…(stderr truncated)` : errOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

// ---- Approval-required detection --------------------------------------
//
// The tool itself never blocks waiting for human input. When a command
// needs approval, it returns a structured "needs approval" envelope and
// the agent loop is responsible for pausing the job (via the existing
// requestApproval flow in llm-repair.ts) and re-calling with approved: true.

export interface ExecArgs {
  action: 'run';
  cmd: string;
  /** Timeout in ms. Default 60000, max 240000. */
  timeoutMs?: number;
  /** Set by the agent loop AFTER a human approved this exact command —
   *  skips the classification (the approval IS the classification). */
  approved?: boolean;
}

export type ExecToolResponse =
  | { ok: true; outcome: ExecOutcome; needsApproval: false }
  | {
      ok: true;
      needsApproval: true;
      cmd: string;
      reason: 'dangerous-pattern' | 'unknown-prefix' | 'too-long' | 'empty';
      detail?: string;
    }
  | { ok: false; error: string };

/**
 * Run (or refuse to run) a shell command.
 * @param args        Tool arguments from the LLM.
 * @param projectPath Absolute path of the env's project — used as cwd.
 */
export async function execTool(args: ExecArgs, projectPath: string): Promise<ExecToolResponse> {
  if (args.action !== 'run') {
    return { ok: false, error: `Unknown action: ${String((args as { action?: string }).action)}` };
  }
  if (typeof args.cmd !== 'string') {
    return { ok: false, error: 'cmd must be a string' };
  }

  // Hard-refuse interactive commands BEFORE classification/execution — they
  // don't need human approval, they need to not run at all (they would hang
  // until the timeout and waste a whole repair step + a timeout kill cycle).
  if (INTERACTIVE_CMD_RE.test(args.cmd)) {
    return {
      ok: false,
      error:
        'Interactive pager/editor/window command refused — it hangs forever without a keyboard and burns a full timeout cycle. Read files with the inspect tool (read mode; *.log defaults to tail) instead of `more`/`less`/editors.',
    };
  }

  if (args.approved !== true) {
    const decision = classifyRepairCommand(args.cmd);
    if (!decision.safe) {
      return {
        ok: true,
        needsApproval: true,
        cmd: args.cmd,
        reason: decision.reason as 'dangerous-pattern' | 'unknown-prefix' | 'too-long' | 'empty',
        detail: decision.detail,
      };
    }
  }

  const timeoutMs = clampTimeout(args.timeoutMs);
  const r = await runShellProcess(args.cmd, {
    cwd: projectPath,
    timeoutMs,
    env: buildChildEnv(),
    stdoutCap: STDOUT_CAP,
    stderrCap: STDERR_CAP,
  });

  if (r.exitCode === 'ERROR') {
    return { ok: true, needsApproval: false, outcome: { kind: 'spawn-failed', error: (r.err || 'spawn failed').slice(0, 500) } };
  }
  if (r.exitCode === 'TIMEOUT') {
    return {
      ok: true,
      needsApproval: false,
      outcome: {
        kind: 'timed-out',
        durationMs: r.durationMs,
        stdout: r.stdout,
        stdoutTruncated: false, // runShellProcess already capped + marked
        stderr: r.stderr,
        stderrTruncated: false,
        timedOut: true,
      },
    };
  }
  return {
    ok: true,
    needsApproval: false,
    outcome: {
      kind: 'ran',
      exitCode: r.exitCode,
      stdout: r.stdout,
      stdoutTruncated: r.stdout.includes('…(stdout truncated)'),
      stderr: r.stderr,
      stderrTruncated: r.stderr.includes('…(stderr truncated)'),
      durationMs: r.durationMs,
      timedOut: false,
    },
  };
}

// ---- Tool schema (for the LLM tool-call prompt) -----------------------

export const EXEC_TOOL_SCHEMA = {
  name: 'exec',
  description:
    'Run a shell command inside the project directory. Commands whose first token is not in the allowlist (npm, yarn, pnpm, bun, python, node, make, sed, echo, ls, cat, ps, …) are returned as needsApproval and held for a human to approve. Dangerous patterns (rm -rf, sudo, cd, fork bombs, /etc writes, …) are always refused. On timeout the whole process group is killed — no orphaned build workers. stdout and stderr are capped at 4KB each to keep token usage low.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['run'],
        description: 'Always "run" for this tool.',
      },
      cmd: {
        type: 'string',
        description:
          'The shell command to execute. Limited to 400 chars. Avoid sudo, cd, rm -rf. Prefer minimal fixes like "npm install <pkg>" or "sed -i ...".',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in ms. Default 60000, max 240000. On timeout the entire process group is terminated.',
      },
    },
    required: ['action', 'cmd'],
  },
} as const;

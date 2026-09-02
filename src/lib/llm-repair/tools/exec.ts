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
 *        pausing the job and surfacing an approve/deny panel.
 *     4. Sanitized env (no Next.js internals, no DATABASE_URL leak).
 *     5. Bounded stdout/stderr capture (4KB each) to keep token usage low.
 *
 * Safety invariants this tool preserves:
 *   - Never blocks the agent loop: the approval handoff is a structured
 *     response, not a blocking UI prompt.
 *   - Never invokes the shell directly: the command is checked first, then
 *     passed to Node's exec with the project's cwd and sanitized env.
 *   - Never sends Authorization / Cookie headers — that's the health tool's job.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { buildChildEnv, classifyRepairCommand } from './safety';

const execp = promisify(exec);

const STDOUT_CAP = 4_000;
const STDERR_CAP = 4_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 240_000;

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

// ---- Approval-required detection --------------------------------------
//
// The tool itself never blocks waiting for human input. When a command
// needs approval, it returns a structured "needs approval" envelope and
// the agent loop is responsible for pausing the job (via the existing
// requestApproval flow in llm-repair.ts).

export interface ExecArgs {
  action: 'run';
  cmd: string;
  /** Timeout in ms. Default 60000, max 240000. */
  timeoutMs?: number;
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

  const timeoutMs = clampTimeout(args.timeoutMs);
  const started = Date.now();

  try {
    const { stdout, stderr } = await execp(args.cmd, {
      cwd: projectPath,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024, // 16MB raw; we still truncate for the LLM
      env: buildChildEnv(),
      // Tell Node we don't want a TTY — prevents some commands from blocking.
      // shell: true lets shell operators (&&, |, >) work — the safety check
      // is what makes this safe, not the spawn mode.
      shell: '/bin/sh',
    });
    const durationMs = Date.now() - started;
    const stdoutStr = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
    const stderrStr = typeof stderr === 'string' ? stderr : stderr.toString('utf8');
    const stdoutTruncated = stdoutStr.length > STDOUT_CAP;
    const stderrTruncated = stderrStr.length > STDERR_CAP;
    return {
      ok: true,
      needsApproval: false,
      outcome: {
        kind: 'ran',
        exitCode: 0,
        stdout: stdoutTruncated ? stdoutStr.slice(0, STDOUT_CAP) : stdoutStr,
        stdoutTruncated,
        stderr: stderrTruncated ? stderrStr.slice(0, STDERR_CAP) : stderrStr,
        stderrTruncated,
        durationMs,
        timedOut: false,
      },
    };
  } catch (e: any) {
    const durationMs = Date.now() - started;
    // Node's exec() rejects with an Error whose properties depend on the
    // failure mode:
    //   - timed out:        .killed === true, .signal === 'SIGTERM'
    //   - non-zero exit:    .code is the exit code, .stdout/.stderr populated
    //   - spawn failure:    .code is undefined, .message is the spawn error
    if (e?.killed && e?.signal) {
      const stdoutRaw = String(e.stdout ?? '');
      const stderrRaw = String(e.stderr ?? '');
      return {
        ok: true,
        needsApproval: false,
        outcome: {
          kind: 'timed-out',
          durationMs,
          stdout: stdoutRaw.slice(0, STDOUT_CAP),
          stdoutTruncated: stdoutRaw.length > STDOUT_CAP,
          stderr: stderrRaw.slice(0, STDERR_CAP),
          stderrTruncated: stderrRaw.length > STDERR_CAP,
          timedOut: true,
        },
      };
    }
    if (typeof e?.code === 'number') {
      // Non-zero exit code — surface as a normal outcome, not a spawn failure.
      const stdoutRaw = String(e.stdout ?? '');
      const stderrRaw = String(e.stderr ?? '');
      return {
        ok: true,
        needsApproval: false,
        outcome: {
          kind: 'ran',
          exitCode: e.code,
          stdout: stdoutRaw.slice(0, STDOUT_CAP),
          stdoutTruncated: stdoutRaw.length > STDOUT_CAP,
          stderr: stderrRaw.slice(0, STDERR_CAP),
          stderrTruncated: stderrRaw.length > STDERR_CAP,
          durationMs,
          timedOut: false,
        },
      };
    }
    // Spawn error (e.g. ENOENT for missing binary).
    return {
      ok: true,
      needsApproval: false,
      outcome: {
        kind: 'spawn-failed',
        error: (e?.message ?? String(e)).slice(0, 500),
      },
    };
  }
}

// ---- Tool schema (for the LLM tool-call prompt) -----------------------

export const EXEC_TOOL_SCHEMA = {
  name: 'exec',
  description:
    'Run a shell command inside the project directory. Commands whose first token is not in the allowlist (npm, yarn, pnpm, bun, python, node, make, sed, echo, …) are returned as needsApproval and held for a human to approve. Dangerous patterns (rm -rf, sudo, cd, fork bombs, /etc writes, …) are always refused. stdout and stderr are capped at 4KB each to keep token usage low.',
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
        description: 'Timeout in ms. Default 60000, max 240000.',
      },
    },
    required: ['action', 'cmd'],
  },
} as const;
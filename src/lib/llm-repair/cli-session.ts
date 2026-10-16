/**
 * Generic CLI session runner (v1.34) — one headless invocation of a local
 * agent CLI against a task dotfile, shared by the feature-engine
 * delegations:
 *
 *   · analysisMode = 'cli'  →  POST /api/projects/:id/analyze-cli
 *   · pullMode     = 'cli'  →  POST /api/projects/:id/pull-cli
 *
 * The repair engine keeps its own multi-round loop (runCliRepair) because
 * it needs per-round verification + feedback; this module is the single-
 * shot building block everything else can reuse:
 *
 *   write task file → buildCommand(exe, taskFile) → shell spawn (timeout,
 *   compatibility fallback) → transcript archive → structured result.
 *
 * The CLI preference is the SAME one configured in the LLM settings dialog
 * (LlmConfig.repairCli — 'auto' / a catalog id / 'custom:template'):
 * one "本机 Agent CLI" concept, three delegations.
 */

import { existsSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db';
import { buildChildEnv } from './tools/safety';
import { runShellProcess } from './tools/exec';
import { stripAnsiAndControls } from './tools/text';
import {
  resolveRepairCli,
  expandCustomTemplate,
  saveTranscript,
  parseCliSummary,
  type ResolvedCli,
} from './cli-delegate';

// ============================= resolution =============================

/** Resolve the CLI configured in the LLM settings (shared with repair).
 * Returns null when none is usable — callers decide their own fallback. */
export async function resolveConfiguredCli(): Promise<ResolvedCli | null> {
  try {
    const cfg = await db.llmConfig.findUnique({ where: { id: 'default' } });
    if (!cfg) return null;
    return resolveRepairCli(String(cfg.repairCli ?? ''));
  } catch {
    return null;
  }
}

// ============================= session =============================

export interface CliSessionResult {
  /** The CLI produced output and exited cleanly (exit 0). A non-zero exit
   * still carries stdout — verification is the CALLER's job (mirrors the
   * repair engine: "交由独立健康验证判定"). */
  ok: boolean;
  exitCode: number | 'ERROR' | 'TIMEOUT' | null;
  stdout: string;
  stderr: string;
  /** Best-effort one-liner from the final JSON envelope (claude-style). */
  summary: string;
  /** Startup failure / timeout reason (empty when the run completed). */
  error: string;
  /** Archived full-output log path ('' on archival failure). */
  transcriptFile: string;
  /** The primary shell command actually executed (for activity logs). */
  command: string;
  cli: { id: string; label: string } | null;
}

export interface RunCliSessionOptions {
  projectPath: string;
  /** Task dotfile name, RELATIVE to projectPath (CLI cwd = project root). */
  taskFile: string;
  /** Full text content written to the task file. */
  taskContent: string;
  /** Wall-clock budget for the whole invocation. */
  timeoutMs: number;
  /** Transcript filename prefix, e.g. 'analysis' / 'pull' / <projectId>. */
  tag: string;
}

/** One delegated CLI invocation. Throws NEVER — every failure mode comes
 * back as a structured result so routes can answer JSON, never HTML. */
export async function runCliSession(opts: RunCliSessionOptions): Promise<CliSessionResult> {
  const empty: CliSessionResult = {
    ok: false, exitCode: null, stdout: '', stderr: '', summary: '',
    error: '', transcriptFile: '', command: '', cli: null,
  };

  const cli = await resolveConfiguredCli();
  if (!cli) {
    return { ...empty, error: 'no-cli' };
  }

  const taskAbs = join(opts.projectPath, opts.taskFile);
  try {
    writeFileSync(taskAbs, opts.taskContent, 'utf8');
  } catch (e: unknown) {
    return {
      ...empty,
      cli: { id: cli.id, label: cli.label },
      error: `cannot write task file (${opts.taskFile}): ${String((e as Error)?.message || e).slice(0, 200)}`,
    };
  }

  try {
    let invocation = cli.buildCommand(cli.exe, opts.taskFile);
    if (cli.id === 'custom') {
      invocation = { primary: expandCustomTemplate(invocation.primary, opts.taskFile, taskAbs) };
    }

    const runOpts = {
      cwd: opts.projectPath,
      timeoutMs: opts.timeoutMs,
      env: buildChildEnv(),
      stdoutCap: 2 * 1024 * 1024,
      stderrCap: 256 * 1024,
    };
    let r = await runShellProcess(invocation.primary, runOpts);

    // Spawn failure / flag rejection → one retry with the compatibility
    // template (same refusal heuristic as the repair engine).
    const refused = r.exitCode === 'ERROR' ||
      (typeof r.exitCode === 'number' && r.exitCode !== 0 &&
        /dangerously|permission|bypass|not accepted|unknown option|unrecognized|invalid/i.test(r.stderr || ''));
    if (refused && invocation.fallback) {
      r = await runShellProcess(invocation.fallback, runOpts);
    }

    const clean = stripAnsiAndControls(`${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`).text;
    const transcriptFile = saveTranscript(`${opts.tag}-${Date.now()}`, 1, invocation.primary, clean);
    const summary = parseCliSummary(r.stdout || '');

    let error = '';
    if (r.exitCode === 'TIMEOUT') {
      error = `Agent CLI timed out after ${Math.round(opts.timeoutMs / 60000)} min and was terminated`;
    } else if (r.exitCode === 'ERROR') {
      error = `Agent CLI failed to start: ${String(r.err || r.stderr || '').slice(0, 300)}`;
    }

    return {
      ok: typeof r.exitCode === 'number' && r.exitCode === 0 && !!(r.stdout || '').trim(),
      exitCode: r.exitCode,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      summary,
      error,
      transcriptFile,
      command: invocation.primary,
      cli: { id: cli.id, label: cli.label },
    };
  } finally {
    // Never leave the task dotfile in the user's project.
    try {
      if (existsSync(taskAbs)) rmSync(taskAbs);
    } catch { /* best effort */ }
  }
}

// ============================= output parsing =============================

/** Unwrap a claude-style JSON envelope ({"result": "…"}) when present —
 * CLIs that run with --output-format json wrap their payload this way. */
function unwrapEnvelope(text: string): string | null {
  const raw = (text || '').trim();
  if (!raw) return null;
  const tryObj = (s: string): string | null => {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object' && typeof obj.result === 'string' && obj.result.trim()) {
        return obj.result;
      }
    } catch { /* not this candidate */ }
    return null;
  };
  const direct = tryObj(raw);
  if (direct) return direct;
  const start = raw.lastIndexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const nested = tryObj(raw.slice(start, end + 1));
    if (nested) return nested;
  }
  return null;
}

/** Extract the first JSON value embedded in CLI text: the (possibly
 * envelope-wrapped) payload is probed for a fenced ```json block, then a
 * bare document, then the outermost object/array span. Returns null when
 * nothing parses — callers turn that into their own fallback. */
export function extractJson<T = unknown>(text: string): T | null {
  const raw = (text || '').trim();
  if (!raw) return null;
  const candidates = [unwrapEnvelope(raw), raw].filter((c): c is string => !!c && c.trim().length > 0);
  for (const c of candidates) {
    const fenced = c.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try { return JSON.parse(fenced[1].trim()) as T; } catch { /* next probe */ }
    }
    try { return JSON.parse(c.trim()) as T; } catch { /* next probe */ }
    const spans: Array<[number, number]> = [];
    const objStart = c.indexOf('{');
    const objEnd = c.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) spans.push([objStart, objEnd]);
    const arrStart = c.indexOf('[');
    const arrEnd = c.lastIndexOf(']');
    if (arrStart >= 0 && arrEnd > arrStart) spans.push([arrStart, arrEnd]);
    for (const [s, e] of spans) {
      try { return JSON.parse(c.slice(s, e + 1)) as T; } catch { /* next span */ }
    }
  }
  return null;
}

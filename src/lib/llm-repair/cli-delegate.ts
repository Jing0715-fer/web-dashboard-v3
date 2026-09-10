/**
 * CLI-delegated repair engine — the alternative to the legacy tool loop
 * (repair-agent.ts). Selected via LlmConfig.repairMode = 'cli' in the LLM
 * settings dialog.
 *
 * Why this exists (the SciWrite incident trilogy):
 *   The legacy loop is only as good as its own tool harness — 11 broken-JSON
 *   turns, 4/5 blind-patch failures and two sandbox allowlist walls showed
 *   that the *harness* (read/patch/exec protocol), not the diagnosis, was the
 *   bottleneck. Mature agent CLIs (Claude Code, Codex, Hermes, …) ship a
 *   hardened harness of their own: real file reads, anchored edits, full
 *   shells, token-turn budgets.
 *
 * Architecture (orchestrator keeps the hard authority, CLI does the fixing):
 *
 *   1. detect    — locate installed agent CLIs on PATH (where/which + --version)
 *   2. assemble  — write a self-contained repair TASK FILE into the project
 *                  dir: failure report, decoded logs, pre-flight facts,
 *                  package summary, health target, NON-NEGOTIABLE constraints
 *   3. delegate  — invoke the CLI headless (shell pipe / prompt-file reference)
 *                  with a hard wall-clock timeout; whole process group is
 *                  killed on expiry; full transcript archived to disk
 *   4. guardrails— ignoreBuildErrors flip detection + git working-tree
 *                  changes surfaced for human review
 *   5. verify    — the ORCHESTRATOR runs the same build+start+port-poll
 *                  verification the legacy loop trusts (toolRunRetry).
 *                  The CLI's own "I fixed it" claim is never trusted.
 *   6. feedback  — verification failed → append the failure to the task file
 *                  and re-run (CLI_ROUNDS total)
 *
 * Fallback contract: when no CLI is installed, llm-repair.ts logs a warning
 * and runs the LEGACY tool loop instead — 'legacy' is never removed.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { IS_WINDOWS } from '@/lib/port-utils';
import { getLogs } from '@/lib/process-manager';
import { buildChildEnv } from './tools/safety';
import { runShellProcess } from './tools/exec';
import { stripAnsiAndControls } from './tools/text';
import {
  loadEnvSnapshot,
  preflight,
  probePort,
  toolRunRetry,
  readPackageJsonSummary,
  readTopLevelFiles,
  type AgentHelpers,
  type AgentOutcome,
  type EnvSnapshot,
} from '../repair-agent';
import type { RepairJob, StartRepairOptions } from '../llm-repair';

const execFileAsync = promisify(execFile);

// ============================= tunables =============================

/** How many CLI rounds (delegate → verify) before giving up. Each failed
 * round appends the verifier's failure output to the task file so the CLI
 * starts round N+1 grounded in what actually went wrong. */
export const CLI_ROUNDS = 2;

/** Hard wall-clock budget per CLI invocation. A real repair (diagnose +
 * patch + build) legitimately takes minutes; 10 min matches the legacy
 * rebuild path's 5 min build + retry margins. On expiry the whole process
 * group is killed — no orphaned CLI workers. */
export const CLI_ROUND_TIMEOUT_MS = 10 * 60_000;

/** Transcript / task-file naming. The task file is a dotfile INSIDE the
 * project (the CLI's cwd is the project root, so argv CLIs get a space-free
 * RELATIVE path and pipe CLIs get `type/cat .dashboard-repair-task.md` —
 * no Windows quoting traps either way). Removed on every exit path. */
const TASK_FILE_NAME = '.dashboard-repair-task.md';
const TRANSCRIPT_DIR = () => join(os.tmpdir(), 'dashboard-repair');

// ============================= CLI catalog =============================

export interface CliInvocation {
  primary: string;
  /** Compatibility fallback when the primary fails to even start (or dies
   * with a flag/permission error) — usually a softer permission mode. */
  fallback?: string;
}

export interface CliSpec {
  id: string;
  label: string;
  /** Binary name to locate on PATH. */
  bin: string;
  /** Lower number = preferred when auto-detecting. */
  priority: number;
  /** Build the shell command. All commands run with cwd = project root. */
  buildCommand: () => CliInvocation;
}

const READ_TASK_ARG = `Read and execute the repair task file ${TASK_FILE_NAME} in the current directory, then perform the fix autonomously.`;

/** `cat` on Unix, `type` on Windows — reads the task file into the CLI's
 * stdin through a shell-level pipe (spawn stdin is 'ignore', but the SHELL
 * wires the pipe between the two commands itself). */
const pipeRead = () => (IS_WINDOWS ? 'type' : 'cat');

export const CLI_SPECS: CliSpec[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    priority: 1,
    buildCommand: () => ({
      // -p = headless print mode; prompt arrives via stdin pipe.
      // --output-format json → final envelope (result / is_error / num_turns).
      primary: `${pipeRead()} ${TASK_FILE_NAME} | claude -p --output-format json --max-turns 60 --dangerously-skip-permissions`,
      // Some installs gate the bypass flag behind an acceptance prompt —
      // retry once with the default permission mode (edits still auto-apply
      // in -p mode; unpermitted bash just fails per-command).
      fallback: `${pipeRead()} ${TASK_FILE_NAME} | claude -p --output-format json --max-turns 60`,
    }),
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    bin: 'codex',
    priority: 2,
    buildCommand: () => ({
      primary: `codex exec --dangerously-bypass-approvals-and-sandbox "${READ_TASK_ARG}"`,
      fallback: `codex exec --full-auto "${READ_TASK_ARG}"`,
    }),
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    priority: 3,
    buildCommand: () => ({
      // Non-interactive: gemini reads piped stdin as the prompt.
      primary: `${pipeRead()} ${TASK_FILE_NAME} | gemini`,
      fallback: `gemini "${READ_TASK_ARG}"`,
    }),
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    priority: 4,
    buildCommand: () => ({
      primary: `opencode run "${READ_TASK_ARG}"`,
    }),
  },
  {
    id: 'hermes',
    label: 'Hermes',
    bin: 'hermes',
    priority: 5,
    // Hermes CLI flags vary across forks/installers; the reference-prompt
    // form below is the common denominator. If your build differs, use a
    // custom:template with {promptFile} instead (see resolveRepairCli).
    buildCommand: () => ({
      primary: `hermes exec --auto-approve "${READ_TASK_ARG}"`,
      fallback: `hermes "${READ_TASK_ARG}"`,
    }),
  },
];

export interface ResolvedCli {
  id: string;
  label: string;
  buildCommand: () => CliInvocation;
}

// ============================= detection =============================

export interface DetectedCli {
  id: string;
  label: string;
  bin: string;
  found: boolean;
  version: string;
}

async function binOnPath(bin: string): Promise<boolean> {
  try {
    const finder = IS_WINDOWS ? 'where' : 'which';
    await execFileAsync(finder, [bin], { timeout: 8000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function binVersion(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    return (stdout || '').trim();
  } catch {
    return '';
  }
}

/** Locate every catalog CLI on PATH (parallel, with versions). Powers both
 * the /api/llm-config/detect-repair-cli route and the auto mode.
 *
 * Result is cached in-process for 60s: the LLM settings dialog fires this on
 * EVERY open (plus an explicit "detect" button), and on Windows each probe
 * spawns `where` + `<cli> --version` — npm-global CLIs can take seconds each.
 * Installation state does not flip within a minute, but a spam-refreshed
 * dialog previously re-paid the full spawn cost every time. */
const DETECT_CACHE_TTL_MS = 60_000;
let detectCache: { at: number; value: DetectedCli[] } | null = null;

export async function detectRepairClis(): Promise<DetectedCli[]> {
  if (detectCache && Date.now() - detectCache.at < DETECT_CACHE_TTL_MS) {
    return detectCache.value;
  }
  const specs = [...CLI_SPECS].sort((a, b) => a.priority - b.priority);
  const value = await Promise.all(
    specs.map(async (spec) => {
      const found = await binOnPath(spec.bin);
      const version = found ? await binVersion(spec.bin, ['--version']) : '';
      return {
        id: spec.id,
        label: spec.label,
        bin: spec.bin,
        found,
        version: version.split('\n')[0].slice(0, 80),
      };
    }),
  );
  detectCache = { at: Date.now(), value };
  return value;
}

/** Resolve the configured preference into a concrete CLI.
 *
 * Accepted preference values (validated at PUT time, re-validated here):
 *   ''                    → auto: first INSTALLED CLI by priority
 *   'claude' | 'codex' | …→ that specific CLI (null if not on PATH)
 *   'custom:<template>'   → admin-provided command template; must contain
 *                           {promptFile} (relative) or {promptFileAbs}
 * Returns null when nothing usable is installed — the caller falls back to
 * the legacy tool loop (and logs that it did). */
export async function resolveRepairCli(prefRaw: string): Promise<ResolvedCli | null> {
  const pref = (prefRaw || '').trim();
  if (pref.startsWith('custom:')) {
    const template = pref.slice('custom:'.length).trim();
    if (!template.includes('{promptFile') ) return null;
    return {
      id: 'custom',
      label: '自定义 CLI',
      buildCommand: () => ({ primary: template }),
    };
  }
  const detected = await detectRepairClis();
  if (!pref) {
    const first = detected.find((d) => d.found);
    if (!first) return null;
    const spec = CLI_SPECS.find((s) => s.id === first.id)!;
    return { id: spec.id, label: spec.label, buildCommand: spec.buildCommand };
  }
  const spec = CLI_SPECS.find((s) => s.id === pref);
  if (!spec) return null;
  const hit = detected.find((d) => d.id === spec.id);
  if (!hit?.found) return null;
  return { id: spec.id, label: spec.label, buildCommand: spec.buildCommand };
}

/** Substitute the task-file placeholders in a custom template. Raw paths —
 * the admin controls their own quoting in the template. */
function expandCustomTemplate(template: string, promptRel: string, promptAbs: string): string {
  return template
    .replaceAll('{promptFileAbs}', promptAbs)
    .replaceAll('{promptFile}', promptRel);
}

// ============================= task file =============================

function tailOf(text: string, max: number): string {
  const t = (text || '').replace(/\r\n/g, '\n').trim();
  return t.length > max ? t.slice(-max) : t;
}

/** The self-contained repair brief handed to the CLI. Everything the legacy
 * loop feeds the LLM across its first turn, plus the constraints the
 * orchestrator will enforce. */
function buildTaskFile(snap: EnvSnapshot, opts: StartRepairOptions, pre: string, feedback: string[]): string {
  const logs = getLogs(snap.projectId, snap.envName).slice(-50).join('\n');
  return `# Repair task: ${snap.projectName} · ${snap.envName}

## Mission
The ${snap.kind === 'rebuild' ? 'production REBUILD' : 'START'} of this environment failed. Diagnose the failure, fix it in this directory, and make the service run. You have full read/write/command access here — work autonomously. Do NOT ask questions; when the fix is done, finish and exit.

## Hard success criterion (verified independently)
The service must end up RUNNING with EXACTLY:
- start command: \`${snap.cmd}\`
- listening on port: ${snap.port}
The dashboard (your caller) will run that command itself and poll the port — a claimed-but-unverified fix counts as failure. If you believe the port or command must change, do NOT rely on that being adopted: adjust the PROJECT (its own config/env files) so the command above listens on ${snap.port}.

## Environment facts
- Project root (= your working directory): ${snap.projectPath}
- Platform: ${process.platform}${IS_WINDOWS ? ' — the shell is cmd.exe; Unix commands (rm/ls/cat/grep/ps/lsof) DO NOT exist. Use dir/type/tasklist/netstat or your own file tools.' : ''}
- envVars the dashboard injects at start: ${JSON.stringify(snap.envVars)}
- Failure kind: ${snap.kind === 'rebuild' ? 'production rebuild failed (build error or post-build start failure)' : 'start command failed'}

## Failure reported by the dashboard
${tailOf(opts.initialError || '(none)', 2000)}
${snap.kind === 'rebuild' && opts.buildStderr ? `\n### BUILD STDERR (tail)\n${tailOf(opts.buildStderr, 2500)}\n` : ''}
### Recent process logs (tail)
${logs ? tailOf(logs, 4000) : '(no logs)'}

### package.json (summary)
${readPackageJsonSummary(snap.projectPath)}

### Top-level files (dotfiles included)
${readTopLevelFiles(snap.projectPath)}

### Pre-flight facts (gathered by the dashboard just now)
${pre}

## Constraints (NON-NEGOTIABLE — the orchestrator checks these)
1. NEVER enable \`typescript.ignoreBuildErrors\`, remove type-checks, or otherwise silence errors to make a build pass. Fix the real error. (The dashboard detects this flip and fails the round.)
2. NEVER run git commit / git push / git checkout — leave every change in the working tree for human review. Read-only git (status/diff/log) is fine.
3. Ports 3000 and 3100-3105 belong to the dashboard itself — never bind, kill or "fix" anything on them.
4. Before running a production build, make sure no dev server is holding the build directory (.next/dev/lock etc.) — a build under a held lock deadlocks silently.
5. Keep changes minimal and surgical: prefer one precise patch over broad rewrites. Do not reformat or touch unrelated files.
6. If the build environment has no network (offline font/dependency downloads fail), prefer an offline-safe fix (local assets, system font stacks, vendored deps) over assuming network access.
${feedback.length ? `\n## Feedback from previous round(s) — read first, do not repeat failed approaches\n${feedback.map((f, i) => `### Round ${i + 1} result\n${f}`).join('\n')}\n` : ''}
Exit when done. The orchestrator verifies the port independently and will re-invoke you with the verifier's output if the fix did not hold.
`;
}

// ============================= guardrails =============================

/** Detect `ignoreBuildErrors: true` in next.config.* — constraint 1. */
function checkIgnoreBuildErrors(projectPath: string): boolean {
  for (const f of ['next.config.ts', 'next.config.js', 'next.config.mjs', 'next.config.cjs']) {
    const p = join(projectPath, f);
    if (!existsSync(p)) continue;
    try {
      const txt = readFileSync(p, 'utf8');
      if (/ignoreBuildErrors\s*:\s*true/.test(txt)) return true;
    } catch { /* unreadable → treat as unchanged */ }
  }
  return false;
}

/** Working-tree changes after the CLI ran — surfaced in the job log so a
 * human can review what the CLI touched (read-only git, no approval needed).
 * The task file itself is filtered out of the listing. */
async function gitReviewLines(projectPath: string): Promise<string> {
  if (!existsSync(join(projectPath, '.git'))) return '';
  try {
    const r = await runShellProcess('git status --porcelain && git diff --stat', {
      cwd: projectPath,
      timeoutMs: 15_000,
      env: buildChildEnv(),
      stdoutCap: 16_000,
      stderrCap: 2_000,
    });
    const out = stripAnsiAndControls(r.stdout || '').text
      .split('\n')
      .filter((l) => l && !l.includes(TASK_FILE_NAME))
      .join('\n')
      .trim();
    return out.slice(0, 1600);
  } catch {
    return '';
  }
}

// ============================= transcript =============================

function saveTranscript(jobId: string, round: number, cmd: string, text: string): string {
  try {
    const dir = TRANSCRIPT_DIR();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${jobId}-round${round}.log`);
    writeFileSync(file, `$ ${cmd}\n\n${text}`, 'utf8');
    return file;
  } catch {
    return '';
  }
}

/** Best-effort summary from a CLI's final output — Claude Code's JSON
 * envelope ({"result": "...", "is_error": false}) is the only structured
 * shape we know; everything else just gets its tail shown. Tolerates prose
 * lines around the JSON (CLIs often print progress before the envelope). */
function parseCliSummary(stdout: string): string {
  const raw = (stdout || '').trim();
  if (!raw) return '';
  let obj: any = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    // Mixed output: try the last { … } block (envelopes come last).
    const start = raw.lastIndexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        obj = JSON.parse(raw.slice(start, end + 1));
      } catch { /* not JSON — fine */ }
    }
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (typeof obj.result === 'string' && obj.result.trim()) {
      return `${obj.is_error === true ? '[CLI error] ' : '[CLI result] '}${obj.result.trim().slice(0, 300)}`;
    }
    if (typeof obj.subtype === 'string') return `[CLI ${obj.subtype}]`;
  }
  return '';
}

// ============================= engine =============================

/**
 * Run the CLI-delegated repair. Pre-conditions (enforced by the caller in
 * llm-repair.ts): `cli` was resolved (a usable CLI exists) and the job log
 * already announced the engine mode.
 */
export async function runCliRepair(
  job: RepairJob,
  opts: StartRepairOptions,
  helpers: AgentHelpers,
  cli: ResolvedCli,
): Promise<AgentOutcome> {
  const { log } = helpers;

  let snap = await loadEnvSnapshot(job);
  if (!snap) return { status: 'failed', error: 'Environment or project disappeared during repair' };
  job.projectName = snap.projectName;
  job.envName = snap.envName;

  const promptRel = TASK_FILE_NAME;
  const promptAbs = join(snap.projectPath, promptRel);
  const feedback: string[] = [];
  let lastError = opts.initialError || 'unknown error';
  const ignoreBefore = checkIgnoreBuildErrors(snap.projectPath);

  try {
    for (let round = 1; round <= CLI_ROUNDS; round++) {
      job.round = round;

      snap = await loadEnvSnapshot(job);
      if (!snap) return { status: 'failed', error: 'Environment or project disappeared during repair' };

      // Someone (the user, a previous round) may have fixed it already —
      // the same phantom-failure guard the legacy loop runs every step.
      if (snap.status === 'running') {
        const pf = await probePort(snap.port);
        if (pf.listening) {
          log('success', '环境已处于运行状态且端口健康 — 无需委托 CLI，修复结束');
          return { status: 'success' };
        }
        log('warn', `数据库标记运行中但端口 ${snap.port} 无监听 — 继续委托 CLI 修复`);
      }

      // ---- 1. assemble the context package ----
      log('info', `第 ${round}/${CLI_ROUNDS} 轮：组装上下文任务文件并委托 ${cli.label}…`);
      const pre = await preflight(snap);
      try {
        writeFileSync(promptAbs, buildTaskFile(snap, opts, pre, feedback), 'utf8');
      } catch (e: unknown) {
        return { status: 'failed', error: `无法写入任务文件（${promptRel}）: ${String((e as Error)?.message || e).slice(0, 200)}` };
      }

      // ---- 2. invoke headless (with compatibility fallback) ----
      let invocation = cli.buildCommand();
      // custom templates carry {promptFile} / {promptFileAbs} placeholders
      if (cli.id === 'custom') {
        invocation = { primary: expandCustomTemplate(invocation.primary, promptRel, promptAbs) };
      }
      // The dialog renders command-level steps with its own "$ " prefix.
      log('command', invocation.primary);
      let r = await runShellProcess(invocation.primary, {
        cwd: snap.projectPath,
        timeoutMs: CLI_ROUND_TIMEOUT_MS,
        env: buildChildEnv(),
        stdoutCap: 2 * 1024 * 1024,
        stderrCap: 256 * 1024,
      });

      // Spawn failure / flag rejection → one retry with the compatibility
      // template (softer permission mode). Claude Code gates
      // --dangerously-skip-permissions behind an acceptance prompt on some
      // installs; unknown-option exits look the same from here.
      const refused = r.exitCode === 'ERROR' ||
        (typeof r.exitCode === 'number' && r.exitCode !== 0 &&
          /dangerously|permission|bypass|not accepted|unknown option|unrecognized|invalid/i.test(r.stderr || ''));
      if (refused && invocation.fallback) {
        log('warn', '主命令无法启动或被拒绝 — 改用兼容回退模板重试');
        log('command', invocation.fallback);
        r = await runShellProcess(invocation.fallback, {
          cwd: snap.projectPath,
          timeoutMs: CLI_ROUND_TIMEOUT_MS,
          env: buildChildEnv(),
          stdoutCap: 2 * 1024 * 1024,
          stderrCap: 256 * 1024,
        });
      }

      // ---- 3. transcript: archive + tail into the job log ----
      const clean = stripAnsiAndControls(`${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`).text;
      const transcriptFile = saveTranscript(job.id, round, invocation.primary, clean);
      if (transcriptFile) log('info', `CLI 完整输出已存档: ${transcriptFile}`);
      const summary = parseCliSummary(r.stdout || '');
      if (summary) {
        job.diagnosis = summary.slice(0, 300);
        log('llm', `CLI 结果: ${job.diagnosis}`);
      }
      if (clean.trim()) log('output', tailOf(clean, 2200));

      if (r.exitCode === 'TIMEOUT') {
        lastError = `Agent CLI 超过 ${Math.round(CLI_ROUND_TIMEOUT_MS / 60000)} 分钟被强制终止`;
        log('error', lastError);
        feedback.push(`Round ${round}: killed after the ${Math.round(CLI_ROUND_TIMEOUT_MS / 60000)}-minute wall-clock timeout. Be faster and more surgical; finish the fix earlier.`);
        // fall through to verification — the CLI may have finished the fix
        // before hanging on something else.
      } else if (r.exitCode === 'ERROR') {
        lastError = `Agent CLI 无法启动: ${tailOf(r.err || r.stderr, 300)}`;
        log('error', lastError);
        feedback.push(`Round ${round}: the CLI command failed to start (${tailOf(r.err || r.stderr, 200)}).`);
      } else if (r.exitCode !== 0) {
        log('warn', `Agent CLI 退出码 ${r.exitCode} — 交由独立健康验证判定`);
      }

      // ---- 4. guardrails ----
      if (!ignoreBefore && checkIgnoreBuildErrors(snap.projectPath)) {
        log('error', '护栏违规：CLI 将 ignoreBuildErrors 打开以掩盖构建错误 — 已在反馈中要求其撤销');
        feedback.push(`Round ${round}: VIOLATION — you enabled \`ignoreBuildErrors: true\` in next.config to silence the build. REVERT it and fix the real error; the orchestrator re-checks this every round.`);
      }
      const gitLines = await gitReviewLines(snap.projectPath);
      if (gitLines) log('output', `git 工作区变更（供人工复核）:\n${tailOf(gitLines, 900)}`);

      // ---- 5. independent health verification ----
      log('info', '独立健康验证 — 面板自行重启并轮询端口（不信任 CLI 的自报）…');
      const v = await toolRunRetry(job, log, snap);
      if (v.outcome === 'success') {
        log('success', `修复流程结束（Agent CLI 模式 · ${cli.label}）— 成功`);
        return { status: 'success' };
      }
      lastError = v.error || tailOf(v.message, 300);
      if (round < CLI_ROUNDS) {
        feedback.push(
          `Round ${round} verification FAILED — the port was still not healthy after your changes.\nVerifier: ${tailOf(v.error || '', 400)}\n${tailOf(v.message, 1400)}\nAnalyze the ACTUAL error above and fix it this round.`,
        );
        log('warn', `第 ${round} 轮验证未通过 — 失败详情已附加到任务文件，进入下一轮`);
      }
    }

    return {
      status: 'failed',
      error: `Agent CLI 模式 ${CLI_ROUNDS} 轮后仍未通过健康验证: ${tailOf(lastError, 240)}`,
    };
  } finally {
    // Never leave the task file in the user's project.
    try {
      if (existsSync(promptAbs)) rmSync(promptAbs);
    } catch { /* best effort */ }
  }
}

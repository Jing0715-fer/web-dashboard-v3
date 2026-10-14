/**
 * Repair lessons + deterministic pattern fixes (v1.24).
 *
 * Two layers that both exist to raise the success rate of "environment
 * failed to start" WITHOUT spending an LLM call:
 *
 *   1. PATTERN FIXES — the failure text is matched against a small taxonomy
 *      of well-known startup failures (missing deps, corrupted build cache,
 *      missing .env) whose canonical fixes are deterministic shell steps
 *      (install per lockfile, clean .next, copy .env.example). These run
 *      FIRST, inside the repair job, before any engine is selected.
 *
 *   2. LESSONS — whatever fix ACTUALLY succeeded (pattern, replay, the
 *      legacy LLM loop, or a delegated CLI round) is persisted as a
 *      RepairLesson row (cmd/port/envVars at success + the fix commands
 *      that were observed). The NEXT failure of the same environment
 *      replays that lesson first: same error → same fix, instantly, no
 *      model call, no 10-minute CLI round.
 *
 * Everything here is strictly best-effort and additive: a lesson that no
 * longer works simply fails its replay and the repair escalates to the LLM
 * engines exactly as before. See skills/startup-repair/SKILL.md for the
 * full failure taxonomy this implements.
 */

import { existsSync, copyFileSync, rmSync } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db';
import { runShellProcess } from './llm-repair/tools/exec';
import { classifyRepairCommand, buildChildEnv } from './llm-repair/tools/safety';
import { isAutoCleanTarget, type AgentHelpers } from './repair-agent';

// ============================= error signatures =============================

/**
 * Canonical signature of a failure text. Coarsely normalized so the same
 * underlying problem yields the same signature across runs (PIDs, paths,
 * ports and numbers are stripped) while keeping the discriminating tokens
 * (module names, error codes).
 */
export function errorSignature(err: string): string {
  const text = String(err || '');
  // Known families first — they map to precise, replayable fixes.
  // NOTE: node prints the failure BOTH ways — "Cannot find module 'x'"
  // (message line) and code: 'MODULE_NOT_FOUND' (the error envelope the
  // start route's log-tail often keeps when the message line was truncated
  // out) — match both spellings. The module NAME is only captured from a
  // quoted form so surrounding prose ("Can't", stack frames) never leaks
  // into the signature.
  const mod = text.match(/(?:Cannot find module|Module not found|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)(?:\s+['"]([^'"\r\n]+)['"])?/i);
  if (mod) return `module-missing${mod[1] ? `:${mod[1].replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40)}` : ''}`;
  if (/panicked at[^\n]*turbo|static_sorted_file|Turbopack['’]?s filesystem cache has been deleted|internal error in Turbopack/i.test(text)) return 'cache-corruption';
  if (/EADDRINUSE|address already in use/i.test(text)) return 'port-in-use';
  if (/ELIFECYCLE.*Command failed|exit status \d+/i.test(text)) return 'lifecycle-failure';
  if (/SyntaxError|Unexpected token|Unexpected end of (JSON|input)/i.test(text)) return 'syntax-error';
  if (/missing required environment variable|process\.env\.\w+ is (undefined|required)/i.test(text)) return 'env-missing';
  if (/(?:sh: |'?'?\w+' is not recognized|command not found)\b/i.test(text)) return 'command-not-found';
  if (/EACCES|EPERM|permission denied/i.test(text)) return 'permission-denied';
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET/i.test(text)) return 'network-error';
  // Fallback: normalized raw tail (numbers/pids/paths collapsed).
  return 'raw:' + text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\/[^\s:]+\/([^\/\s]+)/g, '<path>/$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-140);
}

// ============================= pattern fixes =============================

/** What a matched pattern prescribes. All parts are advisory — the applier
 * logs every step and any single failure just fails the pattern attempt. */
export interface PatternFix {
  sig: string;
  /** Human-readable label shown in the repair dialog. */
  label: string;
  fixCmds: string[];
  cleanTargets: string[];
  copyEnvExample?: boolean;
}

/** Install command for a project, chosen by its lockfile (bun > pnpm > yarn >
 * npm). Mirrors what a human would run after cloning the repo. */
export function installCmdFor(projectPath: string): string {
  const has = (f: string) => existsSync(join(projectPath, f));
  if (has('bun.lock') || has('bun.lockb')) return 'bun install';
  if (has('pnpm-lock.yaml')) return 'pnpm install';
  if (has('yarn.lock')) return 'yarn install';
  return 'npm install';
}

/** Build-cache dirs that exist in the project right now (subset of the clean
 * whitelist) — only existing dirs are worth cleaning. */
function existingCacheDirs(projectPath: string): string[] {
  const candidates = ['.next', '.turbo', '.vite', '.nuxt', '.output', 'node_modules/.cache', 'node_modules/.vite'];
  try {
    return candidates.filter((d) => existsSync(join(projectPath, d)));
  } catch {
    return [];
  }
}

/**
 * Match a failure text against the deterministic fix taxonomy. Returns null
 * when nothing matches — the caller falls through to lesson replay / engines.
 */
export function matchPatternFix(errText: string, projectPath: string): PatternFix | null {
  const text = String(errText || '');
  if (!text.trim()) return null;
  const sig = errorSignature(text);

  if (sig.startsWith('module-missing')) {
    // Missing/uninstalled dependencies — by far the most common startup
    // failure after a fresh clone, a pull that touched the lockfile, or a
    // wiped node_modules. One install fixes it deterministically.
    // RELATIVE imports ('./config.js', '../lib/x') are missing SOURCE
    // files, not packages — an install cannot fix them, so leave them to
    // the engines instead of burning a multi-minute install first.
    const name = sig.slice('module-missing:'.length);
    if (name && (name.startsWith('.') || name.includes('/'))) return null;
    return {
      sig,
      label: '依赖缺失（Cannot find module）— 按锁文件重装依赖',
      fixCmds: [installCmdFor(projectPath)],
      cleanTargets: [],
    };
  }
  if (sig === 'cache-corruption') {
    // Turbopack/webpack persistent cache corruption — the cache directories
    // regenerate on next build, so deleting them is always safe.
    const targets = existingCacheDirs(projectPath);
    if (targets.length === 0) return null;
    return {
      sig,
      label: `构建缓存损坏 — 清理 ${targets.join(', ')} 后重建`,
      fixCmds: [],
      cleanTargets: targets,
    };
  }
  if (sig === 'env-missing') {
    // Required env vars absent and a template exists — copy it. Only when
    // .env is REALLY absent (never overwrite an existing one).
    const hasExample = existsSync(join(projectPath, '.env.example'));
    const hasEnv = existsSync(join(projectPath, '.env'));
    if (hasExample && !hasEnv) {
      return {
        sig,
        label: '缺少环境变量 — 从 .env.example 复制模板',
        fixCmds: [],
        cleanTargets: [],
        copyEnvExample: true,
      };
    }
    return null;
  }
  return null;
}

// ============================= fix application =============================

export interface FixRecipe {
  fixCmds?: string[];
  cleanTargets?: string[];
  copyEnvExample?: boolean;
}

/**
 * Apply a fix recipe deterministically, logging every step into the repair
 * job. Commands pass the SAME safety gate the LLM loop uses (no shell
 * pipelines, no rm -rf, …); a command that fails classification is skipped
 * with a warning instead of executed. Returns true when every step that
 * ran succeeded (a skipped-unsafe command counts as failure so the caller
 * falls through to the engines).
 */
export async function applyFixRecipe(
  recipe: FixRecipe,
  projectPath: string,
  helpers: AgentHelpers,
): Promise<boolean> {
  const { log } = helpers;
  let allOk = true;

  // 1. Clean whitelisted build-artifact dirs (rmSync, no shell — mirrors
  //    the legacy clean tool, same whitelist).
  for (const raw of recipe.cleanTargets || []) {
    const target = String(raw || '').trim();
    if (!target) continue;
    const abs = join(projectPath, target);
    if (!isAutoCleanTarget(projectPath, abs)) {
      log('warn', `清理目标 ${target} 不在构建产物白名单内 — 跳过（安全门）`);
      allOk = false;
      continue;
    }
    try {
      rmSync(abs, { recursive: true, force: true });
      log('success', `已清理 ${target}（下次启动将从零重建）`);
    } catch (e: unknown) {
      log('error', `清理 ${target} 失败: ${String((e as Error)?.message || e).slice(0, 160)}`);
      allOk = false;
    }
  }

  // 2. Copy .env.example → .env when prescribed and still absent.
  if (recipe.copyEnvExample) {
    const src = join(projectPath, '.env.example');
    const dst = join(projectPath, '.env');
    if (!existsSync(src)) {
      log('warn', '.env.example 不存在 — 无法复制模板');
      allOk = false;
    } else if (existsSync(dst)) {
      log('info', '.env 已存在 — 跳过模板复制');
    } else {
      try {
        copyFileSync(src, dst);
        log('success', '已从 .env.example 复制出 .env');
      } catch (e: unknown) {
        log('error', `复制 .env 模板失败: ${String((e as Error)?.message || e).slice(0, 160)}`);
        allOk = false;
      }
    }
  }

  // 3. Run fix commands through the safety gate.
  for (const raw of recipe.fixCmds || []) {
    const cmd = String(raw || '').trim();
    if (!cmd) continue;
    const verdict = classifyRepairCommand(cmd);
    if (!verdict.safe) {
      log('warn', `修复命令未通过安全门，跳过: ${cmd.slice(0, 120)}`);
      allOk = false;
      continue;
    }
    log('command', `$ ${cmd}`);
    try {
      const r = await runShellProcess(cmd, {
        cwd: projectPath,
        timeoutMs: 300_000, // installs can take a while — 5 min budget
        env: buildChildEnv(),
        stdoutCap: 32_000,
        stderrCap: 16_000,
      });
      const out = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
      if (out) log('output', out.slice(-600));
      if (r.exitCode === 0) {
        log('success', `${cmd} 完成`);
      } else {
        log('error', `${cmd} 退出码 ${String(r.exitCode)}`);
        allOk = false;
      }
    } catch (e: unknown) {
      log('error', `${cmd} 执行失败: ${String((e as Error)?.message || e).slice(0, 160)}`);
      allOk = false;
    }
  }

  return allOk;
}

// ============================= lesson persistence =============================

export interface LessonRecord {
  envId: string;
  projectId: string;
  errorSig: string;
  diagnosis: string;
  fixCmds: string[];
  cleanTargets: string[];
  cmd?: string | null;
  port?: number | null;
  envVars?: string | null;
  source: 'pattern' | 'lesson' | 'legacy' | 'cli';
}

/** Load the stored lesson for an environment (null when none). */
export async function loadLesson(envId: string) {
  try {
    return await db.repairLesson.findUnique({ where: { envId } });
  } catch {
    return null;
  }
}

/** Upsert the lesson for an environment — called on EVERY successful repair
 *  so the row always describes the most recent way this env came back to
 *  life. Never throws (a lesson write must never taint a success path). */
export async function recordLesson(rec: LessonRecord): Promise<void> {
  try {
    await db.repairLesson.upsert({
      where: { envId: rec.envId },
      create: {
        envId: rec.envId,
        projectId: rec.projectId,
        errorSig: rec.errorSig.slice(0, 200),
        diagnosis: rec.diagnosis.slice(0, 300),
        fixCmds: JSON.stringify(rec.fixCmds.slice(0, 8)),
        cleanTargets: JSON.stringify(rec.cleanTargets.slice(0, 8)),
        cmd: rec.cmd ?? null,
        port: rec.port ?? null,
        envVars: rec.envVars ?? null,
        source: rec.source,
        succeededAt: new Date(),
      },
      update: {
        projectId: rec.projectId,
        errorSig: rec.errorSig.slice(0, 200),
        diagnosis: rec.diagnosis.slice(0, 300),
        fixCmds: JSON.stringify(rec.fixCmds.slice(0, 8)),
        cleanTargets: JSON.stringify(rec.cleanTargets.slice(0, 8)),
        cmd: rec.cmd ?? null,
        port: rec.port ?? null,
        envVars: rec.envVars ?? null,
        source: rec.source,
        succeededAt: new Date(),
      },
    });
  } catch {
    // Lessons are an optimization — persistence failure is non-fatal.
  }
}

/** A replay worked — bump the use counter so the UI/logs can say how many
 *  times this environment was saved without an LLM. */
export async function bumpLessonUse(envId: string): Promise<void> {
  try {
    const lesson = await db.repairLesson.findUnique({ where: { envId } });
    if (lesson) {
      await db.repairLesson.update({
        where: { envId },
        data: { useCount: lesson.useCount + 1, lastUsedAt: new Date() },
      });
    }
  } catch { /* non-fatal */ }
}

/** Parse a lesson's JSON array columns defensively. */
export function parseLessonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.map((s) => String(s)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Snapshot the env's CURRENT working config for a lesson (cmd/port/envVars
 *  as they stand at success time — replay only applies them when the env row
 *  has since drifted). */
export async function currentEnvConfig(envId: string): Promise<{ cmd: string; port: number; envVars: string } | null> {
  try {
    const env = await db.environment.findUnique({ where: { id: envId } });
    if (!env) return null;
    return { cmd: env.cmd, port: env.port, envVars: env.envVars };
  } catch {
    return null;
  }
}

/** Human-readable one-liner about a lesson, for logs and LLM context. */
export function lessonSummary(lesson: {
  diagnosis: string; fixCmds: string; cleanTargets: string; source: string; succeededAt: Date; useCount: number;
}): string {
  const cmds = parseLessonArray(lesson.fixCmds);
  const cleans = parseLessonArray(lesson.cleanTargets);
  const parts = [
    lesson.diagnosis ? `诊断: ${lesson.diagnosis}` : '',
    cmds.length ? `命令: ${cmds.join(' ; ')}` : '',
    cleans.length ? `清理: ${cleans.join(', ')}` : '',
  ].filter(Boolean);
  return `上次成功修复（${lesson.source}，${lesson.succeededAt.toLocaleString('zh-CN')}，已复用 ${lesson.useCount} 次）${parts.length ? ` — ${parts.join('；')}` : ''}`;
}


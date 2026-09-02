/**
 * Shared safety helpers for the LLM repair agent.
 *
 * Why this lives in its own file:
 *   - `tools/exec.ts` runs arbitrary commands proposed by the LLM.
 *   - `llm-repair.ts` had its own copy of the same allowlists / env builder.
 *   - Having one source of truth prevents drift between "is this command
 *     safe to run?" answered from two places.
 *
 * Exports:
 *   - SAFE_REPAIR_PREFIXES:   commands whose first token must match one of these
 *   - DANGEROUS_PATTERNS:     regexes that always require human approval
 *   - isRepairCommandSafe:    true when no approval is needed
 *   - needsApproval:          false when safe, true + reason when dangerous
 *   - buildChildEnv:          sanitized env (strips Next.js internals + DATABASE_*)
 */

// ---- allowlist (must match the first token of the command) --------------

export const SAFE_REPAIR_PREFIXES = [
  'npm', 'npx', 'yarn', 'pnpm', 'bun',
  'pip', 'pip3', 'python', 'python3', 'uv', 'poetry', 'pipenv',
  'go', 'cargo', 'rustc', 'make',
  'node', 'deno', 'tsc', 'eslint', 'prettier', 'prisma', 'next', 'vite',
  'bundle', 'composer', 'artisan', 'dotnet', 'mvn', 'gradle', 'php',
  'ruby', 'rails', 'gem',
  'mkdir', 'touch', 'cp', 'mv', 'sed', 'echo',
];

// ---- dangerous patterns ------------------------------------------------

export const DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+(-[a-z]*r[a-z]*f?|[a-z]*f[a-z]*r?|-rf|-fr)/i,
  /\bsudo\b/,
  /:\s*\(\)\s*\{/, // fork bomb
  /dd\s+if=/,
  /mkfs/,
  />\s*\/dev\//,
  /chmod\s+777/,
  /wget.*\|\s*(ba)?sh/,
  /curl.*\|\s*(ba)?sh/,
  /\bcd\s/, // cd in repair commands can mask what directory you're in
  /\/etc\/|\/usr\/(?!local\/bin)|\/var\//,
];

// ---- classification ----------------------------------------------------

export type ApprovalReason =
  | 'dangerous-pattern'
  | 'unknown-prefix'
  | 'too-long'
  | 'empty';

export interface ApprovalDecision {
  safe: boolean;
  reason?: ApprovalReason;
  detail?: string;
}

/**
 * Classify a command. Returns `safe: true` when the command can be auto-run.
 * Otherwise it explains why it needs human approval.
 */
export function classifyRepairCommand(cmd: string): ApprovalDecision {
  const trimmed = (cmd || '').trim();
  if (!trimmed) return { safe: false, reason: 'empty' };
  if (trimmed.length > 400) return { safe: false, reason: 'too-long' };
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        safe: false,
        reason: 'dangerous-pattern',
        detail: `matches ${pattern}`,
      };
    }
  }
  // Strip leading VAR=value env prefixes (e.g. "NODE_ENV=production npm test").
  let firstToken = trimmed.split(/\s+/)[0] || '';
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(firstToken)) {
    firstToken = trimmed.split(/\s+/)[1] || '';
  }
  if (!firstToken) return { safe: false, reason: 'unknown-prefix' };
  const matchesPrefix = SAFE_REPAIR_PREFIXES.some(
    (prefix) => firstToken === prefix || firstToken.startsWith(prefix + ' '),
  );
  if (!matchesPrefix) {
    return { safe: false, reason: 'unknown-prefix', detail: `first token "${firstToken}" not in allowlist` };
  }
  return { safe: true };
}

/** Back-compat helper — true when no approval is needed. */
export function isRepairCommandSafe(cmd: string): boolean {
  return classifyRepairCommand(cmd).safe;
}

// ---- sanitized child env ----------------------------------------------

/**
 * Build the env passed to repair child processes. Strips Next.js internals
 * (which leak from the dashboard's own runtime and confuse other Next apps
 * when they JSON.parse them as their own config) and DATABASE_URL (which
 * points at the dashboard's own SQLite — leaking it into npm install
 * postinstalls or `prisma db push` would mutate the wrong database).
 */
export function buildChildEnv(
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('__NEXT_PRIVATE_')) continue;
    if (k === 'NEXT_DEPLOYMENT_ID') continue;
    if (k === '__NEXT_PROCESSED_ENV') continue;
    if (k === 'TURBOPACK' || k === 'NEXT_RUNTIME') continue;
    if (k === 'DATABASE_URL' || k.startsWith('DATABASE_')) continue;
    if (v === undefined) continue;
    env[k] = v as string;
  }
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}
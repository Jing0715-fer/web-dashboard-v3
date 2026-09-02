/**
 * Shared safety gates + process-env helpers for the LLM repair agent.
 *
 * Extracted from llm-repair.ts so both the agent loop (repair-agent.ts) and
 * the job orchestrator (llm-repair.ts) can use them without import cycles.
 */

// ============================= command safety =============================

const SAFE_REPAIR_PREFIXES = [
  'npm', 'npx', 'yarn', 'pnpm', 'bun',
  'pip', 'pip3', 'python', 'python3', 'uv', 'poetry', 'pipenv',
  'go', 'cargo', 'rustc', 'make',
  'node', 'deno', 'tsc', 'eslint', 'prettier', 'prisma', 'next', 'vite',
  'bundle', 'composer', 'artisan', 'dotnet', 'mvn', 'gradle', 'php',
  'ruby', 'rails', 'gem',
  'mkdir', 'touch', 'cp', 'mv', 'sed', 'echo',
  // Read-only inspection commands — safe to auto-run inside the `test` tool
  // so the LLM can verify facts (file existence, process state) itself.
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'stat', 'file', 'wc', 'du',
  'ps', 'lsof', 'ss', 'which', 'whoami', 'id', 'uname', 'date', 'printenv',
];

const DANGEROUS_PATTERNS = [
  /rm\s+(-[a-z]*r[a-z]*f?|[a-z]*f[a-z]*r?|-rf|-fr)/i,
  /\bsudo\b/,
  /:\s*\(\)\s*\{/, // fork bomb
  /dd\s+if=/,
  /mkfs/,
  />\s*\/dev\//,
  /chmod\s+777/,
  /wget.*\|\s*(ba)?sh/,
  /curl.*\|\s*(ba)?sh/,
  /\bcd\s/,
  /\/etc\/|\/usr\/(?!local\/bin)|\/var\//,
];

/** Validate a repair/test command from the LLM before executing it. */
export function isRepairCommandSafe(cmd: string): boolean {
  const trimmed = (cmd || '').trim();
  if (!trimmed || trimmed.length > 400) return false;
  if (DANGEROUS_PATTERNS.some((p) => p.test(trimmed))) return false;

  // Strip leading VAR=value env prefixes (same as process-manager).
  let firstToken = trimmed.split(/\s+/)[0] || '';
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(firstToken)) {
    firstToken = trimmed.split(/\s+/)[1] || '';
  }
  if (!firstToken) return false;
  return SAFE_REPAIR_PREFIXES.some((prefix) => firstToken === prefix || firstToken.startsWith(prefix + ' '));
}

const SAFE_START_PREFIXES = [
  'npm', 'npx', 'yarn', 'pnpm', 'bun', 'python', 'python3', 'go', 'cargo', 'make',
  'node', 'deno', 'flask', 'gunicorn', 'uvicorn', 'django', 'dotnet', 'php',
  'ruby', 'rails', 'bundle', 'docker', 'sh', 'bash', './', 'PORT=',
];

export function isStartCmdSafe(cmd: string): boolean {
  const c = (cmd || '').trim();
  return c.length > 0 && c.length <= 500 && SAFE_START_PREFIXES.some((p) => c.startsWith(p));
}

// ============================= process env =============================

/** Child-process env without Next.js internals leaking into the project. */
export function buildChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('__NEXT_PRIVATE_')) continue;
    if (k === 'NEXT_DEPLOYMENT_ID' || k === '__NEXT_PROCESSED_ENV') continue;
    if (k === 'TURBOPACK' || k === 'NEXT_RUNTIME') continue;
    // DATABASE_* points at the dashboard's own SQLite — leaking it into repair
    // commands (npm install postinstalls, prisma db push, …) would let them
    // mutate the dashboard's database instead of the child project's.
    if (k === 'DATABASE_URL' || k.startsWith('DATABASE_')) continue;
    if (v === undefined) continue;
    env[k] = v;
  }
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}

// ============================= text helpers =============================

/** Keep the tail of a blob (defaults to 400 chars) — for logs/errors. */
export function tail(text: string, max = 400): string {
  if (!text) return '';
  const t = text.trim();
  return t.length > max ? t.slice(-max) : t;
}

/** Keep head + tail with an ellipsis marker — for tool results where the
 *  beginning (file headers) and end (log tails) both matter. */
export function headTail(text: string, max = 2200): string {
  if (!text) return '';
  const t = text.replace(/\r\n/g, '\n').trim();
  if (t.length <= max) return t;
  const headLen = Math.min(600, Math.floor(max * 0.35));
  const tailLen = max - headLen;
  return `${t.slice(0, headLen)}\n…(middle truncated, ${t.length} chars total)…\n${t.slice(-tailLen)}`;
}

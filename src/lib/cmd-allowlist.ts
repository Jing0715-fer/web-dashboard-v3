/**
 * Shared command allowlist for LLM/agent-generated startup commands.
 *
 * Four call sites used to each roll their own prefix list + stripping rules
 * (harness engine, apply-analysis, classic analyze, analyze-cli) — with
 * divergent behavior: the engine stripped `VAR=value` prologues, the classic
 * routes stripped nothing, and NONE accepted the `unset VAR &&` guard the
 * dsh agent emits whenever a stray PORT (leaked from the Next.js dev server
 * into the agent shell) interfered with the server under test. The result:
 * a fully verified analysis could end up with ZERO savable environments —
 * "all LLM work produced nothing".
 *
 * Semantics (unchanged from the original guard): the check validates only
 * the FIRST REAL command word against the allowlist. `npm start && x` has
 * always passed; the guard's purpose is to block obviously-dangerous
 * leading commands (rm, curl | sh, …), not to fully parse shell syntax.
 */

/** Union of the four historical allowlists (all innocuous run/package
 *  managers — a strict superset of each list, so nothing previously
 *  allowed gets rejected). */
export const SAFE_CMD_PREFIXES: readonly string[] = [
  'npm', 'npx', 'bun', 'bunx', 'yarn', 'pnpm',
  'node', 'deno', 'python', 'python3', 'pip', 'pip3', 'uv', 'uvicorn',
  'flask', 'gunicorn', 'django', 'go', 'cargo', 'make', 'java', 'dotnet',
  'php', 'ruby', 'rails', 'bundle', 'docker',
  'sh', 'bash', './',
];

/**
 * Strip shell prologues the agent realistically emits before the real
 * command, so the allowlist can validate the first REAL command word:
 *   - env-var assignments   "NODE_ENV=production npm start"
 *   - unset guards          "unset PORT && bun run server.js"
 *   - export guards         "export NODE_ENV=production && node server.js"
 *   - stray "&&" separators between the above segments
 * Bounded loop (prologues never exceed a few segments; 8 is generous).
 */
export function stripShellPrologue(cmd: string): string {
  let s = String(cmd || '').trim();
  for (let i = 0; i < 8; i++) {
    const next = s
      // leading VAR=value assignment (keep a non-space following so we never
      // eat the entire command when it IS just an assignment)
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+(?=\S)/, '')
      // `unset NAME [NAME…] [&&]` guard
      .replace(/^unset\s+[A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*)*\s*(?:&&\s*)?/i, '')
      // `export VAR=value [&&]` guard
      .replace(/^export\s+[A-Za-z_][A-Za-z0-9_]*=\S*\s*(?:&&\s*)?/i, '')
      // stray leading "&&" after a stripped segment
      .replace(/^&&\s*/, '')
      .trimStart();
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * Whether an agent-generated command passes the shared allowlist after
 * prologue stripping. Pure first-word guard — see the file header.
 */
export function isAllowedCommand(cmd: string): boolean {
  const base = stripShellPrologue(cmd);
  if (!base) return false;
  return SAFE_CMD_PREFIXES.some((p) => base.startsWith(p));
}

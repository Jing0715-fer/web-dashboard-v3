/**
 * inspect tool — filesystem read primitives for the LLM repair agent.
 *
 * Why this tool exists:
 *   The old single-shot repair prompt had the LLM "guess" file states
 *   (e.g. "server.js doesn't exist") without ever verifying the guess.
 *   The agent loop calls this tool first to ground its reasoning in actual
 *   filesystem state — this is what prevents the same class of hallucinated
 *   diagnosis the user reported on 2026-09-01.
 *
 * Actions:
 *   - ls(path, max?):       list a directory's entries (max 80, default)
 *   - cat(path, max?):      read a text file (truncated to `max` bytes)
 *   - find(path, pattern):  recursive file search by basename substring
 *   - exists(path):         single boolean — file or directory present
 *
 * Safety:
 *   - Never accepts an absolute path outside the project's `projectPath`
 *     (the env's `Project.path` is the only root the agent can read).
 *   - Refuses to read .env, *.db, *.key, *.pem, auth-related files
 *     even if requested — these could leak secrets into the LLM context.
 *   - Reads capped at 200KB to keep token usage bounded.
 */

import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from 'fs';
import { join, relative, resolve, basename } from 'path';

// ---- Tool result envelope (shared by all repair tools) ----------------

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

// ---- Refusal reason helpers --------------------------------------------

const REFUSE_OUTSIDE_PROJECT =
  'Path is outside the project root. The repair agent may only inspect files inside the project directory.';

const REFUSE_SECRET_FILE =
  'Refusing to read a credential / secret file. Inspect the file content indirectly (e.g. its git history or a sanitized copy) instead.';

/** Render a filesystem error (EACCES / EPERM / EISDIR / …) as agent-readable
 *  data instead of letting it crash the loop. Includes the remediation hint
 *  so the LLM can propose the right human action instead of guessing. */
function fsError(e: unknown, path: string): string {
  const err = e as NodeJS.ErrnoException | null;
  const code = err?.code || '';
  const msg = String(err?.message || e).slice(0, 200);
  if (code === 'EACCES' || code === 'EPERM') {
    return `Permission denied (code ${code}) on ${path}: ${msg}. The file or directory is not accessible by the dashboard process user — this usually needs a MANUAL fix outside the repair loop (e.g. chmod u+w <file>, or chown to the dashboard user). You can verify the mode with the test tool: stat <path>.`;
  }
  return `Filesystem error (code ${code || 'UNKNOWN'}) on ${path}: ${msg}`;
}

// Path patterns that are always denied, regardless of project root.
const SECRET_FILENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'auth.secret',
]);

const SECRET_EXTENSIONS = ['.key', '.pem', '.p12', '.pfx', '.db', '.sqlite', '.sqlite3'];

// ---- Validation -------------------------------------------------------

/** Resolve `path` against the project root and confirm it stays inside.
 *  Returns the absolute path on success, or a refusal reason on failure. */
function resolveInProject(path: string, projectPath: string): string | { error: string } {
  if (!path || typeof path !== 'string') {
    return { error: 'Missing or invalid path' };
  }
  const root = resolve(projectPath);
  const abs = resolve(isAbsolute(path) ? path : join(root, path));
  const rel = relative(root, abs);
  if (rel.startsWith('..') || abs === root && path !== '.' && path !== '') {
    // `..` means the resolved path escaped the project root.
    return { error: REFUSE_OUTSIDE_PROJECT };
  }
  return abs;
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/** Reject paths that look like secrets even if they live inside the project. */
function isSecretPath(absPath: string): boolean {
  const name = basename(absPath).toLowerCase();
  if (SECRET_FILENAMES.has(name)) return true;
  return SECRET_EXTENSIONS.some((ext) => name.endsWith(ext));
}

// ---- Individual actions -----------------------------------------------

function doLs(absPath: string, maxEntries: number): ToolResult {
  if (!existsSync(absPath)) {
    return { ok: false, error: `Directory not found: ${absPath}` };
  }
  let stat: import('fs').Stats;
  let allEntries: import('fs').Dirent[];
  try {
    stat = statSync(absPath);
    if (!stat.isDirectory()) {
      return { ok: false, error: `Not a directory: ${absPath}` };
    }
    allEntries = readdirSync(absPath, { withFileTypes: true });
  } catch (e: unknown) {
    // EACCES / EPERM and friends are DATA for the agent, not a crash.
    return { ok: false, error: fsError(e, absPath) };
  }
  const truncated = allEntries.length > maxEntries;
  const entries = allEntries
    .slice(0, maxEntries)
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'symlink' : 'file',
    }));
  return { ok: true, data: { path: absPath, entries, truncated } };
}

function doCat(absPath: string, maxBytes: number): ToolResult {
  if (!existsSync(absPath)) {
    return { ok: false, error: `File not found: ${absPath}` };
  }
  let stat: import('fs').Stats;
  let content: string;
  try {
    stat = statSync(absPath);
    if (!stat.isFile()) {
      return { ok: false, error: `Not a regular file: ${absPath}` };
    }
    if (stat.size > 5 * 1024 * 1024) {
      return { ok: false, error: `File too large to read safely (${stat.size} bytes, limit 5MB)` };
    }
    content = readFileSync(absPath, 'utf8');
  } catch (e: unknown) {
    return { ok: false, error: fsError(e, absPath) };
  }
  let truncated = false;
  if (content.length > maxBytes) {
    content = content.slice(0, maxBytes) + `\n... [truncated to ${maxBytes} of ${stat.size} bytes] ...`;
    truncated = true;
  }
  return { ok: true, data: { path: absPath, size: stat.size, truncated, content } };
}

function doFind(absRoot: string, pattern: string, maxResults: number): ToolResult {
  if (!existsSync(absRoot)) {
    return { ok: false, error: `Directory not found: ${absRoot}` };
  }
  const stat = statSync(absRoot);
  if (!stat.isDirectory()) {
    return { ok: false, error: `Not a directory: ${absRoot}` };
  }
  const matches: { path: string; name: string }[] = [];
  const visited = new Set<string>();

  function walk(dir: string, depth: number): void {
    if (depth > 8 || matches.length >= maxResults) return;
    // Resolve symlinks once per dir to avoid loops; bail on second visit.
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      real = dir;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip silently (permission denied is fine)
    }
    for (const entry of entries) {
      if (matches.length >= maxResults) return;
      const childPath = join(dir, entry.name);
      if (entry.name.includes(pattern)) {
        matches.push({ path: childPath, name: entry.name });
      }
      if (entry.isDirectory()) {
        // Skip the project's own dependency tree to keep results relevant.
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(childPath, depth + 1);
      }
    }
  }

  walk(absRoot, 0);
  return { ok: true, data: { root: absRoot, pattern, count: matches.length, matches } };
}

function doExists(absPath: string): ToolResult {
  if (!existsSync(absPath)) {
    return { ok: true, data: { path: absPath, exists: false } };
  }
  try {
    const stat = statSync(absPath);
    return {
      ok: true,
      data: {
        path: absPath,
        exists: true,
        type: stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other',
        size: stat.isFile() ? stat.size : undefined,
      },
    };
  } catch (e: unknown) {
    return { ok: false, error: fsError(e, absPath) };
  }
}

// ---- Public entry point ------------------------------------------------

export interface InspectArgs {
  action: 'ls' | 'cat' | 'find' | 'exists';
  path: string;
  /** Optional, action-specific:
   *    ls   → max directory entries to return (default 80, cap 200)
   *    cat  → max bytes to read (default 8000, cap 200_000)
   *    find → result cap (default 50, cap 200)
   */
  max?: number;
  /** Only for find: substring to match against basename. */
  pattern?: string;
}

/**
 * Run the inspect tool.
 * @param args        Tool arguments from the LLM.
 * @param projectPath Absolute path of the env's project — the sandbox root.
 */
export async function inspectTool(args: InspectArgs, projectPath: string): Promise<ToolResult> {
  const resolved = resolveInProject(args.path, projectPath);
  if (typeof resolved !== 'string') {
    return { ok: false, error: resolved.error };
  }

  // Refuse secrets even if inside the project root.
  if (args.action === 'cat' && isSecretPath(resolved)) {
    return { ok: false, error: REFUSE_SECRET_FILE };
  }

  switch (args.action) {
    case 'ls':
      return doLs(resolved, Math.min(Math.max(args.max ?? 80, 1), 200));
    case 'cat':
      return doCat(resolved, Math.min(Math.max(args.max ?? 8000, 100), 200_000));
    case 'find':
      if (!args.pattern || typeof args.pattern !== 'string') {
        return { ok: false, error: 'find requires a non-empty `pattern` substring' };
      }
      return doFind(resolved, args.pattern, Math.min(Math.max(args.max ?? 50, 1), 200));
    case 'exists':
      return doExists(resolved);
    default:
      return { ok: false, error: `Unknown action: ${String((args as { action?: string }).action)}` };
  }
}

// ---- Tool schema (for the LLM tool-call prompt) -----------------------

export const INSPECT_TOOL_SCHEMA = {
  name: 'inspect',
  description:
    'Read-only filesystem primitives for the project directory. Use this BEFORE guessing — never claim a file missing or present without verifying with this tool. Refuses to read secrets (.env, *.db, *.key, *.pem).',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['ls', 'cat', 'find', 'exists'],
        description:
          'ls: list a directory. cat: read a text file (capped at 200KB). find: recursive search by basename substring (skips node_modules / .git). exists: boolean check.',
      },
      path: {
        type: 'string',
        description: 'Path relative to the project root (e.g. "src/lib/auth.ts") or absolute. Must resolve inside the project.',
      },
      pattern: {
        type: 'string',
        description: 'Required for action=find. Substring to match against file/dir basenames.',
      },
      max: {
        type: 'number',
        description:
          'Optional cap — number of entries (ls/find) or bytes (cat). Defaults: ls=80, cat=8000, find=50.',
      },
    },
    required: ['action', 'path'],
  },
} as const;
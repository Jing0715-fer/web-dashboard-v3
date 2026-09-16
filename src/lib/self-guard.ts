// self-guard.ts
// Centralized constants for protecting the web-dashboard's own process
// from being killed, restarted, or listed as a child project.

import fs from 'fs';
import path from 'path';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Walk up from process.cwd() until we find a directory containing package.json.
 * This handles both dev mode (cwd = project root) and standalone production
 * builds (cwd = .next/standalone).
 */
function findProjectRoot(start: string): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: trust cwd
  return path.resolve(start);
}

/**
 * Absolute path to the web-dashboard's own project directory.
 * Used to:
 *   - Hide the dashboard from the project list (GET /api/projects)
 *   - Reserve its port (process-manager.ts RESERVED_PORTS)
 *   - Prevent self-analysis / self-start from the UI (see isSelfOrAncestorPath)
 */
export const SELF_PROJECT_PATH = findProjectRoot(process.cwd());

/**
 * Canonical form used for every "is this the dashboard itself?" comparison:
 *   1. fs.realpathSync — resolves symlinks, junctions, drive maps and (on
 *      Windows) returns the on-disk casing of every segment.
 *   2. toLowerCase on win32 — belt-and-braces for case-insensitive filesystems
 *      (realpath of a NON-existent path falls back to path.resolve, which
 *      preserves whatever casing the caller typed).
 *
 * This is what makes the guard survive the real-world ways users register the
 * dashboard's own directory: a drive letter typed in a different case
 * (`c:\Users\...` vs `C:\Users\...`), OneDrive/junction aliases, 8.3 short
 * names, or a differently-cased clone of the same folder. Before this, the
 * exact-string compare missed those rows and the analysis agent's pre-flight
 * cleanup killed the live dashboard server (the "fetching its own environment
 * stops the service" bug).
 */
function canon(p: string): string {
  let out: string;
  try {
    out = fs.realpathSync(p);
  } catch {
    try { out = path.resolve(p); } catch { return p; }
  }
  return IS_WINDOWS ? out.toLowerCase() : out;
}

const SELF_CANON = canon(SELF_PROJECT_PATH);

/**
 * All paths that should be treated as "self" for filtering purposes.
 * For example, a production standalone build runs with cwd inside .next/standalone,
 * so we also need to match the resolved project root.
 */
export const SELF_PROJECT_PATHS: readonly string[] = [SELF_PROJECT_PATH];

/**
 * Reserved ports the dashboard will never let a child project bind to.
 * Mirrored from process-manager.ts to keep the API layer in sync.
 */
export const RESERVED_PORTS: readonly number[] = [3000];

/**
 * True when `p` IS the dashboard's own directory.
 * Starting a process there is unsafe even on a different port: it would share
 * the live server's .next build dir (dev-server lock deadlock) and SQLite file.
 */
export function isSelfPath(p: string): boolean {
  try {
    return canon(p) === SELF_CANON;
  } catch {
    return false;
  }
}

/**
 * True when `p` is the dashboard's own directory OR one of its ANCESTORS
 * (e.g. the home directory, /, ...) — canonicalized first (see canon()).
 */
export function isSelfOrAncestorPath(p: string): boolean {
  try {
    const target = canon(p);
    if (target === SELF_CANON) return true;
    // The filesystem root is an ancestor of everything — but concatenating
    // path.sep onto it ('/' + '/' === '//') would never prefix-match, so it
    // needs its own check (dirname of root is root itself).
    if (path.dirname(target) === target) return true;
    // target is an ancestor of the dashboard dir → the dashboard lives inside it
    return SELF_CANON.startsWith(target + path.sep);
  } catch {
    return false;
  }
}

/**
 * The project root the analysis agent would discover for `p`: the nearest
 * ancestor directory (including p itself) that has a package.json. This
 * mirrors both findProjectRoot() above and what the dsh agent does when it
 * explores a directory — when you point it at <dashboard>/src it walks up,
 * finds the dashboard's package.json, and treats THE DASHBOARD as the project.
 */
function discoverProjectRoot(start: string): string {
  let dir = canon(start);
  for (let i = 0; i < 8; i++) {
    try {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    } catch { /* unreadable */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return canon(start);
}

/**
 * True when ANALYZING (or registering) `p` would effectively point the
 * analysis agent at the dashboard itself:
 *   - `p` is the dashboard dir or an ancestor of it (isSelfOrAncestorPath), or
 *   - `p` sits INSIDE the dashboard tree with no package.json of its own
 *     (<dashboard>/src, <dashboard>/docs, ...) so the agent's walk-up would
 *     land on the dashboard's package.json.
 *
 * Independent sub-packages under the dashboard tree (e.g.
 * <dashboard>/mini-services/agent — its own package.json and port) remain
 * allowed, as before.
 */
export function isUnsafeAnalysisPath(p: string): boolean {
  if (isSelfOrAncestorPath(p)) return true;
  try {
    const start = canon(p);
    if (!start) return false;
    const root = discoverProjectRoot(start);
    return root !== start && isSelfOrAncestorPath(root);
  } catch {
    return false;
  }
}

/**
 * Shared, user-facing explanation for the rejected self-analysis/start.
 * Written once so every layer (project create, harness analyze, classic
 * analyze, start) answers with the same story. The `for` variant additionally
 * explains the inside-the-tree-without-package.json case.
 */
export const SELF_GUARD_REJECTION = `Refusing to operate on this path: it contains the dashboard itself (${SELF_PROJECT_PATH}). The analysis agent would read the dashboard's own .next/dev/lock and kill the running dashboard server (this is the "service stops during analysis" bug), and a second server started from the same directory would deadlock on the shared .next build. Please register a copy of the project in another directory instead.`;

export function analysisGuardRejection(forPath?: string): string {
  if (forPath && isUnsafeAnalysisPath(forPath) && !isSelfOrAncestorPath(forPath)) {
    return `Refusing to analyze "${forPath}": it is inside the dashboard's own directory (${SELF_PROJECT_PATH}) and has no package.json of its own, so the analysis agent would treat the dashboard itself as the project — reading its .next/dev/lock and killing the live server. Register the project by its own root directory instead.`;
  }
  return SELF_GUARD_REJECTION;
}

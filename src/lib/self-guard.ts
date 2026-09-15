// self-guard.ts
// Centralized constants for protecting the web-dashboard's own process
// from being killed, restarted, or listed as a child project.

import fs from 'fs';
import path from 'path';

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
    return path.resolve(p) === SELF_PROJECT_PATH;
  } catch {
    return false;
  }
}

/**
 * True when `p` is the dashboard's own directory OR one of its ANCESTORS
 * (e.g. the home directory, /, ...).
 *
 * Analyzing such a path is the documented self-destruction vector: the
 * analysis agent's pre-flight cleanup reads .next/dev/lock under the analyzed
 * tree and kills the PID inside it — when the tree contains the dashboard,
 * that PID is the live dashboard server. Same for "kill the process that
 * occupies the port I chose" (port 3000 IS the dashboard).
 *
 * Descendants (e.g. <dashboard>/mini-services/agent) are intentionally still
 * allowed — they are independent packages with their own deps and ports.
 */
export function isSelfOrAncestorPath(p: string): boolean {
  try {
    const target = path.resolve(p);
    if (target === SELF_PROJECT_PATH) return true;
    // The filesystem root is an ancestor of everything — but concatenating
    // path.sep onto it ('/' + '/' === '//') would never prefix-match, so it
    // needs its own check (dirname of root is root itself).
    if (path.dirname(target) === target) return true;
    // target is an ancestor of the dashboard dir → the dashboard lives inside it
    return SELF_PROJECT_PATH.startsWith(target + path.sep);
  } catch {
    return false;
  }
}

/**
 * Shared, user-facing explanation for the rejected self-analysis/start.
 * Written once so every layer (project create, harness analyze, classic
 * analyze, start) answers with the same story.
 */
export const SELF_GUARD_REJECTION = `Refusing to operate on this path: it contains the dashboard itself (${SELF_PROJECT_PATH}). The analysis agent would read the dashboard's own .next/dev/lock and kill the running dashboard server (this is the "service stops during analysis" bug), and a second server started from the same directory would deadlock on the shared .next build. Please register a copy of the project in another directory instead.`;

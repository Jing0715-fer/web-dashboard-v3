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
 *   - Future: prevent self-delete / self-start from the UI
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

#!/usr/bin/env node
/**
 * Re-register App Router route files with the running Turbopack dev server.
 *
 * Symptom: an API route answers with Next.js' HTML 404 page even though the
 * route.ts exists and exports the right handler. Turbopack's dev server built
 * an incomplete route tree at startup and never learned about the missing
 * subtrees; a plain `git pull` does not emit a file event for files whose
 * content did not change, so the routes stay missing.
 *
 * What works: touching a route file (mtime only) makes the watcher re-read
 * the directory, and the whole subtree is registered at once.
 *
 * Usage:
 *   node scripts/touch-routes.cjs            # wait for the server, then touch
 *   node scripts/touch-routes.cjs --now      # touch immediately, no waiting
 */

const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..', 'src', 'app');
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';
const WAIT_MS = Number(process.env.TOUCH_ROUTES_WAIT_MS || 60000);

function collectRouteFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectRouteFiles(p, out);
    else if (e.name === 'route.ts' || e.name === 'page.tsx') out.push(p);
  }
  return out;
}

async function waitForServer() {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(DASHBOARD_URL, { signal: AbortSignal.timeout(5000) });
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

(async () => {
  const now = process.argv.includes('--now');
  if (!now) {
    const up = await waitForServer();
    if (!up) {
      console.error(`[touch-routes] dashboard at ${DASHBOARD_URL} did not come up within ${WAIT_MS}ms — aborting`);
      process.exit(1);
    }
  }

  const files = collectRouteFiles(APP_DIR);
  for (const f of files) {
    const now_ = new Date();
    try {
      fs.utimesSync(f, now_, now_);
    } catch (e) {
      console.error(`[touch-routes] could not touch ${f}: ${e.message}`);
    }
  }
  console.log(`[touch-routes] re-registered ${files.length} route file(s) under ${APP_DIR}`);
})();
#!/usr/bin/env node
/**
 * Keep the App Router route tree complete in the running Turbopack dev server.
 *
 * Symptom: an API route answers with Next.js' HTML 404 page even though the
 * route.ts exists and exports the right handler. Turbopack's dev server built
 * an incomplete route tree and never learned about the missing subtrees; a
 * git pull does not emit a file event for files whose content did not
 * change, so the routes stay missing. A plain restart can hit the same
 * thing, so the repair has to survive restarts — hence the watch mode.
 *
 * What works: touching a route file (mtime only) makes the watcher re-read
 * the directory, and the whole subtree is registered at once.
 *
 * Usage:
 *   node scripts/touch-routes.cjs            # wait for the server, then touch once
 *   node scripts/touch-routes.cjs --now      # touch immediately, no waiting
 *   node scripts/touch-routes.cjs --watch    # keep repairing in the background
 */

const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..', 'src', 'app');
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';
const WAIT_MS = Number(process.env.TOUCH_ROUTES_WAIT_MS || 60000);
const POLL_MS = Number(process.env.TOUCH_ROUTES_POLL_MS || 30000);

// A route that exists but is never used for real traffic. Registered -> 401
// (auth guard); missing from the route tree -> the HTML 404 page.
const SENTINEL = '/api/projects/__probe__/environments/__probe__/start';

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

function touchAll() {
  const files = collectRouteFiles(APP_DIR);
  const now = new Date();
  for (const f of files) {
    try {
      fs.utimesSync(f, now, now);
    } catch (e) {
      console.error(`[touch-routes] could not touch ${f}: ${e.message}`);
    }
  }
  return files.length;
}

/** Is the sentinel route registered? (401/405 = yes, HTML 404 = no) */
async function sentinelRegistered() {
  try {
    const res = await fetch(DASHBOARD_URL + SENTINEL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    const html404 = res.status === 404 && text.trimStart().startsWith('<');
    return !html404;
  } catch {
    return null; // server unreachable — treat as "unknown", don't touch
  }
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
  const watch = process.argv.includes('--watch');

  if (!now && !watch) {
    const up = await waitForServer();
    if (!up) {
      console.error(`[touch-routes] dashboard at ${DASHBOARD_URL} did not come up within ${WAIT_MS}ms — aborting`);
      process.exit(1);
    }
  }

  if (!watch) {
    const n = touchAll();
    console.log(`[touch-routes] re-registered ${n} route file(s) under ${APP_DIR}`);
    return;
  }

  console.log(`[touch-routes] watching ${DASHBOARD_URL} (every ${POLL_MS / 1000}s)`);
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const registered = await sentinelRegistered();
    if (registered !== false) continue; // registered, or server down — nothing to do

    const n = touchAll();
    console.log(`[touch-routes] route tree incomplete — touched ${n} route file(s) to force re-registration`);
    // Give the watcher a moment to rebuild, then confirm.
    await new Promise((r) => setTimeout(r, 10000));
    const after = await sentinelRegistered();
    console.log(`[touch-routes] ${after === true ? 'route tree restored' : 'route tree still incomplete'}`);
  }
})();
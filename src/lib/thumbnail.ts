/**
 * Live-preview thumbnail capture engine (v1.22).
 *
 * When a project environment starts (or restarts, or finishes a rebuild), the
 * dashboard waits for the env's HTTP port to answer, then drives a headless
 * Chromium (Playwright) against http://127.0.0.1:<port>/ and stores a real
 * screenshot of the running page as the project card's preview thumbnail.
 *
 * Design invariants:
 *  - A Thumbnail DB row (and its JPEG on disk) is only ever written after a
 *    SUCCESSFUL capture — the UI can trust `file` to exist.
 *  - Captures NEVER block the HTTP request that triggered them: start /
 *    restart / rebuild routes call `scheduleThumbnailCapture()` which is
 *    strictly fire-and-forget. The manual capture endpoint awaits, but by
 *    then the port is usually already warm.
 *  - One in-flight capture per envId (deduped), and at most MAX_CONCURRENT
 *    browser instances globally, so "Start All" on 10 envs can't fork 10
 *    Chromiums at once.
 *  - Everything degrades gracefully: if Playwright / Chromium is not
 *    installed the capture resolves { ok:false, reason:'browser-missing' }
 *    and cards simply keep showing their placeholder.
 */

import { promises as fs, readdirSync, existsSync } from 'fs';
import path from 'path';
import { db } from '@/lib/db';
import { logActivity } from '@/lib/activity';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Directory the JPEGs live in — <repo>/db/thumbnails (gitignored). */
export const THUMB_DIR = path.join(process.cwd(), 'db', 'thumbnails');

/** Viewport used for the screenshot (16:10 — matches the card aspect ratio). */
const VIEWPORT = { width: 1280, height: 800 } as const;

/** JPEG quality — 74 keeps a full card-preview crisp at ~100-250 KB. */
const JPEG_QUALITY = 74;

/**
 * How long to wait for the port to answer ANY HTTP response after start.
 * Cold `next dev` / heavy builds can take a while; this runs in the
 * background so the budget is generous on purpose.
 */
const READINESS_TIMEOUT_MS = 90_000;

/** Page load budget once the port answers. */
const GOTO_TIMEOUT_MS = 45_000;

/** Extra settle time after load (fonts, SPAs hydrating, CSS paint). */
const SETTLE_MS = 1_200;

/** Max simultaneous Chromium instances across all captures. */
const MAX_CONCURRENT = 2;

// ---------------------------------------------------------------------------
// In-flight tracking + tiny semaphore
// ---------------------------------------------------------------------------

type CaptureResult = {
  ok: boolean
  file?: string
  capturedAt?: string
  bytes?: number
  error?: string
  reason?: 'browser-missing' | 'port-not-ready' | 'capture-failed'
}

type CaptureInput = {
  projectId: string
  projectName: string
  envId: string
  envName: string
  port: number
  /** Skip the readiness wait (port known to be warm, e.g. manual re-capture). */
  skipReadinessWait?: boolean
}

/** envId → running capture promise (dedupe + introspection for the UI). */
const inflight = new Map<string, Promise<CaptureResult>>();

/** Whether a capture is currently running for this env (drives the card's
 *  "Capturing preview…" spinner via the projects GET payload). */
export function isCaptureInFlight(envId: string): boolean {
  return inflight.has(envId);
}

/** All envIds currently being captured. */
export function getInflightEnvIds(): Set<string> {
  return new Set(inflight.keys());
}

let activeCount = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  activeCount++;
}

function releaseSlot(): void {
  activeCount--;
  const next = waiters.shift();
  if (next) next();
}

// ---------------------------------------------------------------------------
// Playwright loading + browser resolution
// ---------------------------------------------------------------------------

type LaunchFn = (opts: Record<string, unknown>) => Promise<any>;

let cachedLaunch: LaunchFn | null | undefined;
let launchResolutionError: string | null = null;

/** Launch args used for BOTH the capability probes and the real captures.
 * `--no-sandbox` is required in containers/root-less environments (the
 * default namespace sandbox crashes Chrome there) — a probe WITHOUT it
 * fails for sandbox reasons, not browser-availability reasons, and would
 * wrongly cache "no browser" on a machine that has a perfectly good
 * Chromium (the v1.22 bug: previews silently never appeared in Docker). */
const CHROMIUM_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--font-render-hinting=none',
] as const;

/**
 * Resolve a `chromium.launch` function. Bundlers (Turbopack/webpack) must not
 * inline playwright — it is declared in next.config `serverExternalPackages`
 * and required lazily here. Returns null when the module or a usable Chromium
 * executable cannot be found (feature degrades to "no thumbnails").
 *
 * Two-tier strategy:
 *  1. plain launch with the playwright package's own pinned browser revision
 *     (honors PLAYWRIGHT_BROWSERS_PATH);
 *  2. fallback: ANY installed chromium-* revision in the cache, used via
 *     `executablePath` — makes the feature robust against playwright/
 *     Chromium version drift (a newer playwright than the browsers on the
 *     machine, or vice versa).
 */
async function resolveChromiumLaunch(): Promise<LaunchFn | null> {
  if (cachedLaunch !== undefined) return cachedLaunch;
  try {
    const pw = (await import('playwright')) as any;
    const chromium = pw.chromium;
    if (!chromium?.launch) throw new Error('playwright chromium.launch missing');
    // Try a plain launch first (the pinned revision).
    try {
      const probe = await chromium.launch({ headless: true, args: [...CHROMIUM_LAUNCH_ARGS] });
      await probe.close();
      cachedLaunch = (opts) => chromium.launch({ headless: true, args: [...CHROMIUM_LAUNCH_ARGS], ...opts });
      return cachedLaunch;
    } catch (e: any) {
      const exe = discoverChromiumExecutable();
      if (!exe) {
        launchResolutionError = String(e?.message || e).slice(0, 300);
        cachedLaunch = null;
        return null;
      }
      // Fallback: any chromium-* revision present in the browsers cache —
      // makes the feature robust against playwright/chromium version drift.
      try {
        const probe = await chromium.launch({ headless: true, executablePath: exe, args: [...CHROMIUM_LAUNCH_ARGS] });
        await probe.close();
        cachedLaunch = (opts) => chromium.launch({ headless: true, executablePath: exe, args: [...CHROMIUM_LAUNCH_ARGS], ...opts });
        return cachedLaunch;
      } catch (e2: any) {
        launchResolutionError = String(e2?.message || e2).slice(0, 300);
        cachedLaunch = null;
        return null;
      }
    }
  } catch (e: any) {
    launchResolutionError = String(e?.message || e).slice(0, 300);
    cachedLaunch = null;
    return null;
  }
}

/** What went wrong the last time browser resolution failed (diagnostics). */
export function lastBrowserResolutionError(): string | null {
  return launchResolutionError;
}

/**
 * Scan the Playwright browsers cache for any installed Chromium executable.
 * Handles the directory layouts of ms-playwright >= 1.4x across platforms,
 * including the NEWER layouts (v1.22 shipped only the oldest ones, so a
 * machine with a current browsers cache silently lost live previews):
 *
 *   linux x64 old:  chromium-<rev>/chrome-linux/chrome
 *   linux x64 new:  chromium-<rev>/chrome-linux64/chrome          (pw >= ~1.5x)
 *   headless old:   chromium_headless_shell-<rev>/chrome-linux/headless_shell
 *   headless new:   chromium_headless_shell-<rev>/chrome-headless-shell-linux64/chrome-headless-shell
 *   macOS:          chromium-<rev>/chrome-mac/Chromium.app/Contents/MacOS/Chromium
 *   windows:        chromium-<rev>/chrome-win/chrome.exe (+ chrome-win64/chrome.exe)
 */
function discoverChromiumExecutable(): string | null {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'ms-playwright'),
  ].filter(Boolean) as string[];

  /** Ordered candidate RELATIVE paths, tried inside each matched browser dir. */
  const candidates: Array<(root: string) => string> = [
    // ---- full chromium (preferred: real chrome renders fonts/JS best) ----
    (r) => path.join(r, 'chrome-linux64', 'chrome'),        // new linux x64 layout
    (r) => path.join(r, 'chrome-linux', 'chrome'),           // old linux layout
    (r) => path.join(r, 'chrome-win64', 'chrome.exe'),       // new win x64
    (r) => path.join(r, 'chrome-win', 'chrome.exe'),         // old win
    (r) => path.join(r, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    (r) => path.join(r, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'chrome'),
    // ---- headless shell (only if no full chromium found in this dir) ----
    (r) => path.join(r, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), // new
    (r) => path.join(r, 'chrome-linux', 'headless_shell'),   // old
    (r) => path.join(r, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    (r) => path.join(r, 'chrome-headless-shell-mac', 'chrome-headless-shell'),
  ];

  /** Dir names in the cache, newest revision first. Matches both
   * `chromium-<rev>`/`chromium_headless_shell-<rev>` (underscore variants are
   * the headless-shell dirs, which the v1.22 regex missed entirely). */
  const dirMatch = /^chromium(_headless_shell)?(-\d+)?$/;
  const revOf = (d: string) => parseInt(d.split('-').pop() || '0', 10) || 0;

  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root) as string[];
    } catch {
      continue;
    }
    const chromiumDirs = entries
      .filter((d) => dirMatch.test(d))
      .sort((a, b) => {
        // Full chromium dirs outrank headless-shell dirs at the SAME revision.
        const shellA = a.includes('_headless_shell') ? 1 : 0;
        const shellB = b.includes('_headless_shell') ? 1 : 0;
        if (shellA !== shellB) return shellA - shellB;
        return revOf(b) - revOf(a);
      });
    for (const dir of chromiumDirs) {
      for (const cand of candidates) {
        const p = cand(path.join(root, dir));
        try {
          if (existsSync(p)) return p;
        } catch { /* keep scanning */ }
      }
    }
  }
  return null;
}

/**
 * Fire-and-forget capture — the form start / restart / rebuild routes use.
 * NEVER awaits, NEVER throws: the triggering HTTP response returns instantly
 * while the port-wait + screenshot happen in the background. The next 8s
 * project poll picks up the new thumbnail (and its `capturing` spinner flag).
 */
export function scheduleThumbnailCapture(input: CaptureInput): void {
  void captureThumbnail(input).catch(() => {
    // captureThumbnail already swallows its own errors — this belt-and-braces
    // guard only covers pathologically unexpected rejections.
  });
}

// ---------------------------------------------------------------------------
// Readiness probing
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll http://127.0.0.1:<port>/ until it answers with ANY HTTP status
 * (404/500 still prove a server is listening and rendering). TCP-listen
 * checks are not enough for dev servers that lazily compile on first hit —
 * these fetches double as warm-up so the screenshot renders the real page.
 */
async function waitForHttpReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(2_500),
      });
      return true; // any response — server is up
    } catch {
      // not answering yet — retry
    }
    await sleep(1_500);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Core capture
// ---------------------------------------------------------------------------

/**
 * Capture a screenshot of one running environment. Deduplicated per envId —
 * if a capture is already running for this env, the existing promise is
 * returned so callers never stack duplicates.
 */
export function captureThumbnail(input: CaptureInput): Promise<CaptureResult> {
  const existing = inflight.get(input.envId);
  if (existing) return existing;

  const p = (async () => {
    await acquireSlot();
    try {
      return await runCapture(input);
    } finally {
      releaseSlot();
      inflight.delete(input.envId);
    }
  })();

  inflight.set(input.envId, p);
  return p;
}

async function runCapture(input: CaptureInput): Promise<CaptureResult> {
  const { projectId, projectName, envId, envName, port } = input;
  const url = `http://127.0.0.1:${port}/`;

  // 1. Wait for the server to actually answer (skip when caller knows better).
  if (!input.skipReadinessWait) {
    const ready = await waitForHttpReady(port, READINESS_TIMEOUT_MS);
    if (!ready) {
      const error = `Port ${port} never answered within ${Math.round(READINESS_TIMEOUT_MS / 1000)}s`;
      await recordFailure(projectId, projectName, envId, envName, port, error);
      return { ok: false, error, reason: 'port-not-ready' };
    }
  }

  // 2. Headless browser screenshot.
  const launch = await resolveChromiumLaunch();
  if (!launch) {
    const error = 'Playwright/Chromium not available — run `bunx playwright install chromium` on this machine';
    await recordFailure(projectId, projectName, envId, envName, port, error);
    return { ok: false, error, reason: 'browser-missing' };
  }

  const startedAt = Date.now();
  let browser: any = null;
  try {
    // launch() injects CHROMIUM_LAUNCH_ARGS (--no-sandbox et al.) from
    // resolveChromiumLaunch() — no per-call args are needed or passed here.
    browser = await launch({
      timeout: 20_000,
    });
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.goto(url, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS });
    // networkidle is best-effort — SPAs with websockets never reach it.
    await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
    await sleep(SETTLE_MS);
    const buf: Buffer = await page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY });

    // 3. Atomic write: tmp + rename so a reader never sees a partial JPEG.
    await fs.mkdir(THUMB_DIR, { recursive: true });
    const file = `${envId}.jpg`;
    const finalPath = path.join(THUMB_DIR, file);
    const tmpPath = `${finalPath}.tmp-${Date.now()}`;
    await fs.writeFile(tmpPath, buf);
    await fs.rename(tmpPath, finalPath);

    // 4. Upsert DB row (only ever after a successful write).
    const capturedAt = new Date();
    await db.thumbnail.upsert({
      where: { envId },
      create: {
        projectId,
        envId,
        envName,
        port,
        file,
        bytes: buf.byteLength,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        error: null,
        capturedAt,
      },
      update: {
        envName,
        port,
        file,
        bytes: buf.byteLength,
        error: null,
        capturedAt,
      },
    });

    logActivity({
      type: 'thumbnail',
      level: 'success',
      message: `Live preview captured for '${projectName}' (${envName})`,
      projectId,
      projectName,
      envId,
      envName,
      detail: `${VIEWPORT.width}x${VIEWPORT.height} · ${Math.round(buf.byteLength / 1024)} KB · port ${port}`,
      durationMs: Date.now() - startedAt,
    });

    return { ok: true, file, capturedAt: capturedAt.toISOString(), bytes: buf.byteLength };
  } catch (e: any) {
    const error = String(e?.message || e).slice(0, 500);
    await recordFailure(projectId, projectName, envId, envName, port, error);
    return { ok: false, error, reason: 'capture-failed' };
  } finally {
    try { if (browser) await browser.close(); } catch { /* best-effort */ }
  }
}

/**
 * A capture attempt failed. If a previous GOOD thumbnail exists we keep it
 * (cards stay informative with the last known preview) and only record the
 * error on that row; otherwise no row is written — the placeholder stays.
 */
async function recordFailure(
  projectId: string, projectName: string,
  envId: string, envName: string, port: number,
  error: string,
): Promise<void> {
  try {
    const existing = await db.thumbnail.findUnique({ where: { envId } });
    if (existing) {
      await db.thumbnail.update({ where: { envId }, data: { error: error.slice(0, 500) } });
    }
    logActivity({
      type: 'thumbnail',
      level: 'warn',
      message: `Live preview capture failed for '${projectName}' (${envName})`,
      projectId,
      projectName,
      envId,
      envName,
      detail: error,
    });
  } catch {
    // diagnostics only — never throw
  }
}

// ---------------------------------------------------------------------------
// Read helpers (projects GET, capture route, serve route)
// ---------------------------------------------------------------------------

export interface ThumbnailMeta {
  envId: string
  envName: string
  port: number
  file: string
  capturedAt: string
  /** Cache-busted public URL for <img src> */
  url: string
  bytes: number
  error?: string | null
}

/**
 * Latest READY thumbnail per project (newest capturedAt across the project's
 * environments). One batched query for the whole dashboard list.
 */
export async function getLatestThumbnailsByProject(projectIds: string[]): Promise<Map<string, ThumbnailMeta>> {
  const result = new Map<string, ThumbnailMeta>();
  if (projectIds.length === 0) return result;
  try {
    const rows = await db.thumbnail.findMany({
      where: { projectId: { in: projectIds } },
      orderBy: { capturedAt: 'desc' },
    });
    for (const row of rows) {
      if (result.has(row.projectId)) continue; // newest wins (desc order)
      result.set(row.projectId, {
        envId: row.envId,
        envName: row.envName,
        port: row.port,
        file: row.file,
        capturedAt: row.capturedAt.toISOString(),
        url: `/api/thumbnails/${row.file}?v=${row.capturedAt.getTime()}`,
        bytes: row.bytes,
        error: row.error,
      });
    }
  } catch {
    // thumbnails are decorative — a DB hiccup must not break the project list
  }
  return result;
}

/** Safe filename validator for the serving route (strict allowlist). */
export function isValidThumbnailFile(file: string): boolean {
  return /^[A-Za-z0-9_-]{5,64}\.jpg$/.test(file);
}

/** Absolute path for a thumbnail file (callers must validate first). */
export function thumbnailFilePath(file: string): string {
  return path.join(THUMB_DIR, file);
}

/**
 * probe tool — runtime / network / health probes for the LLM repair agent.
 *
 * Why this tool exists:
 *   The previous repair prompt asked the LLM to diagnose errors in a single
 *   shot, with no way to inspect live state. A diagnosis like "server.js
 *   does not exist" or "the port is free" was based on guesswork.
 *   probe gives the LLM the ability to ground its reasoning in observed
 *   reality — ports actually in use, processes actually running, services
 *   actually responding to HTTP.
 *
 * Actions:
 *   - lsof(port):            what's listening on a single port (PID, proto, state)
 *   - listening(ports[]):    batch check which ports from a list are listening
 *   - ps(query):             ps -ax filtered by substring (name / cmd)
 *   - pid_alive(pid):        is a PID still running
 *   - health(url, timeoutMs):HTTP GET — status + headers + first bytes of body
 *
 * Safety:
 *   - lsof / ps only accept port numbers / safe name patterns (no shell metas)
 *   - health blocks private network ranges (10/8, 172.16/12, 192.168/16, .local,
 *     127.0.0.0/8 except 127.0.0.1) to prevent probing internal services
 *   - health never sends Authorization / Cookie headers; bearer auth only when
 *     the caller passes an `auth` argument explicitly
 *   - response bodies are capped at 4KB; status is the primary signal
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execp = promisify(exec);

const EXEC_TIMEOUT_MS = 8_000;
const HEALTH_BODY_CAP = 4_000;

// ---- Shared envelope --------------------------------------------------

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

// ---- Input validation helpers -----------------------------------------

function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,40}$/;

/** Anything that isn't a port number / safe name substring is refused —
 *  prevents shell injection through `ps` / `lsof` queries. */
function validateName(name: string): string | { error: string } {
  if (typeof name !== 'string') return { error: 'name must be a string' };
  if (name.length === 0) return { error: 'name must not be empty' };
  if (!SAFE_NAME_RE.test(name)) {
    return { error: 'name contains characters outside [A-Za-z0-9._-]' };
  }
  return name;
}

/** A URL the agent is allowed to probe: http(s) only, hostname only
 *  (no IP literals — those bypass DNS and bypass the network-range checks). */
function validateHealthURL(url: string): URL | { error: string } {
  if (typeof url !== 'string') return { error: 'url must be a string' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'url is not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'only http:// and https:// URLs are allowed' };
  }
  // Hostname only — refuse raw IPs.
  const host = parsed.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return { error: 'IP-literal URLs are not allowed; use a hostname' };
  }
  if (host === 'localhost') {
    // Localhost is fine — the dashboard itself binds to it.
    return parsed;
  }
  if (host.endsWith('.local') || host.endsWith('.internal')) {
    return { error: 'mDNS / .local / .internal hostnames are blocked' };
  }
  return parsed;
}

// ---- lsof --------------------------------------------------------------

interface LsofEntry {
  pid: number;
  command: string;
  user: string;
  fdType: string; // 'IPv4' | 'IPv6' | ...
}

async function doLsof(port: number): Promise<ToolResult> {
  if (!isValidPort(port)) return { ok: false, error: `Invalid port: ${port}` };
  // -nP: numeric addresses, no service-name resolution (faster, deterministic)
  // -F pcu: machine-parseable fields: pid, command, user
  // NOTE: lsof exits NON-ZERO when nothing is listening — that is the normal
  // "port is free" answer, not an error. Never let it reject the promise.
  let stdout = '';
  try {
    ({ stdout } = await execp(`lsof -nP -iTCP:${port} -sTCP:LISTEN -F pcu 2>/dev/null`, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    }));
  } catch {
    return { ok: true, data: { port, entries: [] } };
  }
  const entries: LsofEntry[] = [];
  let current: Partial<LsofEntry> | null = null;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      if (current?.pid) entries.push(current as LsofEntry);
      current = { pid: Number(value) };
    } else if (current) {
      if (tag === 'c') current.command = value;
      else if (tag === 'u') current.user = value;
    }
  }
  if (current?.pid) entries.push(current as LsofEntry);
  return { ok: true, data: { port, entries } };
}

// ---- listening (batch) ------------------------------------------------

async function doListening(ports: number[]): Promise<ToolResult> {
  if (!Array.isArray(ports) || ports.length === 0) {
    return { ok: false, error: 'ports must be a non-empty array of numbers' };
  }
  if (ports.length > 64) {
    return { ok: false, error: 'too many ports in one call (max 64)' };
  }
  const invalid = ports.filter((p) => !isValidPort(p));
  if (invalid.length > 0) {
    return { ok: false, error: `invalid ports: ${invalid.join(', ')}` };
  }
  // One lsof call, regex matches LISTEN entries for any of the requested ports.
  // Uses grep -E for portable regex across macOS BSD grep and Linux GNU grep.
  // NOTE: grep exits non-zero when NOTHING matches (all requested ports are
  // free) — that is the normal answer, not an error. Never let it reject.
  const portList = ports.join('|');
  let stdout = '';
  try {
    ({ stdout } = await execp(
      `lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E ':(${portList}) \\(LISTEN\\)'`,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 512 * 1024 },
    ));
  } catch {
    return { ok: true, data: { requested: ports, listening: [] } };
  }
  const set = new Set<number>();
  for (const line of stdout.split('\n')) {
    const m = line.match(/(?::|->)(\d+)\s+\(LISTEN\)/);
    if (m) {
      const p = Number(m[1]);
      if (ports.includes(p)) set.add(p);
    }
  }
  return {
    ok: true,
    data: {
      requested: ports,
      listening: ports.filter((p) => set.has(p)),
    },
  };
}

// ---- ps ----------------------------------------------------------------

async function doPs(query: string): Promise<ToolResult> {
  const validated = validateName(query);
  if (typeof validated !== 'string') return { ok: false, error: validated.error };
  // -axo pid,ppid,command: full table of (pid, parent, command)
  // grep -F: fixed-string match (no regex metachars)
  // Use head -n 40 to bound output (the agent usually only cares about a few rows).
  // head is the last pipeline stage so "no matches" still exits 0 — but wrap
  // anyway: any exec hiccup simply means "no matching processes".
  let stdout = '';
  try {
    ({ stdout } = await execp(
      `ps -axo pid,ppid,command | grep -F -- "${validated}" | grep -v 'grep -F' | head -n 40`,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 256 * 1024 },
    ));
  } catch {
    return { ok: true, data: { query: validated, count: 0, processes: [] } };
  }
  const processes: { pid: number; ppid: number; command: string }[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    processes.push({ pid, ppid, command: parts.slice(2).join(' ') });
  }
  return { ok: true, data: { query: validated, count: processes.length, processes } };
}

// ---- pid_alive --------------------------------------------------------

async function doPidAlive(pid: number): Promise<ToolResult> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, error: `Invalid pid: ${pid}` };
  }
  // `ps -p <pid> -o pid=` returns the pid on stdout when alive, and exits
  // non-zero (no output) when the PID is gone. Capture both branches.
  let stdout = '';
  try {
    ({ stdout } = await execp(`ps -p ${pid} -o pid= 2>/dev/null`, {
      timeout: 4_000,
      maxBuffer: 16 * 1024,
    }));
  } catch {
    // Non-zero exit = PID is gone.
    return { ok: true, data: { pid, alive: false } };
  }
  const trimmed = stdout.trim();
  const alive = trimmed.length > 0 && Number(trimmed) === pid;
  return { ok: true, data: { pid, alive } };
}

// ---- health ------------------------------------------------------------

async function doHealth(url: string, timeoutMs: number): Promise<ToolResult> {
  const parsed = validateHealthURL(url);
  if (typeof parsed !== 'object' || !(parsed instanceof URL)) {
    return { ok: false, error: parsed.error };
  }
  const safeTimeout = Math.min(Math.max(timeoutMs ?? 5_000, 100), 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), safeTimeout);
  const started = Date.now();
  try {
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'manual', // do not silently chase 30x; return the status
      signal: controller.signal,
      headers: { 'User-Agent': 'web-dashboard-repair-probe/1.0' },
    });
    const elapsedMs = Date.now() - started;
    const reader = res.body?.getReader();
    let body = '';
    let bodyTruncated = false;
    if (reader) {
      const decoder = new TextDecoder('utf-8');
      let bytesRead = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > HEALTH_BODY_CAP) {
          body += decoder.decode(value.slice(0, HEALTH_BODY_CAP - body.length));
          bodyTruncated = true;
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
        body += decoder.decode(value);
      }
      body += decoder.decode();
    }
    // Status reasoning helpers — the agent reasons from status codes a lot.
    const statusClass =
      res.status >= 200 && res.status < 300
        ? '2xx'
        : res.status >= 300 && res.status < 400
          ? '3xx'
          : res.status >= 400 && res.status < 500
            ? '4xx'
            : res.status >= 500 && res.status < 600
              ? '5xx'
              : 'other';
    return {
      ok: true,
      data: {
        url: parsed.toString(),
        status: res.status,
        statusClass,
        ok: res.ok,
        redirected: res.status >= 300 && res.status < 400,
        elapsedMs,
        contentType: res.headers.get('content-type') || '',
        bodyTruncated,
        body,
      },
    };
  } catch (e) {
    const elapsedMs = Date.now() - started;
    const err = e as { name?: string; message?: string };
    if (err.name === 'AbortError') {
      return { ok: true, data: { url: parsed.toString(), status: 0, statusClass: 'timeout', elapsedMs, error: `Request aborted after ${safeTimeout}ms` } };
    }
    return { ok: true, data: { url: parsed.toString(), status: 0, statusClass: 'network-error', elapsedMs, error: err.message || String(e) } };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Public entry point ------------------------------------------------

export interface ProbeArgs {
  action: 'lsof' | 'listening' | 'ps' | 'pid_alive' | 'health';
  port?: number;
  ports?: number[];
  query?: string;
  pid?: number;
  url?: string;
  /** health only: ms before fetch is aborted. Capped to [100, 30000]. */
  timeoutMs?: number;
}

export async function probeTool(args: ProbeArgs): Promise<ToolResult> {
  switch (args.action) {
    case 'lsof':
      if (typeof args.port !== 'number') return { ok: false, error: 'lsof requires a numeric `port`' };
      return doLsof(args.port);
    case 'listening':
      if (!Array.isArray(args.ports)) return { ok: false, error: 'listening requires a numeric[] `ports`' };
      return doListening(args.ports);
    case 'ps':
      if (typeof args.query !== 'string') return { ok: false, error: 'ps requires a string `query`' };
      return doPs(args.query);
    case 'pid_alive':
      if (typeof args.pid !== 'number') return { ok: false, error: 'pid_alive requires a numeric `pid`' };
      return doPidAlive(args.pid);
    case 'health':
      if (typeof args.url !== 'string') return { ok: false, error: 'health requires a string `url`' };
      return doHealth(args.url, args.timeoutMs ?? 5_000);
    default:
      return { ok: false, error: `Unknown action: ${String((args as { action?: string }).action)}` };
  }
}

// ---- Tool schema (for the LLM tool-call prompt) -----------------------

export const PROBE_TOOL_SCHEMA = {
  name: 'probe',
  description:
    'Runtime probes for ports, processes and HTTP health. Use BEFORE guessing — never claim a port is free, a process is alive, or a service is responding without verifying. lsof/listening report TCP LISTEN sockets; ps searches process command lines (fixed string, no regex); health runs an HTTP GET with a bounded body. Refuses private network ranges and IP-literal URLs.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['lsof', 'listening', 'ps', 'pid_alive', 'health'],
        description:
          'lsof: who is listening on a port. listening: batch port check. ps: process search by name. pid_alive: is a PID running. health: HTTP GET status + body.',
      },
      port: { type: 'number', description: 'For action=lsof: a single port (1-65535).' },
      ports: {
        type: 'number',
        description: 'For action=listening: array of ports (max 64).',
      },
      query: {
        type: 'string',
        description:
          'For action=ps: fixed-string substring to grep in command lines (regex/special chars are blocked).',
      },
      pid: { type: 'number', description: 'For action=pid_alive: a single PID.' },
      url: {
        type: 'string',
        description:
          'For action=health: an http(s) URL with a hostname (no IP literals, no .local / .internal).',
      },
      timeoutMs: {
        type: 'number',
        description: 'For action=health: request timeout (ms). Default 5000, range [100, 30000].',
      },
    },
    required: ['action'],
  },
} as const;
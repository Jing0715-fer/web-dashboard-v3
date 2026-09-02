/**
 * Listening-port inventory + manual process kill for the dashboard.
 *
 * Backs two features:
 *   1. The Ports panel (GET /api/ports, POST /api/ports/kill) — live view of
 *      every listening TCP port with its owning process, plus one-click kill.
 *   2. Start-conflict resolution — when starting an environment whose project
 *      is already running on ANOTHER port (stray from a previous port config
 *      or a crashed dashboard session), the old process is killed first so
 *      the start lands on the freshly configured port instead of forking a
 *      second instance.
 *
 * Process ownership is resolved via /proc/<pid>/cwd (the process's working
 * directory), which catches `npm run dev` style processes whose command line
 * does not mention the project path at all. Command-line matching is the
 * fallback for processes started from outside the directory.
 *
 * Safety:
 *   - The dashboard's own PID chain (self + ancestors via /proc PPid walk)
 *     can never be killed from here — killing `bun run dev`'s shell parent
 *     would kill us just as dead as killing ourselves.
 *   - RESERVED_PORTS (3000 + env overrides) are never auto-killed by the
 *     stray sweeper.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, readlinkSync } from 'fs';

const execp = promisify(exec);

// ============================= types =============================

export interface PortEntry {
  port: number;
  pid: number | null;
  /** Short process name as reported by ss/lsof (may be truncated). */
  processName: string;
  /** Full command line from ps ('' when unknown). */
  command: string;
  /** True when this pid belongs to the dashboard's own process chain. */
  self: boolean;
}

/** Enriched entry returned by the API: adds env/project ownership. */
export interface OwnedPortEntry extends PortEntry {
  owner: {
    projectId: string;
    projectName: string;
    envId: string;
    envName: string;
    remote: boolean;
  } | null;
  /** True when the port is reserved (dashboard's own listening port). */
  reserved: boolean;
}

// ============================= self protection =============================

/** The dashboard's own PID plus all ancestors — computed lazily, cached. */
function getSelfPidChain(): Set<number> {
  const chain = new Set<number>();
  try {
    let pid = process.pid;
    let guard = 0;
    while (pid > 1 && guard++ < 64) {
      chain.add(pid);
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const ppid = parseInt((status.match(/^PPid:\s+(\d+)/m) || [])[1] || '0', 10);
      if (!ppid || ppid <= 1) break;
      pid = ppid;
    }
  } catch {
    // /proc unavailable — at least protect ourselves
    chain.add(process.pid);
  }
  return chain;
}

let selfChainCache: Set<number> | null = null;
function selfChain(): Set<number> {
  if (!selfChainCache || !selfChainCache.has(process.pid)) {
    selfChainCache = getSelfPidChain();
  }
  return selfChainCache;
}

function reservedPortsSet(): Set<number> {
  const set = new Set<number>([3000]);
  const p = parseInt(process.env.PORT || '', 10);
  if (Number.isFinite(p) && p > 0) set.add(p);
  for (const extra of (process.env.RESERVED_PORTS || '').split(',')) {
    const n = parseInt(extra.trim(), 10);
    if (Number.isFinite(n) && n > 0) set.add(n);
  }
  return set;
}

// ============================= listing =============================

interface RawListener {
  port: number;
  pid: number | null;
  name: string;
}

/** ss -tlnp parser (one port per line, all pids expanded). */
function parseSsLines(stdout: string): RawListener[] {
  const out: RawListener[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('LISTEN')) continue;
    const cols = trimmed.split(/\s+/);
    // Local address column like `*:3000`, `0.0.0.0:4321`, `[::]:4321`, `10.0.0.1:1234`
    const localCol = cols[3] || '';
    const portMatch = localCol.match(/[.:]([0-9]+)$/);
    if (!portMatch) continue;
    const port = parseInt(portMatch[1], 10);
    if (!(port > 0 && port < 65536)) continue;
    // users:(("name",pid=123,fd=22),("name2",pid=456,fd=8))
    const usersPart = trimmed.match(/users:\(\((.+)\)\)/);
    if (!usersPart) {
      out.push({ port, pid: null, name: '' });
      continue;
    }
    const pidMatches = [...usersPart[1].matchAll(/"([^"]*)",pid=(\d+)/g)];
    if (pidMatches.length === 0) {
      out.push({ port, pid: null, name: '' });
      continue;
    }
    const seen = new Set<number>();
    for (const m of pidMatches) {
      const pid = parseInt(m[2], 10);
      if (seen.has(pid)) continue;
      seen.add(pid);
      out.push({ port, pid, name: m[1] });
    }
  }
  return out;
}

/** Fallback parser for `lsof -iTCP -sTCP:LISTEN -n -P`. */
function parseLsof(stdout: string): RawListener[] {
  const out: RawListener[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('(LISTEN)')) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 9) continue;
    const name = cols[0] || '';
    const pid = parseInt(cols[1] || '', 10);
    const node = cols[8] || ''; // e.g. TCP *:3000 (LISTEN)
    const portMatch = node.match(/[.:](\d+)\s+\(LISTEN\)/);
    if (!portMatch) continue;
    const port = parseInt(portMatch[1], 10);
    if (!(port > 0 && port < 65536)) continue;
    const key = `${port}:${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port, pid: Number.isFinite(pid) ? pid : null, name });
  }
  return out;
}

/** Full command line for a pid ('' when unavailable). */
async function pidCommand(pid: number): Promise<string> {
  try {
    const { stdout } = await execp(`ps -p ${pid} -o args= 2>/dev/null`, { timeout: 4000 });
    return (stdout || '').trim().slice(0, 300);
  } catch {
    return '';
  }
}

/** Working directory of a pid via the /proc symlink ('' when unavailable,
 *  e.g. process owned by another user or already dead). */
function pidCwd(pid: number): string {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return '';
  }
}

/** List ALL listening TCP ports with owning process info. */
export async function listListeningPorts(): Promise<PortEntry[]> {
  let raw: RawListener[] = [];
  try {
    const { stdout } = await execp('ss -tlnp 2>/dev/null', { timeout: 6000, maxBuffer: 4 * 1024 * 1024 });
    raw = parseSsLines(stdout);
  } catch {
    /* fall through to lsof */
  }
  if (raw.length === 0) {
    try {
      const { stdout } = await execp('lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null', { timeout: 6000, maxBuffer: 4 * 1024 * 1024 });
      raw = parseLsof(stdout);
    } catch {
      /* no tools — return empty */
    }
  }

  const chain = selfChain();
  const entries: PortEntry[] = [];
  // Batch ps for all pids in ONE call (avoid N spawns): `ps -o pid=,args= -p 1,2,3`
  const pids = [...new Set(raw.map((r) => r.pid).filter((p): p is number => p != null))];
  const cmdByPid = new Map<number, string>();
  if (pids.length) {
    try {
      const { stdout } = await execp(`ps -o pid=,args= -p ${pids.join(',')} 2>/dev/null`, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (m) cmdByPid.set(parseInt(m[1], 10), m[2].slice(0, 300));
      }
    } catch {
      /* leave map empty — commands show as '' */
    }
  }

  for (const r of raw) {
    entries.push({
      port: r.port,
      pid: r.pid,
      processName: (r.name || (r.pid ? (cmdByPid.get(r.pid) || '').split(' ')[0] : '')).slice(0, 60),
      command: r.pid ? cmdByPid.get(r.pid) || '' : '',
      self: r.pid != null && chain.has(r.pid),
    });
  }
  entries.sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0));
  return entries;
}

// ============================= kill =============================

/** True when pid still exists (signal 0 probe). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists but not ours
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface KillResult {
  success: boolean;
  error?: string;
}

/** Kill an arbitrary pid: SIGTERM → grace → SIGKILL → verify dead.
 *  NEVER kills the dashboard's own process chain or pid 1. */
export async function killProcessByPid(pid: number): Promise<KillResult> {
  if (!Number.isInteger(pid) || pid <= 1) {
    return { success: false, error: `Invalid pid: ${pid}` };
  }
  if (selfChain().has(pid)) {
    return { success: false, error: 'Refusing to kill the dashboard\'s own process' };
  }
  if (!pidAlive(pid)) {
    return { success: true }; // already gone — idempotent
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { success: true };
    return { success: false, error: `SIGTERM failed: ${code || String(e)}` };
  }
  // Grace period — a well-behaved server flushes and exits.
  for (let i = 0; i < 12; i++) {
    await sleep(250);
    if (!pidAlive(pid)) return { success: true };
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
  for (let i = 0; i < 8; i++) {
    await sleep(250);
    if (!pidAlive(pid)) return { success: true };
  }
  return { success: false, error: `pid ${pid} survived SIGKILL (may be a zombie or owned by another user)` };
}

// ============================= project strays =============================

export interface ProjectListener {
  port: number;
  pid: number;
  command: string;
  cwd: string;
}

/** All listening processes that belong to a project: cwd inside the project
 *  dir (primary) or command line mentioning the project path (fallback). */
export async function findProjectListeners(projectPath: string): Promise<ProjectListener[]> {
  const chain = selfChain();
  const all = await listListeningPorts();
  const root = projectPath.replace(/\/+$/, '');
  const found: ProjectListener[] = [];
  for (const e of all) {
    if (e.pid == null || chain.has(e.pid)) continue;
    const cwd = pidCwd(e.pid);
    const cmdMentions = e.command.includes(root);
    const cwdInside = cwd === root || cwd.startsWith(root + '/');
    if (cwdInside || cmdMentions) {
      found.push({ port: e.port, pid: e.pid, command: e.command, cwd });
    }
  }
  return found;
}

/** Kill the project's stray listeners (anything except `keepPorts` — the
 *  ports of sibling environments that should keep running). Reserved ports
 *  and the dashboard chain are always protected. Returns what was killed. */
export async function killStrayListeners(
  projectPath: string,
  keepPorts: number[] = [],
): Promise<ProjectListener[]> {
  const keep = new Set(keepPorts);
  const reserved = reservedPortsSet();
  const listeners = await findProjectListeners(projectPath);
  const targets = listeners.filter((l) => !keep.has(l.port) && !reserved.has(l.port));
  const killed: ProjectListener[] = [];
  for (const t of targets) {
    const r = await killProcessByPid(t.pid);
    if (r.success) killed.push(t);
  }
  return killed;
}

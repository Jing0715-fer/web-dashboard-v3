/**
 * Cross-platform (Windows + macOS + Linux) port / process / kill primitives.
 *
 * Why this file exists:
 *   The dashboard is deployed by real users — including on Windows — but the
 *   process/port infrastructure was written against the Unix userland
 *   (lsof / ss / ps / /bin/sh / `kill -pid`). On Windows NONE of those exist,
 *   which made the whole stack silently lie:
 *
 *     - checkPortStatus() (lsof+ss) returned "free" for ports a server was
 *       actively serving → startProcess() could never verify startup → every
 *       Start "failed" after the 30s timeout and the healthy child was killed.
 *     - run_retry's health poll reported "not listening" forever → the repair
 *       agent could never succeed, even when its fix had actually worked.
 *     - `rm` / `ps aux` proposals from the LLM failed with cmd.exe errors.
 *     - Timeout kills used `kill(-pid)` (process groups) — a POSIX concept
 *       that throws on Windows, so nothing was ever killed.
 *
 *   The primitives below give every consumer one place to get OS-aware
 *   behavior. Ground truth for "is this port serving?" is a raw TCP connect —
 *   it needs no external tool and works on every platform. OS-specific
 *   listings (netstat / tasklist / wmic / PowerShell) are best-effort detail.
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as net from 'net';

const execp = promisify(exec);

export const IS_WINDOWS = process.platform === 'win32';

// ============================= TCP connect =============================

/**
 * Raw TCP connect check — the universal, dependency-free answer to
 * "is something accepting connections on this port?". Works identically on
 * Windows / macOS / Linux (a listener bound to 0.0.0.0 accepts loopback).
 * A success means an OS-level accept queue exists; it says nothing about
 * HTTP — callers pair it with their own HTTP probe when that matters.
 */
export function tcpPortOpen(port: number, host = '127.0.0.1', timeoutMs = 700): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try {
      sock.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

// ============================= Windows netstat =============================

/**
 * LISTENING rows of `netstat -ano` on Windows ('' on other platforms or when
 * netstat is unavailable). Row shape:
 *   TCP    0.0.0.0:3102    0.0.0.0:0    LISTENING    12345
 * IPv6 rows use `[::]:3102`; both are kept.
 */
export async function netstatListeningWindows(): Promise<string> {
  if (!IS_WINDOWS) return '';
  try {
    const { stdout } = await execp('netstat -ano -p tcp', {
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return (stdout || '')
      .split(/\r?\n/)
      .filter((l) => /\sLISTENING\s/.test(l))
      .map((l) => l.trim())
      .join('\n');
  } catch {
    return '';
  }
}

/** PID from one netstat LISTENING row ('' / null-shaped when unparseable). */
export function parseNetstatRow(line: string): { port: number; pid: number } | null {
  // TCP    0.0.0.0:3102    0.0.0.0:0    LISTENING    12345
  const m = line.trim().match(/^TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
  if (!m) return null;
  const portMatch = m[1].match(/:(\d+)$/);
  const pid = Number(m[2]);
  if (!portMatch) return null;
  const port = Number(portMatch[1]);
  if (!(port > 0 && port < 65536) || !(pid > 0)) return null;
  return { port, pid };
}

/** PIDs listening on `port` on Windows (netstat parse). Empty off-Windows. */
export async function findPidsOnPortWindows(port: number): Promise<number[]> {
  if (!IS_WINDOWS) return [];
  const rows = (await netstatListeningWindows()).split('\n').filter(Boolean);
  const pids = new Set<number>();
  for (const row of rows) {
    const parsed = parseNetstatRow(row);
    if (parsed && parsed.port === port) pids.add(parsed.pid);
  }
  return [...pids];
}

// ============================= Windows tasklist =============================

/** pid → image name (e.g. 1234 → "bun.exe") from ONE `tasklist /FO CSV /NH`
 *  call. Empty map off-Windows or on failure. */
export async function windowsTaskList(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (!IS_WINDOWS) return map;
  try {
    const { stdout } = await execp('tasklist /FO CSV /NH', {
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    // "bun.exe","1234","Console","1","12,345 K"
    for (const line of (stdout || '').split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m) {
        const pid = Number(m[2]);
        if (pid > 0) map.set(pid, m[1]);
      }
    }
  } catch {
    /* tasklist unavailable — leave empty */
  }
  return map;
}

// ============================= process tree kill =============================

/**
 * Kill a pid AND its whole child tree.
 *   Windows: `taskkill /PID <pid> /T /F` — the only reliable tree kill;
 *   TerminateProcess (what process.kill maps to) leaves children alive,
 *   which is how `next dev` workers survive and keep holding the port.
 *   Unix:    SIGTERM/SIGKILL the process GROUP (child was spawned detached
 *   as group leader), falling back to the bare pid.
 * Fire-and-forget by design — callers verify death via their own poll.
 */
export function killTree(pid: number | null | undefined, force = false): void {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1 || n === process.pid) return;
  if (IS_WINDOWS) {
    try {
      const child = spawn('taskkill', ['/PID', String(n), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      });
      child.on('error', () => {
        /* taskkill missing — best effort */
      });
      child.unref();
    } catch {
      /* ignore */
    }
    return;
  }
  const sig: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-n, sig); // whole group (spawned detached = group leader)
  } catch {
    try {
      process.kill(n, sig);
    } catch {
      /* already gone */
    }
  }
}

// ============================= process command lines =============================

/**
 * Best-effort full process list (command line per row), cross-platform:
 *   Windows: `wmic process get ProcessId,CommandLine` (fast, deprecated on
 *            newest Win11) → PowerShell Get-CimInstance fallback.
 *            Rows look like: "1234 C:\path\bun.exe next dev -p 3102"
 *            (or "1234" alone when CommandLine is NULL — e.g. system procs).
 *   Unix:    `ps aux` (rows carry full command lines).
 * Returns [] when nothing can be listed. Never throws.
 */
export async function processCommandLines(maxRows = 400): Promise<string[]> {
  const rows: string[] = [];
  if (IS_WINDOWS) {
    // 1. wmic LIST format: alternating CommandLine=/ProcessId= properties,
    //    blank line between instances, "CommandLine=" alone when NULL.
    try {
      const { stdout } = await execp('wmic process get ProcessId,CommandLine /FORMAT:LIST', {
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      let pendingCmd: string | null = null;
      for (const line of (stdout || '').split(/\r?\n/)) {
        const t = line.trim();
        if (!t) {
          pendingCmd = null;
          continue;
        }
        if (t.startsWith('CommandLine=')) pendingCmd = t.slice('CommandLine='.length).trim();
        else if (t.startsWith('ProcessId=')) {
          const pid = Number(t.slice('ProcessId='.length));
          if (Number.isInteger(pid) && pid > 0) rows.push(`${pid} ${pendingCmd ?? ''}`.trimEnd());
          pendingCmd = null;
        }
      }
    } catch {
      rows.length = 0; // wmic missing (Win11 24H2+) — fall through to PowerShell
    }
    if (rows.length === 0) {
      try {
        // Plain-text rows "pid commandline" — no CSV quoting pitfalls.
        const { stdout } = await execp(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }"`,
          { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        );
        for (const line of (stdout || '').split(/\r?\n/)) {
          const t = line.trim();
          if (/^\d+\s/.test(t) || /^\d+$/.test(t)) rows.push(t);
        }
      } catch {
        /* PowerShell blocked too — return [] */
      }
    }
    return rows.slice(0, maxRows);
  }
  try {
    const { stdout } = await execp('ps aux', {
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return (stdout || '')
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, maxRows);
  } catch {
    return [];
  }
}

// ============================= shared formatting =============================

/** Human-friendly byte size for tool output ("42.5 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

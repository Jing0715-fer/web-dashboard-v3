import { execFile } from 'child_process';
import { promisify } from 'util';

// execFile with windowsHide ON by default: git.exe / git-remote-https.exe
// are console-subsystem programs — from a console-less dashboard server
// (supervisor/scheduled start) every git call allocates a WINDOW on the
// user's desktop. CREATE_NO_WINDOW on Windows, no-op elsewhere.
const execFileRawAsync = promisify(execFile);
const execFileAsync = (file: string, args: string[], opts: any = {}): Promise<{ stdout: string; stderr: string }> =>
  execFileRawAsync(file, args, { windowsHide: true, ...opts }) as unknown as Promise<{ stdout: string; stderr: string }>;

/**
 * Transient git-network failure signatures (v1.18). Pulling from
 * github.com:443 over a flaky link (typical: connection torn down mid-TLS)
 * dies with e.g. `OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to
 * github.com:443` — and the VERY NEXT attempt succeeds (real user report:
 * "click Pull again and it works"). Those classes are auto-retried with a
 * short backoff; anything else (merge conflicts, auth failures,
 * not-a-repo, local changes) fails immediately — retrying those is just
 * delayed noise.
 */
const TRANSIENT_GIT_NET_RE = new RegExp(
  [
    'SSL_ERROR_SYSCALL',        // OpenSSL: TLS torn down mid-handshake/read
    'SSL_connect', 'SSL_read', 'SSL_write',
    'schannel:',                // Windows native TLS stack errors
    'GnuTLS',                   // Linux git TLS stack errors
    'connection reset', 'was reset by peer',
    'remote end hung up',
    'timed out', 'timeout', 'Timeout was reached', 'ETIMEDOUT',
    'Failed to connect', "couldn't connect", 'Could not resolve host', 'EAI_AGAIN',
    'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
    'Empty reply from server', 'RPC failed',
    'HTTP 5\\d\\d',             // GitHub transient 5xx answers
    'curl \\((?:28|35|55|56)\\)', // curl: timeout / TLS connect / send / recv
  ].join('|'),
  'i',
);

/** stderr+stdout+message of an execFile error, in priority order. */
export function gitErrorText(e: unknown): string {
  const err = e as any;
  return String(err?.stderr || err?.stdout || err?.message || '');
}

/** True when the failure looks like a network flake that a retry can fix. */
export function isTransientGitNetworkError(e: unknown): boolean {
  return TRANSIENT_GIT_NET_RE.test(gitErrorText(e));
}

export interface GitNetworkResult {
  stdout: string;
  stderr: string;
  /** Transient attempts that failed before the success (0 = first try). */
  retried: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a NETWORK-bound git subcommand (pull / fetch / ls-remote / clone)
 * with automatic retry: transient failures (SSL_ERROR_SYSCALL, connection
 * reset, timeouts, DNS blips…) are retried up to `maxRetries` times with a
 * short backoff (~1s → 2.5s → 5s, ±30% jitter); non-transient failures
 * throw on the first attempt. The result carries `retried` so callers can
 * surface "network hiccup — auto-recovered" instead of staying silent
 * about a save the user should know happened.
 *
 * Local-only git commands (rev-parse, status, log…) gain nothing from this
 * — keep using plain execFileAsync for those.
 */
export async function execGitNetwork(
  args: string[],
  opts: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    maxRetries?: number;
  } = {},
): Promise<GitNetworkResult> {
  const { maxRetries = 3, ...execOpts } = opts as Record<string, unknown>;
  let retried = 0;
  for (;;) {
    try {
      const r = await execFileAsync('git', args, execOpts);
      return { stdout: r.stdout, stderr: r.stderr, retried };
    } catch (e) {
      if (retried >= maxRetries || !isTransientGitNetworkError(e)) throw e;
      retried++;
      // Backoff ladder 1s → 2.5s → 5s with ±30% jitter (desynchronizes a
      // fleet of machines hammering github.com right after a shared hiccup).
      const factor = retried === 1 ? 1 : retried === 2 ? 2.5 : 5;
      await sleep(Math.round(1000 * factor * (0.7 + Math.random() * 0.6)));
    }
  }
}

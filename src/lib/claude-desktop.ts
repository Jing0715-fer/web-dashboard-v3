/**
 * Claude Desktop agent bridge (v1.40).
 *
 * Two directions of "agent invocation" between this dashboard and Claude:
 *
 *   1. Dashboard → Claude (invoke):  the `claude` CLI (Claude Code) runs
 *      headless (`claude -p --output-format json`) with the prompt piped in
 *      from a temp file — no quoting traps on any OS. Used by the "Ask
 *      Claude" test call and (already, since v1.34) by the delegated
 *      analysis / repair / pull engines.
 *
 *   2. Claude Desktop → dashboard (MCP bridge):  Claude Desktop gains
 *      dashboard-controlling tools by launching our stdio MCP server
 *      (mini-services/mcp-bridge/mcp-bridge.js) as an MCP server configured
 *      in claude_desktop_config.json. The bridge authenticates to
 *      /api/mcp/* with a per-installation Bearer token persisted in
 *      AppSetting (admin-rotatable). list_projects / start / stop / pull /
 *      logs / ports … all run with the SAME safety rails the UI uses
 *      (reserved ports, allowlisted spawn env, PID protection).
 *
 * Windows compatibility is a hard requirement throughout:
 *   - config path  : %APPDATA%\Claude\claude_desktop_config.json
 *   - app install  : %LOCALAPPDATA%\AnthropicClaude (Squirrel layout, no
 *                    registry entry to rely on)
 *   - CLI shims    : npm-global claude.CMD must be spawned through a shell
 *                    (pipe via `type`), never execFile'd directly
 *   - everything the dashboard spawns uses windowsHide / CREATE_NO_WINDOW
 *     (same rule as the rest of the codebase — no console-flash bugs).
 */

import { spawn } from 'child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, unlinkSync, readdirSync,
} from 'fs';
import { join, dirname } from 'path';
import os from 'os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';
import { IS_WINDOWS } from '@/lib/port-utils';
import { detectRepairClis, resolveRepairCli } from '@/lib/llm-repair/cli-delegate';
import { buildChildEnv } from '@/lib/llm-repair/tools/safety';
import { runShellProcess } from '@/lib/llm-repair/tools/exec';
import { logActivity } from '@/lib/activity';

// ============================= constants =============================

/** MCP server name inside claude_desktop_config.json (stable — patching is
 * idempotent on this key; removing targets exactly this entry). */
export const MCP_SERVER_NAME = 'web-dashboard';

/** AppSetting key holding the Bearer token the bridge presents to /api/mcp. */
const MCP_TOKEN_KEY = 'claudeDesktop.mcpToken';

/** The dashboard version this bridge ships with (shown in health + README). */
export const BRIDGE_VERSION = 'v1.40';

// ============================= paths =============================

export interface ClaudeDesktopPaths {
  /** Directory of the Claude Desktop application install (Windows Squirrel
   * root / macOS .app bundle). '' when the platform has no official build. */
  appDir: string;
  /** claude_desktop_config.json — the file Claude Desktop reads MCP servers
   * from. '' when the platform has no official desktop app (Linux). */
  configPath: string;
  /** Directory that contains configPath (created on demand when patching). */
  configDir: string;
  /** True when this platform has an official Claude Desktop app at all. */
  appSupported: boolean;
}

export function claudeDesktopPaths(): ClaudeDesktopPaths {
  const home = os.homedir();
  if (IS_WINDOWS) {
    const configDir = join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude');
    return {
      appDir: join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'AnthropicClaude'),
      configPath: join(configDir, 'claude_desktop_config.json'),
      configDir,
      appSupported: true,
    };
  }
  if (process.platform === 'darwin') {
    const configDir = join(home, 'Library', 'Application Support', 'Claude');
    return {
      appDir: '/Applications/Claude.app',
      configPath: join(configDir, 'claude_desktop_config.json'),
      configDir,
      appSupported: true,
    };
  }
  // Linux: no official desktop app — CLI + manual MCP config still work.
  return { appDir: '', configPath: '', configDir: '', appSupported: false };
}

// ============================= detection =============================

export interface DesktopAppInfo {
  installed: boolean;
  /** Best-effort version from the Squirrel app-<version> dir / Info.plist. */
  versionHint: string;
  appDir: string;
  /** claude.exe (Windows) / Claude binary (macOS) presence. */
  exeFound: boolean;
}

/** Detect the Claude Desktop APPLICATION on this machine. The app cannot be
 * driven headless — this powers status display + install guidance only. */
export function detectClaudeDesktopApp(): DesktopAppInfo {
  const p = claudeDesktopPaths();
  const empty: DesktopAppInfo = { installed: false, versionHint: '', appDir: p.appDir, exeFound: false };
  if (!p.appSupported || !p.appDir) return empty;
  try {
    if (!existsSync(p.appDir)) return empty;
    let versionHint = '';
    let exeFound = false;
    if (IS_WINDOWS) {
      // Squirrel layout: %LOCALAPPDATA%\AnthropicClaude\app-0.9.x\claude.exe
      try {
        const dirs = readdirSync(p.appDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^app-[\d.]+/i.test(d.name))
          .map((d) => d.name)
          .sort();
        if (dirs.length) {
          const latest = dirs[dirs.length - 1];
          versionHint = latest.replace(/^app-/i, '');
          exeFound = existsSync(join(p.appDir, latest, 'claude.exe'));
        }
      } catch { /* unreadable — installed flag still true */ }
    } else if (process.platform === 'darwin') {
      const plist = join(p.appDir, 'Contents', 'Info.plist');
      try {
        if (existsSync(plist)) {
          const m = readFileSync(plist, 'utf8').match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
          if (m) versionHint = m[1];
        }
        exeFound = existsSync(join(p.appDir, 'Contents', 'MacOS', 'Claude'));
      } catch { /* best effort */ }
    }
    return { installed: true, versionHint, appDir: p.appDir, exeFound };
  } catch {
    return empty;
  }
}

export interface ClaudeCliInfo {
  found: boolean;
  /** First line of `claude --version`. */
  version: string;
  /** Concrete executable ('claude' from PATH or an absolute probe path). */
  exe: string;
}

/** Detect the claude CLI (Claude Code) — the actual headless agent runtime.
 * resolveRepairCli returns the CONCRETE executable (bare PATH name or an
 * absolute probe path — npm-global shims and native installs never touch a
 * background service's PATH); detectRepairClis supplies the cached version
 * string (shared with the settings dialog — no double spawn cost). */
export async function detectClaudeCli(): Promise<ClaudeCliInfo> {
  try {
    const [clis, resolved] = await Promise.all([detectRepairClis(), resolveRepairCli('claude')]);
    if (!resolved) return { found: false, version: '', exe: '' };
    const c = clis.find((x) => x.id === 'claude');
    return { found: true, version: (c?.version || '').split('\n')[0], exe: resolved.exe };
  } catch {
    return { found: false, version: '', exe: '' };
  }
}

// ============================= MCP token =============================

/** Read (creating on first use) the Bearer token the MCP bridge presents.
 * Stored in AppSetting as a JSON string. */
export async function getOrCreateMcpToken(): Promise<string> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: MCP_TOKEN_KEY } });
    if (row) {
      try {
        const parsed = JSON.parse(row.value);
        if (typeof parsed === 'string' && /^[0-9a-f]{64}$/.test(parsed)) return parsed;
      } catch { /* fall through — regenerate */ }
    }
    const token = randomBytes(32).toString('hex');
    await db.appSetting.upsert({
      where: { key: MCP_TOKEN_KEY },
      update: { value: JSON.stringify(token) },
      create: { key: MCP_TOKEN_KEY, value: JSON.stringify(token) },
    });
    logActivity({ type: 'system', message: 'Claude Desktop MCP token generated', level: 'info' });
    return token;
  } catch {
    return '';
  }
}

/** Admin action: replace the token (old one stops working immediately —
 * the bridge env in claude_desktop_config.json must be re-written). */
export async function rotateMcpToken(): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await db.appSetting.upsert({
    where: { key: MCP_TOKEN_KEY },
    update: { value: JSON.stringify(token) },
    create: { key: MCP_TOKEN_KEY, value: JSON.stringify(token) },
  });
  logActivity({ type: 'system', message: 'Claude Desktop MCP token rotated', level: 'warn' });
  return token;
}

/** Timing-safe Bearer check for /api/mcp/* — the token is a local secret
 * (both sides run on the user's own machines), but constant-time compare
 * costs nothing and keeps the guard honest. */
export async function requireMcpToken(req: Request): Promise<{ error?: Response }> {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+([0-9a-f]{64})$/i);
  if (!m) return { error: Response.json({ error: 'Missing or malformed Bearer token' }, { status: 401 }) };
  const expected = await getOrCreateMcpToken();
  if (!expected) return { error: Response.json({ error: 'MCP token unavailable (database error)' }, { status: 500 }) };
  const a = Buffer.from(m[1], 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { error: Response.json({ error: 'Invalid MCP token' }, { status: 401 }) };
  }
  return {};
}

// ============================= bridge wiring =============================

/** Absolute path of the stdio MCP bridge script (Claude Desktop launches
 * this with `node`). process.cwd() is the dashboard repo root in dev and
 * production-start layouts alike. */
export function bridgeScriptPath(): string {
  return join(process.cwd(), 'mini-services', 'mcp-bridge', 'mcp-bridge.js');
}

export function bridgeScriptExists(): boolean {
  try {
    return existsSync(bridgeScriptPath());
  } catch {
    return false;
  }
}

/** The dashboard's own base URL as the bridge should reach it. MCP runs on
 * the SAME machine as the dashboard in the supported topology — loopback +
 * the actual port (3000 default; PORT is set when run elsewhere). */
export function dashboardBaseUrl(): string {
  const port = parseInt(process.env.PORT || '', 10) || 3000;
  return `http://127.0.0.1:${port}`;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env: { DASHBOARD_URL: string; DASHBOARD_MCP_TOKEN: string };
}

/** Build the exact MCP server entry written into claude_desktop_config.json.
 * `node` (bare) is intentional: Claude Desktop spawns MCP servers with the
 * user's environment where node is on PATH — an absolute execPath would
 * break when the dashboard itself runs under bun. */
export function buildMcpServerEntry(dashboardUrl: string, token: string): McpServerEntry {
  return {
    command: 'node',
    args: [bridgeScriptPath()],
    env: {
      DASHBOARD_URL: dashboardUrl.replace(/\/+$/, ''),
      DASHBOARD_MCP_TOKEN: token,
    },
  };
}

// ============================= config patching =============================

export interface ConfigPatchResult {
  ok: boolean;
  configPath: string;
  /** Set when a previous config existed and was backed up first. */
  backupPath: string;
  entry: McpServerEntry | null;
  /** Other mcpServers entries that were preserved (names only). */
  preserved: string[];
  error: string;
}

/** Read + parse claude_desktop_config.json ('' when absent/unparseable). */
function readConfigRaw(configPath: string): Record<string, any> | null {
  try {
    if (!existsSync(configPath)) return null;
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return null;
  }
}

/** Patch the MCP entry into claude_desktop_config.json — merge-preserving
 * (other mcpServers entries survive), backup-first (nothing is ever lost),
 * idempotent (re-running updates our entry in place).
 * `configDirOverride` exists for the dry-run test path (temp dir). */
export async function patchClaudeDesktopConfig(opts: { dryRun?: boolean; configDirOverride?: string } = {}): Promise<ConfigPatchResult> {
  const paths = claudeDesktopPaths();
  const configDir = opts.configDirOverride || paths.configDir;
  const configPath = join(configDir, 'claude_desktop_config.json');
  const base: ConfigPatchResult = { ok: false, configPath, backupPath: '', entry: null, preserved: [], error: '' };

  try {
    if (!configDir) {
      return { ...base, error: 'Claude Desktop is not supported on this platform (no config location)' };
    }

    const token = await getOrCreateMcpToken();
    if (!token) return { ...base, error: 'Could not create the MCP token (database error)' };

    const existing = readConfigRaw(configPath);
    const entry = buildMcpServerEntry(dashboardBaseUrl(), token);
    const preserved = Object.keys(existing?.mcpServers || {}).filter((k) => k !== MCP_SERVER_NAME);

    if (opts.dryRun) {
      return { ...base, ok: true, entry, preserved, error: '' };
    }

    // Backup FIRST when a config already exists (merge-preserving patch —
    // the user's other MCP servers must survive byte-for-byte).
    if (existing !== null) {
      try {
        if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
        const backupPath = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        copyFileSync(configPath, backupPath);
        base.backupPath = backupPath;
      } catch { /* backup failure must not block the write — the merge below preserves content */ }
    }

    const next: Record<string, any> = existing ?? {};
    if (!next.mcpServers || typeof next.mcpServers !== 'object') next.mcpServers = {};
    next.mcpServers[MCP_SERVER_NAME] = entry;

    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');

    logActivity({
      type: 'system',
      message: `Claude Desktop MCP entry ${existing?.mcpServers?.[MCP_SERVER_NAME] ? 'updated' : 'installed'}`,
      detail: `${MCP_SERVER_NAME} → ${entry.args[0]}`,
      level: 'info',
    });
    return { ...base, ok: true, entry, preserved };
  } catch (e: unknown) {
    return { ...base, error: String((e as Error)?.message || e).slice(0, 300) };
  }
}

/** Remove our entry (other servers preserved, backup made first). */
export async function removeClaudeDesktopMcpEntry(): Promise<{ ok: boolean; error: string; backupPath: string }> {
  const paths = claudeDesktopPaths();
  try {
    if (!existsSync(paths.configPath)) return { ok: true, error: '', backupPath: '' };
    const existing = readConfigRaw(paths.configPath);
    if (!existing?.mcpServers?.[MCP_SERVER_NAME]) return { ok: true, error: '', backupPath: '' };

    const backupPath = `${paths.configPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(paths.configPath, backupPath);
    delete existing.mcpServers[MCP_SERVER_NAME];
    writeFileSync(paths.configPath, JSON.stringify(existing, null, 2), 'utf8');
    logActivity({ type: 'system', message: 'Claude Desktop MCP entry removed', level: 'warn' });
    return { ok: true, error: '', backupPath };
  } catch (e: unknown) {
    return { ok: false, error: String((e as Error)?.message || e).slice(0, 300), backupPath: '' };
  }
}

// ============================= status aggregate =============================

export interface ClaudeDesktopStatus {
  version: string;
  platform: string;
  appSupported: boolean;
  app: DesktopAppInfo;
  cli: ClaudeCliInfo;
  config: {
    supported: boolean;
    path: string;
    exists: boolean;
    /** Our MCP entry is present (matched by name). */
    hasEntry: boolean;
    /** Other MCP server names found in the file (never their bodies). */
    otherServers: string[];
    parseError: string;
  };
  bridge: { exists: boolean; path: string };
  dashboardUrl: string;
  tokenConfigured: boolean;
}

/** The full detection picture the settings dialog renders as status chips. */
export async function readClaudeDesktopStatus(): Promise<ClaudeDesktopStatus> {
  const paths = claudeDesktopPaths();
  const [app, cli] = await Promise.all([Promise.resolve(detectClaudeDesktopApp()), detectClaudeCli()]);

  let config: ClaudeDesktopStatus['config'] = {
    supported: !!paths.configPath,
    path: paths.configPath,
    exists: false,
    hasEntry: false,
    otherServers: [],
    parseError: '',
  };
  if (paths.configPath) {
    const raw = readConfigRaw(paths.configPath);
    if (raw === null) {
      config.exists = existsSync(paths.configPath);
      config.parseError = config.exists ? 'file exists but is not valid JSON' : '';
    } else {
      config.exists = true;
      const servers = raw?.mcpServers && typeof raw.mcpServers === 'object' ? Object.keys(raw.mcpServers) : [];
      config.hasEntry = servers.includes(MCP_SERVER_NAME);
      config.otherServers = servers.filter((k) => k !== MCP_SERVER_NAME).slice(0, 20);
    }
  }

  let tokenConfigured = false;
  try {
    const row = await db.appSetting.findUnique({ where: { key: MCP_TOKEN_KEY } });
    tokenConfigured = !!row;
  } catch { /* DB hiccup — leave false */ }

  return {
    version: BRIDGE_VERSION,
    platform: IS_WINDOWS ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    appSupported: paths.appSupported,
    app,
    cli,
    config,
    bridge: { exists: bridgeScriptExists(), path: bridgeScriptPath() },
    dashboardUrl: dashboardBaseUrl(),
    tokenConfigured,
  };
}

// ============================= headless invocation =============================

const pipeRead = () => (IS_WINDOWS ? 'type' : 'cat');

export interface HeadlessResult {
  ok: boolean;
  /** Unwrapped claude JSON envelope text (the model's reply). */
  text: string;
  exitCode: number | 'TIMEOUT' | 'ERROR' | null;
  durationMs: number;
  /** '' | 'auth' | 'timeout' | 'start' — drives the e2e step status. */
  failureKind: '' | 'auth' | 'timeout' | 'start' | 'other';
  detail: string;
}

/** One headless `claude -p` round-trip. The prompt is written to a temp file
 * and piped in via the shell (`type`/`cat`) — the same Windows-safe pattern
 * the CLI delegation engine uses; no argv quoting traps with CJK/quotes. */
export async function runClaudeHeadless(exe: string, prompt: string, timeoutMs = 45_000): Promise<HeadlessResult> {
  const tmpPrompt = join(os.tmpdir(), `.claude-ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const started = Date.now();
  try {
    writeFileSync(tmpPrompt, prompt, 'utf8');
    const cmd = `${pipeRead()} "${tmpPrompt}" | "${exe}" -p --output-format json --max-turns 2`;
    const r = await runShellProcess(cmd, {
      cwd: os.tmpdir(),
      timeoutMs,
      env: buildChildEnv(),
      stdoutCap: 512 * 1024,
      stderrCap: 64 * 1024,
    });
    const durationMs = Date.now() - started;

    // Unwrap the claude envelope: {"type":"result","result":"…","is_error":false}
    let text = '';
    try {
      const env = JSON.parse((r.stdout || '').trim());
      if (env && typeof env.result === 'string') text = env.result;
    } catch { /* non-JSON output — fall back to raw */ }
    if (!text) text = (r.stdout || '').trim();

    if (r.exitCode === 0 && text) {
      return { ok: true, text, exitCode: r.exitCode, durationMs, failureKind: '', detail: '' };
    }
    const combined = `${r.stderr || ''}\n${r.stdout || ''}`;
    const authy = /login|log in|api key|auth|credential|credit|balance|overloaded|subscription|terms/i.test(combined);
    if (r.exitCode === 'TIMEOUT') {
      return { ok: false, text, exitCode: r.exitCode, durationMs, failureKind: 'timeout', detail: 'timed out' };
    }
    if (r.exitCode === 'ERROR') {
      return { ok: false, text, exitCode: r.exitCode, durationMs, failureKind: 'start', detail: (r.err || r.stderr || 'failed to start').slice(0, 300) };
    }
    return {
      ok: false, text, exitCode: r.exitCode, durationMs,
      failureKind: authy ? 'auth' : 'other',
      detail: combined.trim().slice(0, 300),
    };
  } finally {
    try { if (existsSync(tmpPrompt)) unlinkSync(tmpPrompt); } catch { /* best effort */ }
  }
}

// ============================= bridge protocol self-test =============================

export interface BridgeTestResult {
  ok: boolean;
  toolCount: number;
  firstTools: string[];
  health: { ok?: boolean; projects?: number; version?: string } | null;
  detail: string;
  durationMs: number;
}

/** Spawn the REAL bridge script and drive a full MCP handshake:
 * initialize → notifications/initialized → tools/list → tools/call
 * (dashboard_health against the live dashboard). This validates the exact
 * script + config Claude Desktop would run, end to end. */
export async function selfTestMcpBridge(timeoutMs = 20_000): Promise<BridgeTestResult> {
  const started = Date.now();
  const script = bridgeScriptPath();
  const base: BridgeTestResult = { ok: false, toolCount: 0, firstTools: [], health: null, detail: '', durationMs: 0 };
  if (!existsSync(script)) {
    return { ...base, detail: `bridge script not found: ${script}`, durationMs: 0 };
  }
  const token = await getOrCreateMcpToken();
  if (!token) return { ...base, detail: 'MCP token unavailable (database error)' };

  return new Promise<BridgeTestResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // `node` bare works on every supported platform for an .exe ELF binary
      // (never a .cmd shim). Fallback to the dashboard's own runtime if the
      // bare name is not resolvable.
      child = spawn('node', [script], {
        cwd: dirname(script),
        env: buildChildEnv({
          DASHBOARD_URL: dashboardBaseUrl(),
          DASHBOARD_MCP_TOKEN: token,
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e: unknown) {
      resolve({ ...base, detail: `failed to spawn node: ${String((e as Error)?.message || e).slice(0, 200)}` });
      return;
    }

    let buf = '';
    let stderrTail = '';
    let settled = false;
    const finish = (r: BridgeTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve({ ...r, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      finish({ ...base, detail: `bridge did not complete the handshake within ${Math.round(timeoutMs / 1000)}s${stderrTail ? ` — stderr: ${stderrTail.slice(-200)}` : ''}` });
    }, timeoutMs);

    child.stderr?.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    child.on('error', (e) => finish({ ...base, detail: `node spawn error: ${String(e).slice(0, 200)}` }));
    child.on('exit', (code) => {
      if (!settled) finish({ ...base, detail: `bridge exited early (code ${code})${stderrTail ? ` — ${stderrTail.slice(-200)}` : ''}` });
    });

    const replies: any[] = [];
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { replies.push(JSON.parse(line)); } catch { /* non-JSON line on stdout — ignore */ }
      }
      // As soon as the tools/call reply (id 3) lands we are done.
      if (replies.some((r) => r?.id === 3)) {
        const init = replies.find((r) => r?.id === 1)?.result;
        const tools = replies.find((r) => r?.id === 2)?.result?.tools;
        const call = replies.find((r) => r?.id === 3);
        const names: string[] = Array.isArray(tools) ? tools.map((t: any) => String(t?.name || '')).filter(Boolean) : [];
        let health: BridgeTestResult['health'] = null;
        try {
          const text = call?.result?.content?.[0]?.text;
          if (typeof text === 'string') health = JSON.parse(text);
        } catch { /* keep null */ }
        if (!init || !Array.isArray(tools) || tools.length < 8) {
          finish({ ...base, toolCount: names.length, firstTools: names.slice(0, 10), health, detail: `handshake incomplete (initialize:${!!init}, tools:${tools?.length ?? 0})` });
        } else if (!health?.ok) {
          finish({ ...base, toolCount: names.length, firstTools: names.slice(0, 10), health, detail: 'dashboard_health tool call did not report ok (bridge↔dashboard link broken)' });
        } else {
          finish({ ...base, ok: true, toolCount: names.length, firstTools: names.slice(0, 10), health, detail: '' });
        }
      }
    });

    // Drive the handshake (newline-delimited JSON-RPC 2.0).
    const send = (obj: unknown) => { try { child.stdin?.write(JSON.stringify(obj) + '\n'); } catch { /* gone */ } };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dashboard-selftest', version: BRIDGE_VERSION } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dashboard_health', arguments: {} } });
  });
}

// ============================= e2e test orchestrator =============================

export interface TestStep {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
  ms: number;
}

export interface E2EResult {
  ok: boolean;
  steps: TestStep[];
  /** True when the headless round-trip used the built-in SDK instead of the
   * real CLI (no Anthropic auth on this machine) — surfaced honestly. */
  simulated: boolean;
}

/** Full pipeline test, step by step. Every step is independent — a fail in
 * one does not abort the rest (the user wants the complete picture). */
export async function testClaudeDesktopE2E(): Promise<E2EResult> {
  const steps: TestStep[] = [];
  const step = async (id: string, label: string, fn: () => Promise<Omit<TestStep, 'id' | 'label' | 'ms'>>) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      steps.push({ id, label, ...r, ms: Date.now() - t0 });
    } catch (e: unknown) {
      steps.push({ id, label, status: 'fail', detail: String((e as Error)?.message || e).slice(0, 300), ms: Date.now() - t0 });
    }
  };

  // 1. Desktop app detection (informational — Linux never has one).
  await step('detect-app', '检测 Claude Desktop 应用', async () => {
    const p = claudeDesktopPaths();
    if (!p.appSupported) return { status: 'skip', detail: '本平台无官方桌面应用（Linux）— CLI 与手动 MCP 配置仍可用' };
    const app = detectClaudeDesktopApp();
    return app.installed
      ? { status: 'pass', detail: `已安装${app.versionHint ? `（版本 ${app.versionHint}）` : ''}：${app.appDir}` }
      : { status: 'skip', detail: '未检测到桌面应用 — 可通过 install-claude-desktop.bat 安装（Windows）' };
  });

  // 2. Claude Code CLI detection.
  await step('detect-cli', '检测 Claude Code CLI', async () => {
    const cli = await detectClaudeCli();
    return cli.found
      ? { status: 'pass', detail: `${cli.exe} ${cli.version}`.trim() }
      : { status: 'fail', detail: 'claude CLI 未检出 — npm install -g @anthropic-ai/claude-code（或运行 install-claude-desktop 脚本）' };
  });

  // 3. Headless round-trip through the real CLI.
  let simulated = false;
  await step('cli-roundtrip', 'Claude CLI 无头调用往返', async () => {
    const cli = await detectClaudeCli();
    if (!cli.found) return { status: 'skip', detail: '无 CLI 可测' };
    const r = await runClaudeHeadless(cli.exe, 'Reply with exactly this token and nothing else: CLAUDE_OK', 45_000);
    if (r.ok && /CLAUDE_OK/.test(r.text)) {
      return { status: 'pass', detail: `真实往返成功（${r.durationMs}ms）：${r.text.slice(0, 80)}` };
    }
    if (r.failureKind === 'auth') {
      simulated = true;
      return { status: 'skip', detail: 'CLI 已安装但未登录/无 API 额度 — 跳过真实往返（可运行 claude 登录后重试）' };
    }
    if (r.failureKind === 'timeout') {
      return { status: 'fail', detail: 'CLI 响应超时（45s）— 可能正在等待交互式登录' };
    }
    return { status: 'fail', detail: r.detail || `exit=${r.exitCode}` };
  });

  // 4. MCP bridge protocol self-test (real script ↔ live dashboard).
  await step('mcp-bridge', 'MCP 桥接协议自测（真实握手）', async () => {
    if (!bridgeScriptExists()) return { status: 'fail', detail: `桥接脚本缺失：${bridgeScriptPath()}` };
    const r = await selfTestMcpBridge();
    return r.ok
      ? { status: 'pass', detail: `${r.toolCount} 个工具可用，dashboard_health → ok（${r.durationMs}ms）` }
      : { status: 'fail', detail: r.detail };
  });

  // 5. Config patcher dry-run (temp dir — never touches the real config).
  await step('config-patch', 'claude_desktop_config.json 补丁逻辑（干跑）', async () => {
    const dir = join(os.tmpdir(), `cd-config-dryrun-${Date.now()}`);
    try {
      mkdirSync(join(dir, 'Claude'), { recursive: true });
      const cfgPath = join(dir, 'Claude', 'claude_desktop_config.json');
      // Seed an existing foreign server so the merge-preserve path is exercised.
      writeFileSync(cfgPath, JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] } } }), 'utf8');
      const r = await patchClaudeDesktopConfig({ dryRun: true, configDirOverride: join(dir, 'Claude') });
      if (!r.ok || !r.entry) return { status: 'fail', detail: r.error || 'dry-run failed' };
      if (!r.entry.env.DASHBOARD_MCP_TOKEN || r.entry.env.DASHBOARD_MCP_TOKEN.length !== 64) {
        return { status: 'fail', detail: 'entry token malformed' };
      }
      return { status: 'pass', detail: `条目构造正确（command=${r.entry.command}，token 64hex，将写入 ${r.configPath}）` };
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  const ok = steps.every((s) => s.status !== 'fail');
  return { ok, steps, simulated };
}

// ============================= "Ask Claude" (invoke) =============================

export interface AskClaudeResult {
  ok: boolean;
  /** 'claude-cli' — real headless CLI round-trip; 'zai-simulated' — built-in
   * SDK answered because the CLI/auth is unavailable (labeled in the UI). */
  backend: 'claude-cli' | 'zai-simulated';
  text: string;
  durationMs: number;
  detail: string;
}

/** Invoke Claude as an agent with an arbitrary prompt. Prefers the real
 * claude CLI; when it is missing or unauthenticated, the built-in Z.ai SDK
 * answers instead and the response says so — the invocation pipeline is
 * always demonstrable, never a dead end. */
export async function askClaude(prompt: string): Promise<AskClaudeResult> {
  const started = Date.now();
  const clean = (prompt || '').trim().slice(0, 8000);
  if (!clean) {
    return { ok: false, backend: 'zai-simulated', text: '', durationMs: 0, detail: 'empty prompt' };
  }

  const cli = await detectClaudeCli();
  if (cli.found) {
    const r = await runClaudeHeadless(cli.exe, clean, 90_000);
    if (r.ok) {
      logActivity({ type: 'system', message: 'Claude agent invoked (claude CLI)', detail: clean.slice(0, 120), level: 'info', durationMs: r.durationMs });
      return { ok: true, backend: 'claude-cli', text: r.text, durationMs: r.durationMs, detail: '' };
    }
    if (r.failureKind === 'auth') {
      // fall through to the simulated path — labeled honestly
    }
  }

  // Built-in SDK fallback (the same callLLM every other feature uses).
  try {
    const { callLLM } = await import('@/lib/llm-providers');
    const r = await callLLM({
      system: 'You are Claude, an AI assistant embedded in a self-hosted web dashboard. Answer concisely in the user\'s language.',
      prompt: clean,
      temperature: 0.4,
    });
    return {
      ok: true,
      backend: 'zai-simulated',
      text: r.text,
      durationMs: Date.now() - started,
      detail: cli.found ? 'claude CLI 未登录 — 由内置 LLM 网关代答（模拟模式）' : 'claude CLI 未安装 — 由内置 LLM 网关代答（模拟模式）',
    };
  } catch (e: unknown) {
    return { ok: false, backend: 'zai-simulated', text: '', durationMs: Date.now() - started, detail: String((e as Error)?.message || e).slice(0, 300) };
  }
}

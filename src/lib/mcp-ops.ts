/**
 * MCP tool operations (v1.40) — the 9 dashboard-controlling tools Claude
 * Desktop gains through the stdio bridge (mini-services/mcp-bridge).
 *
 * Design rule: NO new process/git logic. Every tool calls the SAME
 * primitives the dashboard UI uses — startProcess / stopProcess /
 * restartProcess / getLogs from process-manager (reserved-port + self-path
 * + command-safety rails), execGitNetwork from git-retry (transient-network
 * retry + proxy rails), and plain Prisma reads. An agent driving the
 * dashboard through MCP therefore has exactly the same safety envelope as a
 * human clicking the UI — no privileged side doors.
 *
 * Security model:
 *   - /api/mcp/* is guarded by the per-installation Bearer token
 *     (requireMcpToken in claude-desktop.ts) — NOT by a user session,
 *     because the caller is a local script Claude Desktop spawns.
 *   - Every mutation writes an activity-feed audit row tagged
 *     "via Claude Desktop MCP" so agent actions are always attributable.
 *   - Process tools operate on LOCAL projects only — a project that belongs
 *     to a registered remote device runs on that machine and cannot be
 *     (mis)driven from here; the tool returns an explicit error instead.
 *
 * The MCP_TOOLS map is the single source of truth for BOTH the route
 * (/api/mcp/[...path] dispatches by name) and the bridge script's advertised
 * tools/list (mini-services/mcp-bridge/mcp-bridge.js embeds a mirror —
 * keep the two catalogs in sync; the e2e self-test fails loudly when the
 * bridge lists fewer than 8 tools).
 */

import { db } from '@/lib/db';
import { logActivity } from '@/lib/activity';
import {
  startProcess, stopProcess, restartProcess, getLogs,
  checkPortStatus, batchCheckPorts, getPidOnPort,
} from '@/lib/process-manager';
import { execGitNetwork, gitNetworkErrorText } from '@/lib/git-retry';
import { getGitNetConfig, gitProxyArgs } from '@/lib/git-net-config';
import { BRIDGE_VERSION } from '@/lib/claude-desktop';

// ============================= types =============================

/** Every tool returns a JSON-serializable object with an `ok` field — the
 * bridge wraps it as the tools/call content text and clients (including our
 * own self-test) parse `ok` out of it. */
export type McpToolResult = Record<string, unknown> & { ok: boolean };

/** JSON-Schema-ish input description (subset used by the route's light
 * validator: type string|number|integer|boolean, required list). */
export interface McpInputSchema {
  type: 'object';
  properties: Record<string, { type: 'string' | 'number' | 'integer' | 'boolean'; description?: string }>;
  required?: string[];
}

export interface McpToolDef {
  /** Human-facing description shown by Claude Desktop in its tool picker. */
  description: string;
  inputSchema: McpInputSchema;
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

// ============================= helpers =============================

/** Audit line for every mutating tool — agent actions must be attributable. */
function audit(op: string, extra: {
  projectId?: string; projectName?: string; envId?: string; envName?: string; level?: 'info' | 'success' | 'warn' | 'error'; detail?: string; durationMs?: number;
} = {}): void {
  logActivity({
    type: 'system',
    level: extra.level || 'info',
    message: `${op} via Claude Desktop MCP`,
    projectId: extra.projectId,
    projectName: extra.projectName,
    envId: extra.envId,
    envName: extra.envName,
    detail: extra.detail,
    durationMs: extra.durationMs,
  });
}

/** Load a project + one of its environments for a tool call. Rejects remote
 * (device-owned) projects — their processes live on another machine. */
async function loadEnv(
  projectId: unknown,
  envName: unknown,
): Promise<
  | { error: string }
  | {
    error: null;
    env: { id: string; name: string; cmd: string; port: number; envVars: string; status: string; pid: number | null };
    project: { id: string; name: string; path: string; repoUrl: string; deviceId: string | null; deviceName: string | null };
  }
> {
  if (typeof projectId !== 'string' || !projectId.trim()) return { error: 'projectId (string) is required' };
  if (typeof envName !== 'string' || !envName.trim()) return { error: 'envName (string) is required' };

  const env = await db.environment.findFirst({
    where: { name: envName, project: { id: projectId } },
    include: { project: { include: { device: true } } },
  });
  if (!env) {
    // Distinguish "no such project" from "no such environment" for a clearer
    // agent-facing error (Claude can self-correct from a precise message).
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) return { error: `project not found: ${projectId}` };
    const names = await db.environment.findMany({ where: { projectId }, select: { name: true } });
    return { error: `environment '${envName}' not found on project '${project.name}' (available: ${names.map((e) => e.name).join(', ') || 'none'})` };
  }

  // Remote device guard: the process runs on the device, not here.
  if (env.project.deviceId != null) {
    return { error: `local projects only — '${env.project.name}' belongs to remote device '${env.project.device?.name || env.project.deviceId}'; manage it on that machine` };
  }

  return {
    error: null,
    env: {
      id: env.id, name: env.name, cmd: env.cmd, port: env.port,
      envVars: env.envVars, status: env.status, pid: env.pid,
    },
    project: {
      id: env.project.id, name: env.project.name, path: env.project.path,
      repoUrl: env.project.repoUrl, deviceId: env.project.deviceId,
      deviceName: env.project.device?.name ?? null,
    },
  };
}

/** Parse an environment's envVars JSON column defensively (bad rows must
 * not 500 the tool call). */
function parseEnvVars(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, string>
      : {};
  } catch {
    return {};
  }
}

/** Light JSON-Schema validation for the route (types + required only —
 * Claude Desktop clients are well-formed; this catches hand-rolled ones). */
export function validateToolInput(schema: McpInputSchema, args: Record<string, unknown>): string {
  for (const key of schema.required || []) {
    if (!(key in args) || args[key] === undefined || args[key] === null) {
      return `missing required argument: ${key}`;
    }
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    switch (spec.type) {
      case 'string':
        if (typeof v !== 'string') return `argument '${key}' must be a string`;
        break;
      case 'integer':
        if (typeof v !== 'number' || !Number.isInteger(v)) return `argument '${key}' must be an integer`;
        break;
      case 'number':
        if (typeof v !== 'number') return `argument '${key}' must be a number`;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') return `argument '${key}' must be a boolean`;
        break;
    }
  }
  return '';
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ============================= tool catalog =============================

export const MCP_TOOLS: Record<string, McpToolDef> = {
  dashboard_health: {
    description: 'Dashboard liveness + version + project counts. Call this first to verify the bridge ↔ dashboard link works.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const [projects, environments] = await Promise.all([
        db.project.count(),
        db.environment.count(),
      ]);
      return {
        ok: true,
        bridge: 'web-dashboard',
        version: BRIDGE_VERSION,
        projects,
        environments,
        uptimeSec: Math.round(process.uptime()),
        pid: process.pid,
        platform: process.platform,
        time: new Date().toISOString(),
      };
    },
  },

  list_projects: {
    description: 'List all registered projects with their environments (name, command, port, run state).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      // include: { environments: true } is the whole point of this tool —
      // the original v1.40 shipped without it and Claude saw env-less
      // projects it could do nothing with.
      const projects = await db.project.findMany({
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
        include: { environments: true },
      });
      return {
        ok: true,
        count: projects.length,
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          path: p.path,
          repoUrl: p.repoUrl,
          device: p.deviceId ? 'remote' : 'local',
          environments: p.environments.map((e) => ({
            name: e.name,
            cmd: e.cmd,
            port: e.port,
            status: e.status,
            pid: e.pid,
          })),
        })),
      };
    },
  },

  project_status: {
    description: 'Live run state of one project\'s environments (port liveness + owning pid, not just the DB row).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id from list_projects' },
        envName: { type: 'string', description: 'Optional: restrict to one environment by name' },
      },
      required: ['projectId'],
    },
    handler: async (args) => {
      const projectId = str(args.projectId);
      const envName = typeof args.envName === 'string' ? args.envName : '';
      const project = await db.project.findUnique({
        where: { id: projectId },
        include: { environments: true },
      });
      if (!project) return { ok: false, error: `project not found: ${projectId}` };
      const envs = envName ? project.environments.filter((e) => e.name === envName) : project.environments;
      if (envName && envs.length === 0) {
        return { ok: false, error: `environment '${envName}' not found on project '${project.name}'` };
      }
      const environments = await Promise.all(envs.map(async (e) => {
        const running = await checkPortStatus(e.port);
        const pid = running ? await getPidOnPort(e.port) : null;
        return {
          name: e.name, cmd: e.cmd, port: e.port,
          dbStatus: e.status, running, pid,
        };
      }));
      return {
        ok: true,
        project: { id: project.id, name: project.name, path: project.path, device: project.deviceId ? 'remote' : 'local' },
        environments,
      };
    },
  },

  start_process: {
    description: 'Start a local project environment (same safety rails as the UI: reserved ports protected, command safety checked).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        envName: { type: 'string' },
      },
      required: ['projectId', 'envName'],
    },
    handler: async (args) => {
      const loaded = await loadEnv(args.projectId, args.envName);
      // Null-check (NOT truthiness) discriminates the union: `error: string`
      // vs `error: null` only splits cleanly under strict null checking —
      // a truthiness test would leave `''` ambiguous across both variants.
      if (loaded.error !== null) return { ok: false, error: loaded.error };
      const { env, project } = loaded;

      const r = await startProcess(project.id, env.name, env.cmd, project.path, parseEnvVars(env.envVars), env.port);
      if (r.success) {
        await db.environment.update({ where: { id: env.id }, data: { status: 'running', pid: r.pid ?? null } });
        audit(`Environment '${env.name}' started on port ${env.port}`, {
          projectId: project.id, projectName: project.name, envId: env.id, envName: env.name,
          level: 'success', detail: r.pid ? `pid ${r.pid}` : undefined,
        });
        return { ok: true, pid: r.pid ?? null, port: env.port, envName: env.name };
      }
      await db.environment.update({ where: { id: env.id }, data: { status: 'stopped', pid: null } });
      audit(`Environment '${env.name}' failed to start`, {
        projectId: project.id, projectName: project.name, envId: env.id, envName: env.name,
        level: 'error', detail: r.error,
      });
      return { ok: false, error: r.error || 'start failed', port: env.port };
    },
  },

  stop_process: {
    description: 'Stop a local project environment (tree kill + port-free verification — same rail as the UI stop button).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        envName: { type: 'string' },
      },
      required: ['projectId', 'envName'],
    },
    handler: async (args) => {
      const loaded = await loadEnv(args.projectId, args.envName);
      // Null-check (NOT truthiness) discriminates the union: `error: string`
      // vs `error: null` only splits cleanly under strict null checking —
      // a truthiness test would leave `''` ambiguous across both variants.
      if (loaded.error !== null) return { ok: false, error: loaded.error };
      const { env, project } = loaded;

      const r = await stopProcess(project.id, env.name, env.port);
      if (r.success) {
        await db.environment.update({ where: { id: env.id }, data: { status: 'stopped', pid: null } });
        audit(`Environment '${env.name}' stopped (port ${env.port})`, {
          projectId: project.id, projectName: project.name, envId: env.id, envName: env.name,
        });
        return { ok: true, port: env.port, envName: env.name };
      }
      audit(`Environment '${env.name}' failed to stop`, {
        projectId: project.id, projectName: project.name, envId: env.id, envName: env.name,
        level: 'error', detail: r.error,
      });
      return { ok: false, error: r.error || 'stop failed', port: env.port };
    },
  },

  restart_process: {
    description: 'Restart a local project environment (stop → start with the same rails).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        envName: { type: 'string' },
      },
      required: ['projectId', 'envName'],
    },
    handler: async (args) => {
      const loaded = await loadEnv(args.projectId, args.envName);
      // Null-check (NOT truthiness) discriminates the union: `error: string`
      // vs `error: null` only splits cleanly under strict null checking —
      // a truthiness test would leave `''` ambiguous across both variants.
      if (loaded.error !== null) return { ok: false, error: loaded.error };
      const { env, project } = loaded;

      const r = await restartProcess(project.id, env.name, env.cmd, project.path, parseEnvVars(env.envVars), env.port);
      if (r.success) {
        await db.environment.update({ where: { id: env.id }, data: { status: 'running', pid: r.pid ?? null } });
        audit(`Environment '${env.name}' restarted on port ${env.port}`, {
          projectId: project.id, projectName: project.name, envId: env.id, envName: env.name,
          level: 'success', detail: r.pid ? `pid ${r.pid}` : undefined,
        });
        return { ok: true, pid: r.pid ?? null, port: env.port, envName: env.name };
      }
      await db.environment.update({ where: { id: env.id }, data: { status: 'stopped', pid: null } });
      audit(`Environment '${env.name}' failed to restart`, {
        projectId: project.id, projectName: project.name, envId: env.id, envName: env.name,
        level: 'error', detail: r.error,
      });
      return { ok: false, error: r.error || 'restart failed', port: env.port };
    },
  },

  get_logs: {
    description: 'Read the recent log lines of a project environment (same log files the UI log viewer shows).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        envName: { type: 'string' },
        tail: { type: 'integer', description: 'How many lines to return (default 80, max 500)' },
      },
      required: ['projectId', 'envName'],
    },
    handler: async (args) => {
      const loaded = await loadEnv(args.projectId, args.envName);
      // Null-check (NOT truthiness) discriminates the union: `error: string`
      // vs `error: null` only splits cleanly under strict null checking —
      // a truthiness test would leave `''` ambiguous across both variants.
      if (loaded.error !== null) return { ok: false, error: loaded.error };
      const { env, project } = loaded;

      const all = getLogs(project.id, env.name);
      const want = typeof args.tail === 'number' && Number.isFinite(args.tail) && args.tail > 0
        ? Math.min(Math.floor(args.tail), 500)
        : 80;
      const lines = all.slice(-want);
      return {
        ok: true,
        projectId: project.id,
        projectName: project.name,
        envName: env.name,
        lines,
        count: lines.length,
        totalLines: all.length,
        truncated: all.length > lines.length,
      };
    },
  },

  list_listening_ports: {
    description: 'All listening TCP ports relevant to dashboard environments, joined with env/project context and the owning pid.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const envs = await db.environment.findMany({
        include: { project: { select: { id: true, name: true, deviceId: true } } },
      });
      const portSet = new Set<number>();
      for (const e of envs) portSet.add(e.port);
      const active = await batchCheckPorts([...portSet]);

      const ports = await Promise.all([...active].sort((a, b) => a - b).map(async (port) => {
        const owner = envs.find((e) => e.port === port);
        const pid = await getPidOnPort(port);
        return {
          port,
          pid,
          envName: owner?.name ?? null,
          projectName: owner?.project.name ?? null,
          projectId: owner?.project.id ?? null,
          remote: owner ? owner.project.deviceId != null : false,
        };
      }));
      return { ok: true, count: ports.length, ports };
    },
  },

  exec_git_network: {
    description: 'Run a network git operation (pull or fetch) on a local project\'s repository — transient network errors are auto-retried, the configured proxy is honored.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        envName: { type: 'string', description: 'Any environment of the project (identifies it unambiguously)' },
        op: { type: 'string', description: "'pull' or 'fetch'" },
      },
      required: ['projectId', 'envName', 'op'],
    },
    handler: async (args) => {
      const loaded = await loadEnv(args.projectId, args.envName);
      // Null-check (NOT truthiness) discriminates the union: `error: string`
      // vs `error: null` only splits cleanly under strict null checking —
      // a truthiness test would leave `''` ambiguous across both variants.
      if (loaded.error !== null) return { ok: false, error: loaded.error };
      const { env, project } = loaded;

      const op = str(args.op).toLowerCase();
      if (op !== 'pull' && op !== 'fetch') {
        return { ok: false, error: `unsupported op '${op}' — use 'pull' or 'fetch'` };
      }
      if (!project.repoUrl) {
        return { ok: false, error: `project '${project.name}' has no repoUrl configured` };
      }

      // Same rails as the UI pull button: configured proxy args + transient
      // retry + generous timeout (pull can download a lot).
      const { proxy } = await getGitNetConfig();
      const netProxyArgs = gitProxyArgs(proxy);
      const gitArgs = op === 'pull'
        ? [...netProxyArgs, 'pull', '--ff-only', 'origin']
        : [...netProxyArgs, 'fetch', 'origin', '--prune'];

      try {
        const r = await execGitNetwork(gitArgs, {
          cwd: project.path,
          timeout: 5 * 60 * 1000,
          maxBuffer: 1024 * 1024,
        });
        audit(`git ${op} on '${project.name}'`, {
          projectId: project.id, projectName: project.name, envId: env.id, envName: env.name,
          level: 'success',
          detail: [
            r.retried > 0 ? `recovered after ${r.retried} transient retry(ies)` : '',
            (r.stdout || '').trim().slice(0, 200),
          ].filter(Boolean).join(' — '),
        });
        return {
          ok: true,
          op,
          stdout: (r.stdout || '').slice(0, 4000),
          stderr: (r.stderr || '').slice(0, 2000),
          retried: r.retried,
        };
      } catch (e: unknown) {
        const error = gitNetworkErrorText(e);
        audit(`git ${op} on '${project.name}' failed`, {
          projectId: project.id, projectName: project.name, envId: env.id, envName: env.name,
          level: 'error', detail: error.slice(0, 300),
        });
        return { ok: false, op, error };
      }
    },
  },
};

/** Names in bridge-advertised order (stable for tests and humans). */
export const MCP_TOOL_NAMES = Object.keys(MCP_TOOLS);

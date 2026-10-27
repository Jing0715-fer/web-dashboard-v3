#!/usr/bin/env node
/**
 * web-dashboard MCP bridge (v1.40) — stdio Model Context Protocol server.
 *
 * Claude Desktop launches this script (`node mcp-bridge.js`) as an MCP server
 * configured in claude_desktop_config.json:
 *
 *   "web-dashboard": {
 *     "command": "node",
 *     "args": ["<dashboard>/mini-services/mcp-bridge/mcp-bridge.js"],
 *     "env": { "DASHBOARD_URL": "http://127.0.0.1:3000", "DASHBOARD_MCP_TOKEN": "<64hex>" }
 *   }
 *
 * Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout (one JSON document
 * per line — the framing every stdio MCP client and server uses). stdout MUST
 * carry ONLY protocol lines: any diagnostic goes to stderr, or Claude Desktop
 * chokes on the framing.
 *
 * The bridge is a thin adapter: it holds NO dashboard logic. Every tools/call
 * is forwarded as an authenticated HTTP POST to DASHBOARD_URL/api/mcp/<tool>
 * (Bearer DASHBOARD_MCP_TOKEN), where the dashboard runs the SAME safety
 * rails the web UI uses (reserved ports, command allowlist, remote-device
 * rejection, git retry + proxy). The tool catalog below mirrors
 * src/lib/mcp-ops.ts (MCP_TOOLS) — keep the two in sync; the dashboard's
 * e2e self-test fails loudly when this list drifts below 8 tools.
 *
 * Windows safety: pure Node, zero dependencies, no shell features, no path
 * assumptions (works from any cwd — Claude Desktop spawns it with its own),
 * no registry/WMIC probing. Node >= 18 (global fetch).
 */
'use strict';

var BRIDGE_NAME = 'web-dashboard';
var BRIDGE_VERSION = 'v1.40';
var PROTOCOL_VERSION = '2024-11-05';

var DASHBOARD_URL = (process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
var DASHBOARD_MCP_TOKEN = process.env.DASHBOARD_MCP_TOKEN || '';

// ---- tool catalog (mirror of src/lib/mcp-ops.ts MCP_TOOLS) ----
var TOOLS = [
  {
    name: 'dashboard_health',
    description: 'Dashboard liveness + version + project counts. Call this first to verify the bridge ↔ dashboard link works.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_projects',
    description: 'List all registered projects with their environments (name, command, port, run state).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'project_status',
    description: "Live run state of one project's environments (port liveness + owning pid, not just the DB row).",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id from list_projects' },
        envName: { type: 'string', description: 'Optional: restrict to one environment by name' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'start_process',
    description: 'Start a local project environment (same safety rails as the UI: reserved ports protected, command safety checked).',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, envName: { type: 'string' } },
      required: ['projectId', 'envName'],
    },
  },
  {
    name: 'stop_process',
    description: 'Stop a local project environment (tree kill + port-free verification — same rail as the UI stop button).',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, envName: { type: 'string' } },
      required: ['projectId', 'envName'],
    },
  },
  {
    name: 'restart_process',
    description: 'Restart a local project environment (stop → start with the same rails).',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, envName: { type: 'string' } },
      required: ['projectId', 'envName'],
    },
  },
  {
    name: 'get_logs',
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
  },
  {
    name: 'list_listening_ports',
    description: 'All listening TCP ports relevant to dashboard environments, joined with env/project context and the owning pid.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'exec_git_network',
    description: "Run a network git operation (pull or fetch) on a local project's repository — transient network errors are auto-retried, the configured proxy is honored.",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        envName: { type: 'string', description: 'Any environment of the project (identifies it unambiguously)' },
        op: { type: 'string', description: "'pull' or 'fetch'" },
      },
      required: ['projectId', 'envName', 'op'],
    },
  },
];

function logErr(msg) {
  try { process.stderr.write('[mcp-bridge] ' + msg + '\n'); } catch (e) { /* never crash on logging */ }
}

/** Send one JSON-RPC reply (single line, only protocol on stdout). */
function send(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (e) { logErr('stdout write failed: ' + (e && e.message)); }
}

function replyResult(id, result) { send({ jsonrpc: '2.0', id: id, result: result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }); }

/** Forward a tools/call to the dashboard's /api/mcp/<name> endpoint. */
function callDashboardTool(name, args) {
  var url = DASHBOARD_URL + '/api/mcp/' + encodeURIComponent(name);
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + DASHBOARD_MCP_TOKEN,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args || {}),
  }).then(function (res) {
    return res.text().then(function (text) {
      var body;
      try { body = JSON.parse(text); } catch (e) { body = { ok: false, httpStatus: res.status, raw: String(text).slice(0, 500) }; }
      if (!res.ok && body && body.error === undefined) {
        body = { ok: false, httpStatus: res.status, error: 'HTTP ' + res.status };
      }
      return body;
    });
  });
}

/** Dispatch one parsed JSON-RPC request. Notifications (no id) never reply. */
function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
    // Requests without a method are protocol garbage — only answerable when
    // an id exists; otherwise stay silent.
    if (msg && typeof msg === 'object' && 'id' in msg) {
      replyError(msg.id, -32600, 'invalid request');
    }
    return;
  }
  var id = msg.id; // undefined for notifications
  var params = (msg.params && typeof msg.params === 'object') ? msg.params : {};

  switch (msg.method) {
    case 'initialize':
      replyResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: BRIDGE_NAME, version: BRIDGE_VERSION },
      });
      return;

    case 'notifications/initialized':
    case 'notifications/cancelled':
      // Notifications are fire-and-forget by definition.
      return;

    case 'ping':
      replyResult(id, {});
      return;

    case 'tools/list':
      replyResult(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      var name = typeof params.name === 'string' ? params.name : '';
      var args = (params.arguments && typeof params.arguments === 'object') ? params.arguments : {};
      var known = TOOLS.some(function (t) { return t.name === name; });
      if (!known) {
        replyError(id, -32602, "unknown tool: " + name);
        return;
      }
      callDashboardTool(name, args)
        .then(function (apiResult) {
          replyResult(id, { content: [{ type: 'text', text: JSON.stringify(apiResult) }] });
        })
        .catch(function (err) {
          replyError(id, -32000, 'dashboard unreachable (' + DASHBOARD_URL + '): ' + (err && err.message ? err.message : String(err)));
        });
      return;
    }

    case 'resources/list':
      replyResult(id, { resources: [] });
      return;

    case 'prompts/list':
      replyResult(id, { prompts: [] });
      return;

    default:
      if (id !== undefined) replyError(id, -32601, "method not found: " + msg.method);
      return;
  }
}

// ---- startup sanity ----
if (typeof fetch !== 'function') {
  logErr('Node ' + process.version + ' has no global fetch — Node >= 18 is required.');
  process.exit(1);
}
if (!DASHBOARD_URL || !DASHBOARD_MCP_TOKEN) {
  // Configured by the dashboard's config patcher; a manual setup without env
  // is a wiring mistake worth explaining on stderr (stdout stays protocol-clean).
  logErr('missing env: DASHBOARD_URL and DASHBOARD_MCP_TOKEN must both be set (the dashboard writes them into claude_desktop_config.json).');
  process.exit(1);
}

// ---- newline-delimited stdin framing ----
var buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  buf += chunk;
  var idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    var line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch (e) {
      // Malformed line: never crash, never reply (we have no id to reply to).
      logErr('ignoring malformed line: ' + String(line).slice(0, 200));
    }
  }
});
process.stdin.on('end', function () {
  // Client closed the pipe — exit cleanly (Claude Desktop restarts us on demand).
  process.exit(0);
});
process.stdin.on('error', function (e) { logErr('stdin error: ' + (e && e.message)); });
process.on('uncaughtException', function (e) {
  logErr('uncaught exception (staying alive): ' + (e && e.stack ? e.stack : String(e)));
});

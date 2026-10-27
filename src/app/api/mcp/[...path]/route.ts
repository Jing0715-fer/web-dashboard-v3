import { NextRequest, NextResponse } from 'next/server';
import { requireMcpToken } from '@/lib/claude-desktop';
import { MCP_TOOLS, MCP_TOOL_NAMES, validateToolInput } from '@/lib/mcp-ops';

export const dynamic = 'force-dynamic';

/**
 * POST /api/mcp/<tool> — the endpoint the Claude Desktop bridge calls.
 *
 * Auth is the per-installation Bearer token (timing-safe compare inside
 * requireMcpToken) — NOT a user session, because the caller is the local
 * stdio script Claude Desktop spawns. Tool names are the catch-all path
 * segments (joined with '/'), dispatched through the same MCP_TOOLS map the
 * bridge advertises, so the two can never drift apart.
 *
 * Body: the tool's arguments as a JSON object (the bridge forwards Claude's
 * `arguments` verbatim). Response: the tool's JSON result — always a
 * JSON-serializable object with an `ok` field.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const guard = await requireMcpToken(req);
  if (guard.error) return guard.error;

  const { path: segments } = await ctx.params;
  const name = (segments || []).filter(Boolean).join('/').trim();
  const tool = MCP_TOOLS[name];
  if (!tool) {
    return NextResponse.json(
      { ok: false, error: `unknown MCP tool: ${name || '(empty)'}`, available: MCP_TOOL_NAMES },
      { status: 404 },
    );
  }

  let args: Record<string, unknown> = {};
  try {
    const body = await req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) args = body as Record<string, unknown>;
  } catch {
    // Empty or non-JSON body → {} (tools without required args still work).
  }

  const invalid = validateToolInput(tool.inputSchema, args);
  if (invalid) {
    return NextResponse.json({ ok: false, error: `${name}: ${invalid}` }, { status: 400 });
  }

  try {
    const result = await tool.handler(args);
    return NextResponse.json(result);
  } catch (e: unknown) {
    // A thrown error here is a dashboard bug, not a tool-level failure —
    // still answered as JSON so the bridge/Claude sees a parseable result.
    return NextResponse.json(
      { ok: false, error: String((e as Error)?.message || e).slice(0, 300) },
      { status: 500 },
    );
  }
}

/**
 * GET /api/mcp/* — not part of the protocol (the bridge only POSTs).
 * A tiny health hint instead of a bare 405, so a curious human poking the
 * endpoint learns where the tools live.
 */
export async function GET() {
  return NextResponse.json(
    {
      error: 'method not allowed — POST tool arguments as JSON; tools: ' + MCP_TOOL_NAMES.join(', '),
    },
    { status: 405 },
  );
}

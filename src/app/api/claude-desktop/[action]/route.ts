import { NextRequest, NextResponse } from 'next/server';
import { ensureBootstrap, requireApprovedUser, requireAdmin } from '@/lib/auth';
import {
  readClaudeDesktopStatus,
  patchClaudeDesktopConfig,
  removeClaudeDesktopMcpEntry,
  rotateMcpToken,
  testClaudeDesktopE2E,
  askClaude,
  buildMcpServerEntry,
  dashboardBaseUrl,
  getOrCreateMcpToken,
} from '@/lib/claude-desktop';

export const dynamic = 'force-dynamic';

/**
 * /api/claude-desktop/<action> — the settings dialog's Claude Desktop
 * section. `status` is read-only (GET or POST, any approved user); every
 * mutation (install-mcp / remove-mcp / rotate-token / test / ask) requires
 * an admin session — the config patch writes to the user's home directory
 * and the token is a local secret.
 */

/** Read-only status payload (shared by GET and POST 'status'). */
async function statusPayload(): Promise<NextResponse> {
  try {
    const status = await readClaudeDesktopStatus();
    // Entry preview with a MASKED token: the real 64-hex value lives in
    // claude_desktop_config.json on this machine — the API never echoes it.
    let entryPreview: { command: string; args: string[]; env: { DASHBOARD_URL: string; DASHBOARD_MCP_TOKEN: string } } | null = null;
    const token = status.tokenConfigured ? await getOrCreateMcpToken() : '';
    if (token) {
      const entry = buildMcpServerEntry(dashboardBaseUrl(), token);
      entryPreview = {
        ...entry,
        env: {
          DASHBOARD_URL: entry.env.DASHBOARD_URL,
          DASHBOARD_MCP_TOKEN: `${token.slice(0, 8)}…${token.slice(-4)} (${token.length} hex chars)`,
        },
      };
    }
    return NextResponse.json({ ok: true, ...status, entryPreview });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: String((e as Error)?.message || e).slice(0, 300) },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (action !== 'status') {
    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 404 });
  }
  try {
    await ensureBootstrap();
    const guard = await requireApprovedUser(req);
    if (guard.error) return guard.error;
    return statusPayload();
  } catch (e: unknown) {
    return NextResponse.json(
      { error: String((e as Error)?.message || e).slice(0, 300) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;

  // status is read-only — accept it on POST too (dialog code symmetry).
  if (action === 'status') {
    try {
      await ensureBootstrap();
      const guard = await requireApprovedUser(req);
      if (guard.error) return guard.error;
      return statusPayload();
    } catch (e: unknown) {
      return NextResponse.json(
        { error: String((e as Error)?.message || e).slice(0, 300) },
        { status: 500 },
      );
    }
  }

  try {
    await ensureBootstrap();
    const guard = await requireAdmin(req);
    if (guard.error) return guard.error;

    switch (action) {
      case 'install-mcp': {
        // Patch claude_desktop_config.json (merge-preserving, backup-first,
        // idempotent). Pass the whole result through — the dialog shows the
        // backup path and the preserved server names.
        const r = await patchClaudeDesktopConfig();
        return NextResponse.json(r, { status: r.ok ? 200 : 400 });
      }

      case 'remove-mcp': {
        const r = await removeClaudeDesktopMcpEntry();
        return NextResponse.json(r, { status: r.ok ? 200 : 400 });
      }

      case 'rotate-token': {
        // The new token is written to the DB only — the caller must re-run
        // install-mcp to propagate it into claude_desktop_config.json (the
        // old bridge env keeps the dead token until then, by design).
        const token = await rotateMcpToken();
        if (!token) {
          return NextResponse.json({ ok: false, error: 'token rotation failed (database error)' }, { status: 500 });
        }
        return NextResponse.json({
          ok: true,
          rotated: true,
          tokenMasked: `${token.slice(0, 8)}…${token.slice(-4)}`,
          note: 're-run install to write the new token into claude_desktop_config.json',
        });
      }

      case 'test': {
        // Full pipeline test — steps are independent; the result carries the
        // complete picture ({ ok, steps: [{id,label,status,detail,ms}], simulated }).
        const r = await testClaudeDesktopE2E();
        return NextResponse.json(r);
      }

      case 'ask': {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const prompt = typeof body.prompt === 'string' ? body.prompt : '';
        if (!prompt.trim()) {
          return NextResponse.json({ ok: false, error: 'prompt (non-empty string) is required' }, { status: 400 });
        }
        // May take up to ~90s when the real CLI answers (headless round-trip).
        const r = await askClaude(prompt);
        return NextResponse.json(r, { status: r.ok ? 200 : 400 });
      }

      default:
        return NextResponse.json({ error: `unknown action: ${action}` }, { status: 404 });
    }
  } catch (e: unknown) {
    return NextResponse.json(
      { error: String((e as Error)?.message || e).slice(0, 300) },
      { status: 500 },
    );
  }
}

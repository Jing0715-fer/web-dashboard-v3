import { NextResponse } from 'next/server';
import { detectRepairClis, CLI_ROUNDS, CLI_ROUND_TIMEOUT_MS } from '@/lib/llm-repair/cli-delegate';
import { requireApprovedUser } from '@/lib/auth';

/**
 * GET /api/llm-config/detect-repair-cli
 *
 * Locates the agent CLIs the CLI-delegated repair engine can delegate to
 * (Claude Code / Codex / Gemini / OpenCode / Hermes) on this machine's PATH,
 * with their versions. Powers the engine selector in the LLM settings
 * dialog: options are marked installed/not, and "auto" resolution order is
 * the array order (priority-sorted).
 */
export async function GET(req: Request) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const clis = await detectRepairClis();
    return NextResponse.json({
      clis,
      anyInstalled: clis.some((c) => c.found),
      // Engine facts surfaced to the dialog so the mode description can be
      // accurate without hardcoding the constants twice.
      rounds: CLI_ROUNDS,
      roundTimeoutMs: CLI_ROUND_TIMEOUT_MS,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to detect agent CLIs: ${String((e as Error)?.message || e).slice(0, 200)}` },
      { status: 500 },
    );
  }
}

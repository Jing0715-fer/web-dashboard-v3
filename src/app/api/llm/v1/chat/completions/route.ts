import { NextRequest, NextResponse } from 'next/server';
import { chatCompletionsResponse } from '@/lib/llm-gateway';

/**
 * POST /api/llm/v1/chat/completions — OpenAI-compatible bridge.
 *
 * Unauthenticated by design (same exposure as the former standalone
 * llm-gateway): the local dsh agent and peer machines' agents call it with
 * arbitrary Bearer tokens and no dashboard session cookie.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { message: 'Invalid JSON body', type: 'gateway_error', code: 400 } },
      { status: 400 },
    );
  }
  return chatCompletionsResponse(body);
}

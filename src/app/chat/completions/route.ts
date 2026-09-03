import { NextRequest, NextResponse } from 'next/server';
import { chatCompletionsResponse } from '@/lib/llm-gateway';

/**
 * POST /chat/completions — root-level fallback for the LLM gateway.
 *
 * dsh (deepseek-harness) constructs its OpenAI client from the gateway
 * baseURL but drops the path portion, so it always calls
 * <origin>/chat/completions. The former standalone gateway accepted this
 * route at its root; this route keeps that contract so the agent works
 * unchanged. Same handler as /api/llm/v1/chat/completions.
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

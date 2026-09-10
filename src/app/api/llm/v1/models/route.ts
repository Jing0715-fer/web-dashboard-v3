import { NextRequest } from 'next/server';
import { modelsResponse } from '@/lib/llm-gateway';

/**
 * GET /api/llm/v1/models — OpenAI-compatible model list.
 *
 * Unauthenticated by design: this endpoint (and /chat/completions) is the
 * in-process replacement of the former llm-gateway mini-service and is called
 * by the local dsh agent and by peer machines' agents over the LAN, none of
 * which carry dashboard session cookies.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  return modelsResponse();
}

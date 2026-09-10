import { NextRequest } from 'next/server';
import { modelsResponse } from '@/lib/llm-gateway';

/**
 * GET /models — root-level fallback for the LLM gateway.
 *
 * dsh drops the path portion of the gateway baseURL (see
 * /chat/completions/route.ts); the former standalone gateway answered
 * /models at its root, and this route keeps that contract.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  return modelsResponse();
}

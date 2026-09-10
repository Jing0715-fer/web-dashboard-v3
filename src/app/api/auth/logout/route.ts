import { NextResponse } from 'next/server'
import {
  buildClearedSessionCookie,
  withSessionCookie,
  sessionTokenFromRequest,
  revokeSessionByToken,
} from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/logout → 200 { ok: true, revoked: boolean } + clears the
 * session cookie. Also revokes the server-side Session row for the token the
 * request authenticated with (Task 19), so a "stolen" logged-out token can
 * never be replayed.
 */
export async function POST(req: Request) {
  let revoked = false
  try {
    const token = sessionTokenFromRequest(req)
    if (token) revoked = await revokeSessionByToken(token)
  } catch {
    /* revocation is best-effort — the cookie clear below is authoritative */
  }
  return withSessionCookie(NextResponse.json({ ok: true, revoked }), buildClearedSessionCookie())
}

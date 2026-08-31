import { NextResponse } from 'next/server'
import { buildClearedSessionCookie, withSessionCookie } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** POST /api/auth/logout → 200 { ok: true } + clears the session cookie. */
export async function POST() {
  return withSessionCookie(NextResponse.json({ ok: true }), buildClearedSessionCookie())
}

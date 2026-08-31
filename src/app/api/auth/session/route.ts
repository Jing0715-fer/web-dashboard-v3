import { NextResponse } from 'next/server'
import { ensureBootstrap, getSessionUser, computeShowSeedHint } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/auth/session
 *   → 200 { user: PublicUser | null, showSeedHint: boolean }
 *
 * The session is returned regardless of status (pending / rejected users get
 * their user object so the frontend can render the approval screen).
 * showSeedHint is true only while the system is pristine: exactly one user,
 * the seeded admin, password never changed.
 */
export async function GET(req: Request) {
  try {
    await ensureBootstrap()
    const [user, showSeedHint] = await Promise.all([getSessionUser(req), computeShowSeedHint()])
    return NextResponse.json({ user, showSeedHint })
  } catch (err) {
    console.error('[auth/session] failed:', err)
    return NextResponse.json({ error: 'Failed to load session' }, { status: 500 })
  }
}

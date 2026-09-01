import { NextResponse } from 'next/server'
import { logActivity } from '@/lib/activity'
import {
  ensureBootstrap,
  requireApprovedUser,
  sessionTokenFromRequest,
  findSessionById,
  hashSessionToken,
  revokeSessionById,
} from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * DELETE /api/auth/sessions/[id]  (Task 19)
 * Revoke a single active session. Users may revoke their own sessions
 * (except the one they are currently using — sign out instead); admins may
 * revoke anyone's, including another user's current session (that user is
 * signed out on their next request).
 *   → 200 { ok: true, wasCurrent: boolean }
 *   → 400 trying to revoke your own current session
 *   → 403 not your session (and not admin)
 *   → 404 unknown session id
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap()
    const guard = await requireApprovedUser(req)
    if (guard.error) return guard.error
    const user = guard.user

    const { id } = await ctx.params
    const currentToken = sessionTokenFromRequest(req)

    // Ownership / target checks BEFORE the revocation takes effect.
    const target = await findSessionById(id)
    if (!target) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    const isAdmin = user.role === 'admin'
    if (target.userId !== user.id && !isAdmin) {
      return NextResponse.json({ error: 'You can only revoke your own sessions' }, { status: 403 })
    }
    const wasCurrent = !!currentToken && target.tokenHash === hashSessionToken(currentToken)
    if (wasCurrent && target.userId === user.id) {
      return NextResponse.json(
        { error: 'This is your current session — use sign out instead' },
        { status: 400 },
      )
    }

    await revokeSessionById(id, currentToken)

    logActivity({
      type: 'user',
      level: 'warn',
      message: `Session ${id} revoked`,
      detail:
        target.userId === user.id
          ? `by ${user.name} (self)`
          : `by admin ${user.name} (user ${target.userId})`,
    })

    return NextResponse.json({ ok: true, wasCurrent })
  } catch (err) {
    console.error('[auth/sessions DELETE] failed:', err)
    return NextResponse.json({ error: 'Failed to revoke session' }, { status: 500 })
  }
}

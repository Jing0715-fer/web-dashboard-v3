import { NextResponse } from 'next/server'
import { logActivity } from '@/lib/activity'
import {
  ensureBootstrap,
  requireApprovedUser,
  sessionTokenFromRequest,
  hashSessionToken,
  listUserSessions,
  listAllSessions,
  toSessionInfo,
  pruneSessions,
  revokeAllUserSessions,
} from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/auth/sessions[?scope=all]  (Task 19)
 *   → 200 { scope: 'mine' | 'all', sessions: SessionInfo[] }
 *
 * Non-admins always see their own active sessions. Admins may pass
 * ?scope=all to list every active session in the system (with user info).
 * The session the request authenticated with is flagged `current: true`.
 */
export async function GET(req: Request) {
  try {
    await ensureBootstrap()
    const guard = await requireApprovedUser(req)
    if (guard.error) return guard.error
    const user = guard.user

    const wantsAll = new URL(req.url).searchParams.get('scope') === 'all'
    const isAdmin = user.role === 'admin'
    const scope = wantsAll && isAdmin ? 'all' : 'mine'

    await pruneSessions()
    const rows = scope === 'all' ? await listAllSessions() : await listUserSessions(user.id)
    const currentHash = hashSessionToken(sessionTokenFromRequest(req) ?? '')

    return NextResponse.json({
      scope,
      sessions: rows.map((row) => toSessionInfo(row, currentHash)),
    })
  } catch (err) {
    console.error('[auth/sessions GET] failed:', err)
    return NextResponse.json({ error: 'Failed to load sessions' }, { status: 500 })
  }
}

/**
 * POST /api/auth/sessions  body { userId? }  (Task 19)
 * Revoke ALL active sessions of a user. Default target: the caller.
 * Non-admins can only revoke their own (their current session is kept).
 * Admins may target any user via body.userId — every session of that user
 * (including their current one) is revoked.
 *   → 200 { ok: true, revokedCount }
 */
export async function POST(req: Request) {
  try {
    await ensureBootstrap()
    const guard = await requireApprovedUser(req)
    if (guard.error) return guard.error
    const user = guard.user

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const rawUserId = typeof body.userId === 'string' ? body.userId : ''
    const targetUserId = rawUserId || user.id

    if (targetUserId !== user.id && user.role !== 'admin') {
      return NextResponse.json({ error: 'You can only revoke your own sessions' }, { status: 403 })
    }

    // Keep the caller's current session alive when they revoke their own;
    // an admin revoking another user's sessions has no such exception.
    const exceptToken = targetUserId === user.id ? sessionTokenFromRequest(req) : null
    const revokedCount = await revokeAllUserSessions(targetUserId, exceptToken)

    logActivity({
      type: 'user',
      level: 'warn',
      message:
        targetUserId === user.id
          ? `User '${user.name}' revoked ${revokedCount} other session(s)`
          : `Admin '${user.name}' revoked all ${revokedCount} session(s) of user '${targetUserId}'`,
    })

    return NextResponse.json({ ok: true, revokedCount })
  } catch (err) {
    console.error('[auth/sessions POST] failed:', err)
    return NextResponse.json({ error: 'Failed to revoke sessions' }, { status: 500 })
  }
}

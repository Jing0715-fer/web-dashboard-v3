import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  ensureBootstrap,
  requireApprovedUser,
  isValidPassword,
  verifyPassword,
  hashPassword,
} from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/change-password  body { currentPassword, newPassword }
 *   → 200 { ok: true }   (sets passwordChangedAt — hides the seed hint)
 *   → 400 { error }      — invalid body / weak password / Google-only account
 *   → 401 { error }      — not signed in, or 'Current password is incorrect'
 */
export async function POST(req: Request) {
  try {
    await ensureBootstrap()
    const guard = await requireApprovedUser(req)
    if (guard.error) return guard.error

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''

    const user = await db.user.findUnique({ where: { id: guard.user.id } })
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    if (!user.passwordHash) {
      return NextResponse.json(
        { error: 'This account signs in with Google' },
        { status: 400 },
      )
    }
    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { error: 'Current password and new password are required' },
        { status: 400 },
      )
    }
    if (!isValidPassword(newPassword)) {
      return NextResponse.json(
        { error: 'New password must be at least 8 characters and contain a letter and a digit' },
        { status: 400 },
      )
    }

    if (!verifyPassword(currentPassword, user.passwordHash)) {
      return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 })
    }

    await db.user.update({
      where: { id: user.id },
      data: {
        passwordHash: hashPassword(newPassword),
        passwordChangedAt: new Date(),
      },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[auth/change-password] failed:', err)
    return NextResponse.json({ error: 'Failed to change password' }, { status: 500 })
  }
}

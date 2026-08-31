import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  ensureBootstrap,
  loginRateLimited,
  recordLoginFailure,
  clearLoginFailures,
  clientIp,
  normalizeEmail,
  verifyPassword,
  toPublicUser,
  buildSessionCookieForUser,
  withSessionCookie,
  type UserRow,
} from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/login  body { email, password, remember? }
 *   → 200 { user: PublicUser }  + sets dash_session cookie (7d / 30d)
 *   → 401 { error: 'Invalid email or password' }
 *   → 403 { error, code: 'pending' | 'rejected', rejectionReason? }
 *   → 429 { error }  — 5 failed attempts within 15 minutes (per email|ip)
 */
export async function POST(req: Request) {
  try {
    await ensureBootstrap()

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const email = normalizeEmail(body.email)
    const password = typeof body.password === 'string' ? body.password : ''
    const remember = body.remember === true

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
    }

    const ip = clientIp(req)
    if (loginRateLimited(email, ip)) {
      return NextResponse.json(
        { error: 'Too many failed login attempts. Please try again in 15 minutes.' },
        { status: 429 },
      )
    }

    const user = (await db.user.findUnique({ where: { email } })) as UserRow | null
    const passwordOk = user?.passwordHash ? verifyPassword(password, user.passwordHash) : false

    if (!user || !passwordOk) {
      recordLoginFailure(email, ip)
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    }

    // Password correct — status gate (do NOT count these as failed attempts).
    if (user.status === 'pending') {
      return NextResponse.json(
        { error: 'Your account is awaiting administrator approval', code: 'pending' },
        { status: 403 },
      )
    }
    if (user.status === 'rejected') {
      return NextResponse.json(
        {
          error: 'Your registration application was rejected',
          code: 'rejected',
          rejectionReason: user.rejectionReason ?? null,
        },
        { status: 403 },
      )
    }

    clearLoginFailures(email, ip)

    const now = new Date()
    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: now } })

    const cookie = await buildSessionCookieForUser(user.id, remember)
    return withSessionCookie(
      NextResponse.json({ user: toPublicUser({ ...user, lastLoginAt: now }) }),
      cookie,
    )
  } catch (err) {
    console.error('[auth/login] failed:', err)
    return NextResponse.json({ error: 'Login failed' }, { status: 500 })
  }
}

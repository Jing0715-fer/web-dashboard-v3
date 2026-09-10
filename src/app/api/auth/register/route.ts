import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity'
import {
  ensureBootstrap,
  registerRateLimited,
  clientIp,
  normalizeEmail,
  isValidEmail,
  isValidName,
  isValidPassword,
  hashPassword,
} from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/register  body { name, email, password }
 *   → 201 { ok: true }               — new user created as `pending`
 *   → 400 { error }                   — validation failure
 *   → 409 { error: 'Email already registered' }
 *   → 429 { error }                   — rate limited (10/hour per IP)
 */
export async function POST(req: Request) {
  try {
    await ensureBootstrap()

    const ip = clientIp(req)
    if (registerRateLimited(ip)) {
      return NextResponse.json(
        { error: 'Too many registration attempts. Please try again later.' },
        { status: 429 },
      )
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const email = normalizeEmail(body.email)
    const password = typeof body.password === 'string' ? body.password : ''

    if (!isValidName(name)) {
      return NextResponse.json({ error: 'Name must be 2–40 characters' }, { status: 400 })
    }
    if (!isValidEmail(email)) {
      return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 })
    }
    if (!isValidPassword(password)) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters and contain a letter and a digit' },
        { status: 400 },
      )
    }

    const existing = await db.user.findUnique({ where: { email } })
    if (existing) {
      return NextResponse.json({ error: 'Email already registered' }, { status: 409 })
    }

    let user
    try {
      user = await db.user.create({
        data: {
          email,
          name,
          passwordHash: hashPassword(password),
          role: 'user',
          status: 'pending',
          provider: 'credentials',
        },
      })
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        return NextResponse.json({ error: 'Email already registered' }, { status: 409 })
      }
      throw err
    }

    logActivity({
      type: 'user',
      level: 'info',
      message: `User '${user.name}' registered (awaiting approval)`,
      detail: email,
    })

    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (err) {
    console.error('[auth/register] failed:', err)
    return NextResponse.json({ error: 'Registration failed' }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity'
import {
  ensureBootstrap,
  getGoogleSettings,
  googleRedirectUri,
  originFromReq,
  normalizeEmail,
  createSessionToken,
  buildSessionCookie,
  OAUTH_STATE_COOKIE,
} from '@/lib/auth'

export const dynamic = 'force-dynamic'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'

/**
 * GET /api/auth/google/callback?code&state
 *
 * Full OAuth 2.0 code exchange:
 *   1. state must match the oauth_state cookie → else /?authError=state_mismatch
 *   2. exchange the code (client_id + client_secret + redirect_uri)
 *   3. fetch userinfo, require email_verified
 *   4. find-or-create the user (googleId / email with provider google)
 *      - email already used by a credentials account → /?authError=email_conflict
 *      - rejected user → /?authError=rejected
 *      - pending / approved → issue dash_session, redirect to /
 */
export async function GET(req: Request) {
  try {
    await ensureBootstrap()

    const url = new URL(req.url)
    const origin = originFromReq(req)
    const fail = (reason: string) =>
      NextResponse.redirect(`${origin}/?authError=${encodeURIComponent(reason)}`, 302)

    const oauthError = url.searchParams.get('error')
    if (oauthError) return fail(oauthError)

    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const cookieHeader = req.headers.get('cookie') ?? ''
    const expectedState = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${OAUTH_STATE_COOKIE}=`))
      ?.slice(OAUTH_STATE_COOKIE.length + 1)

    if (!code || !state || !expectedState || state !== expectedState) {
      return fail('state_mismatch')
    }

    const settings = await getGoogleSettings()
    if (!settings) return fail('not_configured')

    const redirectUri = googleRedirectUri(req)

    // --- 1. exchange the authorization code for tokens -------------------
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!tokenRes.ok) {
      console.error('[auth/google/callback] token exchange failed:', tokenRes.status)
      return fail('token_exchange_failed')
    }
    const tokens = (await tokenRes.json().catch(() => ({}))) as { access_token?: string }
    if (!tokens.access_token) return fail('token_exchange_failed')

    // --- 2. fetch the profile --------------------------------------------
    const userinfoRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!userinfoRes.ok) return fail('userinfo_failed')
    const profile = (await userinfoRes.json().catch(() => ({}))) as {
      sub?: string
      email?: string
      email_verified?: boolean
      name?: string
      picture?: string
    }
    const email = normalizeEmail(profile.email)
    if (!profile.sub || !email || profile.email_verified !== true) {
      return fail('email_not_verified')
    }

    // --- 3. find or create the local user ---------------------------------
    let user = await db.user.findFirst({
      where: { OR: [{ googleId: profile.sub }, { email, provider: 'google' }] },
    })

    if (!user) {
      const emailOwner = await db.user.findUnique({ where: { email } })
      if (emailOwner && emailOwner.provider === 'credentials') {
        return fail('email_conflict')
      }
      user = await db.user.create({
        data: {
          email,
          name: (profile.name || email.split('@')[0] || 'Google user').slice(0, 40),
          provider: 'google',
          googleId: profile.sub,
          avatarUrl: profile.picture ?? null,
          status: 'pending',
          role: 'user',
        },
      })
      logActivity({
        type: 'user',
        level: 'info',
        message: `User '${user.name}' registered (awaiting approval)`,
        detail: `${email} (Google)`,
      })
    }

    if (user.status === 'rejected') {
      return fail('rejected')
    }

    // --- 4. issue the session (pending users get one too — the frontend
    //        renders the approval screen from user.status) -----------------
    await db.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        ...(user.googleId ? {} : { googleId: profile.sub }),
        ...(user.avatarUrl ? {} : { avatarUrl: profile.picture ?? null }),
      },
    })

    const token = await createSessionToken(user.id)
    const res = NextResponse.redirect(`${origin}/`, 302)
    res.headers.append('set-cookie', buildSessionCookie(token))
    // consume the state cookie
    res.headers.append(
      'set-cookie',
      `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    )
    return res
  } catch (err) {
    console.error('[auth/google/callback] failed:', err)
    return NextResponse.redirect(
      `${originFromReq(req)}/?authError=${encodeURIComponent('internal_error')}`,
      302,
    )
  }
}

import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { ensureBootstrap, getGoogleSettings, googleRedirectUri, OAUTH_STATE_COOKIE } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/auth/google — start the Google OAuth 2.0 flow.
 *   → 501 { error: 'Google sign-in is not configured' } when no credentials
 *   → 302 https://accounts.google.com/o/oauth2/v2/auth?... + oauth_state cookie
 */
export async function GET(req: Request) {
  try {
    await ensureBootstrap()
    const settings = await getGoogleSettings()
    if (!settings) {
      return NextResponse.json({ error: 'Google sign-in is not configured' }, { status: 501 })
    }

    const state = randomBytes(16).toString('hex')
    const redirectUri = googleRedirectUri(req)

    const params = new URLSearchParams({
      client_id: settings.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    })
    // URLSearchParams encodes spaces as '+', which Google accepts verbatim.
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`

    const res = NextResponse.redirect(authUrl, 302)
    res.headers.append(
      'set-cookie',
      `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    )
    return res
  } catch (err) {
    console.error('[auth/google] failed:', err)
    return NextResponse.json({ error: 'Failed to start Google sign-in' }, { status: 500 })
  }
}

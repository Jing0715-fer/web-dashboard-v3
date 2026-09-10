import { NextResponse } from 'next/server'
import { ensureBootstrap, getGoogleSettings, googleRedirectUri, maskClientId } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/auth/google/status
 *   → 200 { configured, redirectUri, clientIdMasked }
 * Works for any caller (the login screen needs it pre-auth).
 */
export async function GET(req: Request) {
  try {
    await ensureBootstrap()
    const settings = await getGoogleSettings()
    return NextResponse.json({
      configured: !!settings,
      redirectUri: googleRedirectUri(req),
      clientIdMasked: settings ? maskClientId(settings.clientId) : null,
    })
  } catch (err) {
    console.error('[auth/google/status] failed:', err)
    return NextResponse.json({ error: 'Failed to load Google sign-in status' }, { status: 500 })
  }
}

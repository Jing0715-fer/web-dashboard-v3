import { NextResponse } from 'next/server'
import { logActivity } from '@/lib/activity'
import {
  ensureBootstrap,
  requireAdmin,
  getGoogleSettings,
  saveGoogleSettings,
  googleRedirectUri,
  maskClientId,
} from '@/lib/auth'

export const dynamic = 'force-dynamic'

function googlePayload(req: Request) {
  return getGoogleSettings().then((settings) => ({
    google: {
      configured: !!settings,
      clientIdMasked: settings ? maskClientId(settings.clientId) : null,
      redirectUri: googleRedirectUri(req),
    },
  }))
}

/**
 * GET /api/admin/settings  (admin only)
 *   → 200 { google: { configured, clientIdMasked, redirectUri } }
 */
export async function GET(req: Request) {
  try {
    await ensureBootstrap()
    const guard = await requireAdmin(req)
    if (guard.error) return guard.error
    return NextResponse.json(await googlePayload(req))
  } catch (err) {
    console.error('[admin/settings GET] failed:', err)
    return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 })
  }
}

/**
 * PUT /api/admin/settings  body { googleClientId?, googleClientSecret? }
 * Stored in AppSetting `auth.google` = {"clientId","clientSecret"} (JSON).
 * Empty-string values clear the setting. Response is masked (same shape as GET).
 */
export async function PUT(req: Request) {
  try {
    await ensureBootstrap()
    const guard = await requireAdmin(req)
    if (guard.error) return guard.error

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const { googleClientId, googleClientSecret } = body

    if (googleClientId !== undefined && typeof googleClientId !== 'string') {
      return NextResponse.json({ error: 'googleClientId must be a string' }, { status: 400 })
    }
    if (googleClientSecret !== undefined && typeof googleClientSecret !== 'string') {
      return NextResponse.json({ error: 'googleClientSecret must be a string' }, { status: 400 })
    }

    // Lenient clientId validation: accept any non-empty string (the real
    // Google format is <digits>-<hash>.apps.googleusercontent.com but we do
    // not hard-fail on it — misconfigured credentials surface at OAuth time).
    const clientId = (typeof googleClientId === 'string' ? googleClientId : undefined)?.trim()
    const clientSecret = (typeof googleClientSecret === 'string' ? googleClientSecret : undefined)?.trim()

    if (clientId !== undefined && clientId !== '' && /\s/.test(clientId)) {
      return NextResponse.json({ error: 'googleClientId contains whitespace' }, { status: 400 })
    }

    const current = await getGoogleSettings()
    const nextClientId = clientId !== undefined ? clientId : current?.clientId ?? ''
    const nextClientSecret = clientSecret !== undefined ? clientSecret : current?.clientSecret ?? ''

    if (nextClientId === '' || nextClientSecret === '') {
      // Empty-string values → clear the setting entirely.
      await saveGoogleSettings(null)
    } else {
      await saveGoogleSettings({ clientId: nextClientId, clientSecret: nextClientSecret })
      logActivity({
        type: 'user',
        level: 'info',
        message: 'Google sign-in credentials updated',
        detail: `by ${guard.user.name}`,
      })
    }

    return NextResponse.json(await googlePayload(req))
  } catch (err) {
    console.error('[admin/settings PUT] failed:', err)
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 })
  }
}

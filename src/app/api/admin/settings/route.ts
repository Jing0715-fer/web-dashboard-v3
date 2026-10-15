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
import { getGitNetConfig, saveGitNetProxy, maskProxyUrl, isValidProxyUrl } from '@/lib/git-net-config'

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

/** v1.27: git network config for the payload (proxy shown masked — it may
 *  embed credentials; the admin UI sends the full value only on change). */
async function gitNetPayload() {
  const cfg = await getGitNetConfig()
  return {
    git: {
      proxyConfigured: !!cfg.proxy,
      proxyMasked: cfg.proxy ? maskProxyUrl(cfg.proxy) : null,
      proxySource: cfg.proxySource,
    },
  }
}

/**
 * GET /api/admin/settings  (admin only)
 *   → 200 { google: {…}, git: { proxyConfigured, proxyMasked, proxySource } }
 */
export async function GET(req: Request) {
  try {
    await ensureBootstrap()
    const guard = await requireAdmin(req)
    if (guard.error) return guard.error
    return NextResponse.json({ ...(await googlePayload(req)), ...(await gitNetPayload()) })
  } catch (err) {
    console.error('[admin/settings GET] failed:', err)
    return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 })
  }
}

/**
 * PUT /api/admin/settings  body { googleClientId?, googleClientSecret?, gitProxy? }
 * Google OAuth stored in AppSetting `auth.google` = {"clientId","clientSecret"} (JSON).
 * Git proxy stored in AppSetting `git.network` = {"proxy": "…"} (v1.27) — wired
 * into fetch / ls-remote / update-check calls via `git -c http.proxy=…`.
 * Empty-string values clear the setting. Response is masked (same shape as GET).
 */
export async function PUT(req: Request) {
  try {
    await ensureBootstrap()
    const guard = await requireAdmin(req)
    if (guard.error) return guard.error

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const { googleClientId, googleClientSecret, gitProxy } = body

    if (googleClientId !== undefined && typeof googleClientId !== 'string') {
      return NextResponse.json({ error: 'googleClientId must be a string' }, { status: 400 })
    }
    if (googleClientSecret !== undefined && typeof googleClientSecret !== 'string') {
      return NextResponse.json({ error: 'googleClientSecret must be a string' }, { status: 400 })
    }
    if (gitProxy !== undefined && typeof gitProxy !== 'string') {
      return NextResponse.json({ error: 'gitProxy must be a string' }, { status: 400 })
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

    // v1.27: git proxy — validated shape (http(s)/socks5 URL) or '' to clear.
    if (gitProxy !== undefined) {
      const p = gitProxy.trim()
      if (p !== '' && !isValidProxyUrl(p)) {
        return NextResponse.json({ error: 'gitProxy must be an http(s):// or socks5:// URL (e.g. http://127.0.0.1:7890)' }, { status: 400 })
      }
      await saveGitNetProxy(p)
      logActivity({
        type: 'user',
        level: 'info',
        message: p === '' ? 'Git proxy cleared' : `Git proxy set to ${maskProxyUrl(p)}`,
        detail: `by ${guard.user.name}`,
      })
    }

    return NextResponse.json({ ...(await googlePayload(req)), ...(await gitNetPayload()) })
  } catch (err) {
    console.error('[admin/settings PUT] failed:', err)
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 })
  }
}

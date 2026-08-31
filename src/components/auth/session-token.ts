'use client'

/**
 * localStorage bearer-token channel for the dashboard session.
 *
 * Why: the sandbox preview embeds the app in a cross-site iframe, where
 * browsers block `SameSite=Lax` (third-party) cookies. The login response
 * therefore also returns the raw session token in its body; we persist it in
 * localStorage and inject it as `Authorization: Bearer <token>` on every
 * same-origin `/api/*` request via a one-time window.fetch patch. The server
 * accepts the token from cookie, header, or `?auth_token=` query — so direct
 * localhost access (cookies) and preview iframe access (bearer) both work.
 */

const TOKEN_KEY = 'dash_session_token'

export function getSessionToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setSessionToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* storage unavailable (private mode etc.) — cookie channel still applies */
  }
}

export function clearSessionToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

let patchInstalled = false

/**
 * Idempotently patch window.fetch so same-origin `/api/*` requests carry the
 * stored bearer token. Requests without a stored token pass through untouched;
 * requests that already set an Authorization header are never overridden;
 * cross-origin URLs (remote device agents) are never touched.
 */
export function installAuthFetchPatch(): void {
  if (patchInstalled || typeof window === 'undefined' || typeof window.fetch !== 'function') return
  patchInstalled = true

  const originalFetch = window.fetch.bind(window)

  window.fetch = function authedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const token = getSessionToken()
    if (!token) return originalFetch(input, init)

    try {
      let url = ''
      if (typeof input === 'string') url = input
      else if (input instanceof URL) url = input.href
      else if (typeof input.url === 'string') url = input.url

      const isApi =
        url.startsWith('/api/') || url.startsWith(`${window.location.origin}/api/`)
      if (!isApi) return originalFetch(input, init)

      const baseHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined)
      if (baseHeaders) {
        const existing = new Headers(baseHeaders)
        if (existing.has('Authorization')) return originalFetch(input, init)
      }

      const headers = new Headers(baseHeaders ?? undefined)
      headers.set('Authorization', `Bearer ${token}`)
      return originalFetch(input, { ...init, headers })
    } catch {
      return originalFetch(input, init)
    }
  }
}

/**
 * The Google OAuth callback redirects to `/#dash_token=<token>` (fragment, so
 * it never reaches any server log). Consume it on boot: persist the token and
 * strip the fragment from the address bar.
 */
export function consumeTokenFromHash(): void {
  try {
    if (typeof window === 'undefined' || !window.location.hash) return
    const m = window.location.hash.match(/[#&]dash_token=([^&]+)/)
    if (!m) return
    const token = decodeURIComponent(m[1])
    if (token) setSessionToken(token)
    // Remove the token from the URL without reloading.
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  } catch {
    /* ignore */
  }
}

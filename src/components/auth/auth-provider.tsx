'use client'

import * as React from 'react'
import type { AuthContextValue, AuthStatus, PublicUser } from './auth-types'
import { Zap } from 'lucide-react'
import {
  clearSessionToken,
  consumeTokenFromHash,
  installAuthFetchPatch,
} from './session-token'

interface SessionResponse {
  user: PublicUser | null
  showSeedHint: boolean
}

const AuthContext = React.createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

/**
 * Session provider.
 * - Installs the bearer-token fetch patch first, so every API call (including
 *   the initial session fetch) carries the localStorage token when the cookie
 *   channel is unavailable (sandbox preview iframe blocks third-party cookies).
 * - Fetches GET /api/auth/session on mount (fetch/parse errors → signed out,
 *   so the login screen renders even while the backend is not deployed yet).
 * - Polls every 60s when the user is approved and every 10s while a user is
 *   pending — an admin approving the registration flips the waiting user's
 *   screen to the dashboard live without any interaction.
 * - `refresh()` re-fetches once (used after login / logout).
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<PublicUser | null>(null)
  const [status, setStatus] = React.useState<AuthStatus>('loading')
  const [showSeedHint, setShowSeedHint] = React.useState(false)

  const fetchSession = React.useCallback(async (initial = false) => {
    try {
      const res = await fetch('/api/auth/session', { cache: 'no-store' })
      if (!res.ok) throw new Error(`session ${res.status}`)
      const data = (await res.json()) as Partial<SessionResponse>
      const nextUser = data.user ?? null
      setUser(nextUser)
      setShowSeedHint(!!data.showSeedHint)
      setStatus(nextUser ? 'authenticated' : 'unauthenticated')
    } catch {
      // Network error / non-200 (e.g. auth routes not deployed yet).
      // On the initial load we must resolve the loading state — treat as
      // signed out. On later polls we keep the current state so a transient
      // dev-server hiccup never flips an authenticated user to the login screen.
      if (initial) {
        setUser(null)
        setShowSeedHint(false)
        setStatus('unauthenticated')
      }
    }
  }, [])

  React.useEffect(() => {
    // Enable the localStorage bearer channel before the first API call —
    // also consumes `/#dash_token=` set by the Google OAuth callback.
    installAuthFetchPatch()
    consumeTokenFromHash()
    void fetchSession(true)
  }, [fetchSession])

  const refresh = React.useCallback(async () => {
    await fetchSession(false)
  }, [fetchSession])

  const logout = React.useCallback(async () => {
    // Drop the localStorage token, then clear the server cookie.
    clearSessionToken()
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // Ignore — the refresh below is authoritative for the UI state.
    }
    await fetchSession(false)
  }, [fetchSession])

  // Session polling: 10s while pending (live approval flip), 60s otherwise.
  const pollKey = user ? `${user.id}:${user.status}` : 'anon'
  React.useEffect(() => {
    if (status !== 'authenticated') return
    const intervalMs = user?.status === 'pending' ? 10_000 : 60_000
    const timer = setInterval(() => { void fetchSession(false) }, intervalMs)
    return () => clearInterval(timer)
  }, [status, pollKey, fetchSession])

  const value = React.useMemo<AuthContextValue>(() => ({
    user,
    status,
    showSeedHint,
    refresh,
    logout,
  }), [user, status, showSeedHint, refresh, logout])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** Full-screen brand splash shown while the first session fetch resolves. */
export function AuthLoadingSplash() {
  return (
    <div className="min-h-screen flex flex-col">
      <div className="page-backdrop" aria-hidden="true" />
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-sm shadow-primary/40 ring-1 ring-primary/30 ring-inset animate-pulse">
            <Zap className="h-6 w-6" />
          </div>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </div>
      <span className="sr-only">Loading</span>
    </div>
  )
}

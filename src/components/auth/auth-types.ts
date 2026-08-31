// Shared authentication types — kept in one place so page.tsx and the auth
// components share the exact same shape as the backend API contract.
//
// Contract (Task 11): GET /api/auth/session →
//   { user: PublicUser | null, showSeedHint: boolean }

export type UserRole = 'admin' | 'user'
export type UserStatus = 'pending' | 'approved' | 'rejected'
export type AuthProviderName = 'credentials' | 'google'

export interface PublicUser {
  id: string
  name: string
  email: string
  role: UserRole
  status: UserStatus
  provider: AuthProviderName
  avatarUrl: string | null
  createdAt: string
  lastLoginAt: string | null
  rejectionReason: string | null
}

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

export interface AuthContextValue {
  user: PublicUser | null
  status: AuthStatus
  showSeedHint: boolean
  /** Re-fetch the session once. */
  refresh: () => Promise<void>
  /** POST /api/auth/logout then refresh (user → null). */
  logout: () => Promise<void>
}

/** Session object handed to the inner dashboard component. */
export interface DashboardSession {
  user: PublicUser
  refresh: () => void
  logout: () => void
}

export interface GoogleStatus {
  configured: boolean
  redirectUri: string
  clientIdMasked: string | null
}

import { NextRequest, NextResponse } from 'next/server'
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { parseUserAgent } from '@/lib/ua'

/**
 * Hand-rolled authentication for the dashboard (Task 11-a).
 *
 * - Passwords: scrypt with per-user random salt, constant-time verification.
 * - Sessions: httpOnly cookie `dash_session` carrying an HMAC-SHA256-signed
 *   JSON payload `{uid, iat, exp}`. The signature secret is generated once
 *   and persisted in AppSetting (`auth.secret`).
 * - Every issued token is ALSO recorded as a `Session` row keyed by the
 *   SHA-256 hash of the token (Task 19) — enabling listing active sessions
 *   and server-side revocation. A token whose row is missing, revoked, or
 *   expired is rejected.
 * - Every request re-loads the user from the DB, so approval / role changes /
 *   deletion take effect immediately.
 * - Google OAuth 2.0 credentials are stored in AppSetting (`auth.google`) and
 *   can be configured by an admin at runtime.
 */

export const SESSION_COOKIE = 'dash_session'
export const OAUTH_STATE_COOKIE = 'oauth_state'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const SESSION_TTL_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

const AUTH_SECRET_KEY = 'auth.secret'
const GOOGLE_SETTINGS_KEY = 'auth.google'

export const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@dashboard.local'
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123456'
const DEFAULT_ADMIN_NAME = 'Administrator'

// ============================== types ==============================

export interface PublicUser {
  id: string
  name: string
  email: string
  role: string
  status: string
  provider: string
  avatarUrl: string | null
  createdAt: string
  lastLoginAt: string | null
  rejectionReason: string | null
}

export interface AdminUser extends PublicUser {
  approvedAt: string | null
  approvedByName: string | null
}

export interface GoogleSettings {
  clientId: string
  clientSecret: string
}

/** Raw prisma User row (the subset of fields we serialize / verify). */
export interface UserRow {
  id: string
  email: string
  name: string
  role: string
  status: string
  provider: string
  avatarUrl: string | null
  rejectionReason: string | null
  passwordHash: string | null
  passwordChangedAt: Date | null
  lastLoginAt: Date | null
  approvedAt: Date | null
  approvedById: string | null
  createdAt: Date
}

// ============================== validation ==============================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 254
}

export function isValidName(name: unknown): boolean {
  return typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 40
}

export function isValidPassword(password: unknown): boolean {
  if (typeof password !== 'string') return false
  if (password.length < 8 || password.length > 128) return false
  return /[a-zA-Z]/.test(password) && /\d/.test(password)
}

// ============================== password hashing ==============================

/** scrypt (N=16384 default), random 16-byte salt → `scrypt$<saltHex>$<hashHex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

/** Constant-time scrypt verification against a stored `scrypt$salt$hash` string. */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$')
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false
    const salt = Buffer.from(parts[1], 'hex')
    const expected = Buffer.from(parts[2], 'hex')
    if (salt.length === 0 || expected.length === 0) return false
    const actual = scryptSync(password, salt, expected.length)
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

// ============================== settings helpers ==============================

function parseSettingValue<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw)
    return (parsed ?? fallback) as T
  } catch {
    return fallback
  }
}

/** The HMAC secret — 48 random bytes (hex), generated ONCE and persisted. */
let cachedSecret: string | null = null

export async function getAuthSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret
  const existing = await db.appSetting.findUnique({ where: { key: AUTH_SECRET_KEY } })
  if (existing) {
    const value = parseSettingValue<string>(existing.value, '')
    if (value) {
      cachedSecret = value
      return value
    }
  }
  const secret = randomBytes(48).toString('hex')
  try {
    // Create-if-missing. A unique-constraint race (two workers bootstrapping
    // at once) means another process won — read theirs instead.
    await db.appSetting.create({
      data: { key: AUTH_SECRET_KEY, value: JSON.stringify(secret) },
    })
    cachedSecret = secret
    return secret
  } catch {
    const winner = await db.appSetting.findUnique({ where: { key: AUTH_SECRET_KEY } })
    if (winner) {
      const value = parseSettingValue<string>(winner.value, '')
      if (value) {
        cachedSecret = value
        return value
      }
    }
    throw new Error('Failed to persist auth secret')
  }
}

export async function getGoogleSettings(): Promise<GoogleSettings | null> {
  const row = await db.appSetting.findUnique({ where: { key: GOOGLE_SETTINGS_KEY } })
  if (!row) return null
  const parsed = parseSettingValue<Partial<GoogleSettings>>(row.value, {})
  if (!parsed || typeof parsed !== 'object') return null
  const clientId = typeof parsed.clientId === 'string' ? parsed.clientId : ''
  const clientSecret = typeof parsed.clientSecret === 'string' ? parsed.clientSecret : ''
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export async function saveGoogleSettings(settings: GoogleSettings | null): Promise<void> {
  if (!settings || !settings.clientId || !settings.clientSecret) {
    await db.appSetting.deleteMany({ where: { key: GOOGLE_SETTINGS_KEY } })
    return
  }
  await db.appSetting.upsert({
    where: { key: GOOGLE_SETTINGS_KEY },
    update: { value: JSON.stringify(settings) },
    create: { key: GOOGLE_SETTINGS_KEY, value: JSON.stringify(settings) },
  })
}

export function maskClientId(clientId: string): string {
  if (clientId.length <= 12) return clientId
  return `${clientId.slice(0, 8)}…${clientId.slice(-4)}`
}

// ============================== session tokens ==============================

interface TokenPayload {
  uid: string
  iat: number
  exp: number
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64url')
}

export async function createSessionToken(userId: string, remember = false): Promise<string> {
  const secret = await getAuthSecret()
  const now = Date.now()
  const payload: TokenPayload = {
    uid: userId,
    iat: now,
    exp: now + (remember ? SESSION_TTL_REMEMBER_MS : SESSION_TTL_MS),
  }
  const body = b64url(JSON.stringify(payload))
  const sig = createHmac('sha256', secret).update(body).digest('hex')
  return `${body}.${sig}`
}

async function verifySessionToken(token: string): Promise<TokenPayload | null> {
  try {
    const dot = token.lastIndexOf('.')
    if (dot <= 0) return null
    const body = token.slice(0, dot)
    const sig = token.slice(dot + 1)
    const secret = await getAuthSecret()
    const expected = createHmac('sha256', secret).update(body).digest('hex')
    const sigBuf = Buffer.from(sig, 'utf-8')
    const expectedBuf = Buffer.from(expected, 'utf-8')
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as TokenPayload
    if (!payload || typeof payload.uid !== 'string') return null
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

// ============================== session store (Task 19) ==============================

const LAST_SEEN_THROTTLE_MS = 60_000 // touch lastSeenAt at most once a minute
const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // keep revoked rows for a week

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** SHA-256 of a session token — the lookup key for Session rows. */
export function hashSessionToken(token: string): string {
  return sha256(token)
}

/** Serialize a session row for the sessions API. */
export interface SessionInfo {
  id: string
  userId: string
  userName: string
  userEmail: string
  userRole: string
  current: boolean
  ip: string | null
  browser: string
  os: string
  deviceType: string
  remember: boolean
  createdAt: string
  lastSeenAt: string
  expiresAt: string
}

export interface SessionRow {
  id: string
  userId: string
  tokenHash: string
  ip: string | null
  userAgent: string | null
  remember: boolean
  createdAt: Date
  lastSeenAt: Date
  expiresAt: Date
  revokedAt: Date | null
}

export interface SessionRowWithUser extends SessionRow {
  user: { id: string; name: string; email: string; role: string }
}

export function toSessionInfo(row: SessionRowWithUser, currentTokenHash: string): SessionInfo {
  const ua = parseUserAgent(row.userAgent)
  return {
    id: row.id,
    userId: row.userId,
    userName: row.user.name,
    userEmail: row.user.email,
    userRole: row.user.role,
    current: row.tokenHash === currentTokenHash,
    ip: row.ip,
    browser: ua.browser,
    os: ua.os,
    deviceType: ua.deviceType,
    remember: row.remember,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }
}

/**
 * Create a session: HMAC token (unchanged wire format) + a revocable
 * server-side row carrying ip / user-agent / expiry. Throws on DB failure —
 * a session that cannot be recorded must not be issued.
 */
export async function createSession(
  userId: string,
  remember = false,
  req?: NextRequest | Request,
): Promise<string> {
  const token = await createSessionToken(userId, remember)
  const payload = await verifySessionToken(token)
  const expiresAt = payload
    ? new Date(payload.exp)
    : new Date(Date.now() + (remember ? SESSION_TTL_REMEMBER_MS : SESSION_TTL_MS))
  await db.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      ip: req ? clientIp(req) : null,
      userAgent: req?.headers.get('user-agent') ?? null,
      remember,
      expiresAt,
    },
  })
  return token
}

/** Opportunistic cleanup: drop long-expired and long-revoked rows. */
export async function pruneSessions(): Promise<void> {
  const cutoff = Date.now() - REVOKED_RETENTION_MS
  try {
    await db.session.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date(Date.now() - REVOKED_RETENTION_MS) } },
          { revokedAt: { lt: new Date(cutoff) } },
        ],
      },
    })
  } catch {
    /* best-effort housekeeping */
  }
}

/** Active sessions of one user (not revoked, not expired), newest activity first. */
export async function listUserSessions(userId: string): Promise<SessionRowWithUser[]> {
  return db.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
    include: { user: { select: { id: true, name: true, email: true, role: true } } },
  })
}

/** Active sessions of ALL users with user info (admin view), newest activity first. */
export async function listAllSessions(): Promise<SessionRowWithUser[]> {
  return db.session.findMany({
    where: { revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
    include: { user: { select: { id: true, name: true, email: true, role: true } } },
  })
}

/** Revoke the session a request is authenticated with (used by logout). */
export async function revokeSessionByToken(token: string): Promise<boolean> {
  const res = await db.session.updateMany({
    where: { tokenHash: sha256(token), revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return res.count > 0
}

/** Fetch a session row by id (for ownership checks). */
export async function findSessionById(id: string): Promise<SessionRow | null> {
  return db.session.findUnique({ where: { id } })
}

export interface RevokedSession {
  id: string
  userId: string
  /** True when the revoked session is the one the current request used. */
  wasCurrent: boolean
}

/** Revoke a session by id (ownership checked by the caller). Idempotent. */
export async function revokeSessionById(
  id: string,
  currentToken: string | null,
): Promise<RevokedSession | null> {
  const session = await db.session.findUnique({ where: { id } })
  if (!session) return null
  if (!session.revokedAt) {
    await db.session.update({ where: { id }, data: { revokedAt: new Date() } })
  }
  return {
    id: session.id,
    userId: session.userId,
    wasCurrent: !!currentToken && sha256(currentToken) === session.tokenHash,
  }
}

/** Revoke every session of a user (optionally keeping the current one). Returns the count. */
export async function revokeAllUserSessions(
  userId: string,
  exceptToken: string | null = null,
): Promise<number> {
  const res = await db.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptToken ? { tokenHash: { not: sha256(exceptToken) } } : {}),
    },
    data: { revokedAt: new Date() },
  })
  return res.count
}

// ============================== serialization ==============================

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    provider: user.provider,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : new Date(user.createdAt).toISOString(),
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    rejectionReason: user.rejectionReason ?? null,
  }
}

/** AdminUser = PublicUser + approval snapshot fields. */
export function toAdminUser(user: UserRow, approverNameById: Map<string, string>): AdminUser {
  return {
    ...toPublicUser(user),
    approvedAt: user.approvedAt
      ? user.approvedAt instanceof Date
        ? user.approvedAt.toISOString()
        : new Date(user.approvedAt).toISOString()
      : null,
    approvedByName: user.approvedById ? approverNameById.get(user.approvedById) ?? null : null,
  }
}

/** Resolve approvedById → names for a set of user rows (one extra query). */
export async function approverNameMap(users: UserRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(users.map((u) => u.approvedById).filter((x): x is string => !!x))]
  if (ids.length === 0) return new Map()
  const approvers = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  })
  return new Map(approvers.map((a) => [a.id, a.name]))
}

// ============================== session cookie ==============================

function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key) out[key] = decodeURIComponent(value)
  }
  return out
}

export function getSessionCookieValue(req: NextRequest | Request): string | null {
  const cookieHeader = req.headers.get('cookie')
  if (!cookieHeader) return null
  return parseCookieHeader(cookieHeader)[SESSION_COOKIE] ?? null
}

/**
 * Extract the session token from a request, trying three channels:
 *  1. the `dash_session` httpOnly cookie (same-origin / direct access),
 *  2. an `Authorization: Bearer <token>` header (the localStorage channel
 *     used when the app runs in the sandbox preview iframe, where browsers
 *     block third-party cookies),
 *  3. an `?auth_token=` query parameter (last-resort for consumers that
 *     cannot set headers, e.g. EventSource-style endpoints).
 */
export function sessionTokenFromRequest(req: NextRequest | Request): string | null {
  const cookieToken = getSessionCookieValue(req)
  if (cookieToken) return cookieToken

  const authHeader = req.headers.get('authorization')
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const bearer = authHeader.slice(7).trim()
    if (bearer) return bearer
  }

  try {
    const queryToken = new URL(req.url).searchParams.get('auth_token')
    if (queryToken) return queryToken
  } catch {
    /* not a parsable URL — ignore */
  }
  return null
}

export function buildSessionCookie(token: string, remember = false, secure = false): string {
  const maxAge = remember ? SESSION_TTL_REMEMBER_MS / 1000 : SESSION_TTL_MS / 1000
  // `SameSite=Lax` works for same-origin access (localhost / direct). When the
  // app is viewed through the sandbox preview (an HTTPS proxy embedding the app
  // in a cross-site iframe), browsers reject Lax cookies — so we downgrade to
  // `SameSite=None; Secure` whenever the request arrived over HTTPS. The
  // localStorage bearer-token channel (see session-token.ts) covers the HTTP
  // iframe case where even Secure cookies cannot be set.
  const sameSite = secure ? 'None; Secure' : 'Lax'
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}`
}

export function buildSessionCookieForUser(
  userId: string,
  remember = false,
  secure = false,
): Promise<string> {
  return createSessionToken(userId, remember).then((token) => buildSessionCookie(token, remember, secure))
}

export function buildClearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

/** True when the request reached us over HTTPS (directly or via proxy). */
export function isSecureRequest(req: NextRequest | Request): boolean {
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  if (proto) return proto === 'https'
  try {
    return new URL(req.url).protocol === 'https:'
  } catch {
    return false
  }
}

/** Attach a session cookie to an existing NextResponse (used by OAuth redirects). */
export function withSessionCookie(response: NextResponse, cookie: string): NextResponse {
  response.headers.append('set-cookie', cookie)
  return response
}

// ============================== session lookup & guards ==============================

/**
 * Verify the session token signature + expiry, REQUIRE a live Session row
 * (not revoked / not expired — Task 19 revocation enforcement), then LOAD
 * the user from the DB (so approve/reject/role changes/deletions apply
 * immediately). Returns the user regardless of status — the pending/rejected
 * states are surfaced to the frontend via `user.status` so it can render the
 * approval screen. lastSeenAt is touched at most once per minute.
 */
export async function getSessionUser(req: NextRequest | Request): Promise<PublicUser | null> {
  const token = sessionTokenFromRequest(req)
  if (!token) return null
  const payload = await verifySessionToken(token)
  if (!payload) return null
  try {
    const session = await db.session.findUnique({ where: { tokenHash: sha256(token) } })
    // Missing row → legacy or revoked-and-deleted token: treat as revoked.
    if (!session || session.revokedAt) return null
    if (session.expiresAt.getTime() < Date.now()) return null
    if (session.userId !== payload.uid) return null
    const user = await db.user.findUnique({ where: { id: payload.uid } })
    if (!user) return null // deleted → session invalid immediately
    if (Date.now() - session.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      db.session
        .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
        .catch(() => { /* activity tracking is best-effort */ })
    }
    return toPublicUser(user)
  } catch {
    return null
  }
}

export type ApprovedGuard =
  | { user: PublicUser; error?: undefined }
  | { user?: undefined; error: NextResponse }

export type AdminGuard =
  | { user: PublicUser; error?: undefined }
  | { user?: undefined; error: NextResponse }

/** Require a logged-in user whose status is 'approved'. */
export async function requireApprovedUser(req: NextRequest | Request): Promise<ApprovedGuard> {
  const user = await getSessionUser(req)
  if (!user || user.status !== 'approved') {
    return {
      error: NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
    }
  }
  return { user }
}

/** Require a logged-in, approved ADMIN. */
export async function requireAdmin(req: NextRequest | Request): Promise<AdminGuard> {
  const user = await getSessionUser(req)
  if (!user) {
    return {
      error: NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
    }
  }
  if (user.role !== 'admin' || user.status !== 'approved') {
    return {
      error: NextResponse.json({ error: 'Admin access required' }, { status: 403 }),
    }
  }
  return { user }
}

// ============================== bootstrap ==============================

let bootstrapPromise: Promise<void> | null = null

/**
 * Idempotent bootstrap (module-level promise cache):
 *  - ensures the HMAC secret exists,
 *  - seeds the preset admin account when no admin exists.
 * Call it at the top of every auth/admin route handler.
 */
export function ensureBootstrap(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap().catch((err) => {
      // Reset so a later call can retry (e.g. transient DB unavailability).
      bootstrapPromise = null
      throw err
    })
  }
  return bootstrapPromise
}

async function runBootstrap(): Promise<void> {
  await getAuthSecret()

  const adminCount = await db.user.count({ where: { role: 'admin' } })
  if (adminCount === 0) {
    const email = normalizeEmail(DEFAULT_ADMIN_EMAIL)
    await db.user
      .create({
        data: {
          email,
          name: DEFAULT_ADMIN_NAME,
          passwordHash: hashPassword(DEFAULT_ADMIN_PASSWORD),
          role: 'admin',
          status: 'approved',
          provider: 'credentials',
          // passwordChangedAt stays null → the login screen shows the seed hint.
          approvedAt: new Date(),
        },
      })
      .catch(async (err: unknown) => {
        // Race with another worker seeding the same admin → fine.
        const code = (err as { code?: string })?.code
        if (code !== 'P2002') throw err
        const adminCount = await db.user.count({ where: { role: 'admin' } })
        if (adminCount === 0) throw err
      })
  }
}

/**
 * The seed hint is shown only while the system is in its pristine state:
 * exactly one user, that user is the seeded admin, and its password has
 * never been changed.
 */
export async function computeShowSeedHint(): Promise<boolean> {
  const [total, admin] = await Promise.all([
    db.user.count(),
    db.user.findFirst({ where: { role: 'admin' } }),
  ])
  if (total !== 1 || !admin) return false
  if (admin.email !== normalizeEmail(DEFAULT_ADMIN_EMAIL)) return false
  return admin.passwordChangedAt === null
}

// ============================== rate limiters ==============================

const LOGIN_MAX_FAILURES = 5
const LOGIN_WINDOW_MS = 15 * 60 * 1000 // block 15 minutes after 5 failures

const REGISTER_MAX = 10
const REGISTER_WINDOW_MS = 60 * 60 * 1000 // 10/hour per IP

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

function pruneBuckets(): void {
  const now = Date.now()
  if (buckets.size < 512) return
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key)
  }
}

export function clientIp(req: NextRequest | Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') || 'unknown'
}

/** 5 failed logins (per email+ip) → blocked for 15 minutes. */
export function loginRateLimited(email: string, ip: string): boolean {
  pruneBuckets()
  const key = `login|${email}|${ip}`
  const bucket = buckets.get(key)
  if (!bucket) return false
  if (bucket.resetAt < Date.now()) {
    buckets.delete(key)
    return false
  }
  return bucket.count >= LOGIN_MAX_FAILURES
}

/** Record a failed login attempt. Returns the failure count so far. */
export function recordLoginFailure(email: string, ip: string): number {
  const key = `login|${email}|${ip}`
  const now = Date.now()
  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return 1
  }
  bucket.count += 1
  // Every new failure extends the 15-minute block window.
  bucket.resetAt = now + LOGIN_WINDOW_MS
  return bucket.count
}

/** Clear the failure counter after a successful login. */
export function clearLoginFailures(email: string, ip: string): void {
  buckets.delete(`login|${email}|${ip}`)
}

/** 10 registrations per hour per IP. */
export function registerRateLimited(ip: string): boolean {
  pruneBuckets()
  const key = `register|${ip}`
  const now = Date.now()
  const bucket = buckets.get(key)
  if (!bucket) {
    buckets.set(key, { count: 1, resetAt: now + REGISTER_WINDOW_MS })
    return false
  }
  if (bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + REGISTER_WINDOW_MS })
    return false
  }
  bucket.count += 1
  return bucket.count > REGISTER_MAX
}

// ============================== request origin ==============================

/**
 * Request origin, honoring x-forwarded-proto / x-forwarded-host (the sandbox
 * sits behind a proxy). Used to build the Google OAuth redirect URI.
 */
export function originFromReq(req: NextRequest | Request): string {
  const url = new URL(req.url)
  const proto =
    req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '')
  const host =
    req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    req.headers.get('host') ||
    url.host
  return `${proto}://${host}`
}

export function googleRedirectUri(req: NextRequest | Request): string {
  return `${originFromReq(req)}/api/auth/google/callback`
}

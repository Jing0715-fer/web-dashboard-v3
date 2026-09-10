'use client'

import * as React from 'react'
import { motion, AnimatePresence, MotionConfig, useMotionValue, useSpring, useTransform, type Variants } from 'framer-motion'
import {
  MonitorSmartphone, Rocket, Sparkles, Eye, EyeOff,
  AlertCircle, CheckCircle2, Loader2, Info, Mail, Lock, User, ArrowRight, ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { LanguageToggle } from '@/components/language-toggle'
import { useT, type I18nContextValue } from '@/lib/i18n'
import type { GoogleStatus } from './auth-types'
import { setSessionToken } from './session-token'

const REMEMBER_KEY = 'dashboard-auth-remember'
const EMAIL_KEY = 'dashboard-auth-email'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/* Shared easing + entrance choreography (matches the interior page's
   card/panel motion language: short, soft, easeOut, never bouncy-loud). */
const EASE_OUT: [number, number, number, number] = [0.21, 0.47, 0.32, 0.98]

const panelVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } },
}
const itemVariants: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT } },
}

/* Input-icon button/field recipe shared by both forms — the icon sits inside
   the field, dims while idle and picks up the brand color on focus. */
const iconField = 'group/field relative'
const iconGlyph = 'pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60 transition-colors duration-200 group-focus-within/field:text-brand'
const iconInput = 'h-11 transition-all duration-200 focus-visible:border-brand/50 focus-visible:ring-brand/20 pl-10'

interface FormError { tone: 'destructive' | 'warning'; title: string; detail?: string }

/* Deterministic rising-particle seeds — Math.sin hashing keeps SSR and client
   markup identical (no hydration drift, no Math.random). Consumed by the
   .login-particle layer in the backdrop via CSS custom properties. */
const PARTICLES: React.CSSProperties[] = Array.from({ length: 18 }, (_, i) => {
  const rand = (seed: number) => {
    const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453
    return x - Math.floor(x)
  }
  const s = i * 3 + 1
  return {
    '--x': `${(4 + rand(s) * 90).toFixed(1)}%`,
    '--s': `${(1.5 + rand(s + 1) * 2.5).toFixed(1)}px`,
    '--d': `${(15 + rand(s + 2) * 13).toFixed(1)}s`,
    '--dl': `${(rand(s + 3) * 11).toFixed(1)}s`,
    '--o': (0.18 + rand(s + 4) * 0.32).toFixed(2),
    '--dx': `${Math.round(-70 + rand(s + 5) * 140)}px`,
  } as React.CSSProperties
})

/** Map a Google OAuth error code to its dictionary key. */
function googleAuthErrorKey(code: string): string {
  switch (code) {
    case 'email_conflict':
      return 'login.googleError.emailConflict'
    case 'state_mismatch':
      return 'login.googleError.stateMismatch'
    case 'rejected':
      return 'login.googleError.rejected'
    default:
      return 'login.googleError.default'
  }
}

function GoogleLogo({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.51 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  )
}

function ErrorAlert({ error }: { error: FormError }) {
  const amber = error.tone === 'warning'
  return (
    <motion.div
      role="alert"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${amber
        ? 'border-amber-300/70 bg-amber-50/80 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300'
        : 'border-destructive/40 bg-card text-destructive dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-400'}`}
    >
      <AlertCircle className={`h-4 w-4 shrink-0 mt-0.5 ${amber ? 'text-amber-500' : 'text-destructive dark:text-red-400'}`} />
      <div className="min-w-0">
        <p className="font-medium leading-snug">{error.title}</p>
        {error.detail && <p className="mt-0.5 text-xs opacity-80 leading-relaxed">{error.detail}</p>}
      </div>
    </motion.div>
  )
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return (
    <motion.p
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="text-xs text-destructive dark:text-red-400 mt-1.5 leading-snug"
    >
      {message}
    </motion.p>
  )
}

/** Google sign-in button + configuration status chip. */
function GoogleSignInButton({ status }: { status: GoogleStatus | null }) {
  const t = useT()
  const loading = status === null
  const configured = !!status?.configured
  const button = (
    <Button
      type="button"
      variant="outline"
      disabled={loading || !configured}
      onClick={() => { window.location.href = '/api/auth/google' }}
      className="h-11 w-full bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-700/70 text-zinc-700 dark:text-zinc-200 text-sm font-medium shadow-xs transition-all duration-200 active:scale-[0.99] disabled:opacity-60"
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <GoogleLogo className="h-4 w-4 shrink-0" />
      )}
      <span className="ml-2.5">{t('login.google.continue')}</span>
      {configured && status?.clientIdMasked && (
        <span className="ml-auto hidden sm:inline text-[10px] font-mono text-muted-foreground/70 truncate max-w-[110px]">{status.clientIdMasked}</span>
      )}
    </Button>
  )
  return (
    <div className="space-y-2">
      {configured ? (
        button
      ) : (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            {/* Span wrapper keeps hover events alive while the inner button is disabled */}
            <TooltipTrigger asChild>
              <span className="block w-full cursor-not-allowed">{button}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[280px] text-xs leading-relaxed">
              {t('login.google.notConfigured')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {!loading && !configured && (
        <p className="text-[11px] text-foreground/75 dark:text-zinc-400 text-center">{t('login.google.notConfiguredShort')}</p>
      )}
    </div>
  )
}

function Divider() {
  const t = useT()
  return (
    <div className="relative mb-7" aria-hidden="true">
      <div className="absolute inset-0 flex items-center">
        <motion.span
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.55, ease: 'easeOut' }}
          className="w-full border-t border-border/60 origin-center"
        />
      </div>
      <div className="relative flex justify-center">
        <motion.span
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.4 }}
          className="bg-background px-3 text-[11px] uppercase tracking-wider text-muted-foreground"
        >
          {t('login.divider')}
        </motion.span>
      </div>
    </div>
  )
}

// ======================== SIGN IN FORM ========================

function SignInForm({ onAuthed, seedHint }: { onAuthed: () => void; seedHint?: boolean }) {
  const t = useT()
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [showPassword, setShowPassword] = React.useState(false)
  const [remember, setRemember] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<FormError | null>(null)

  React.useEffect(() => {
    try {
      setRemember(localStorage.getItem(REMEMBER_KEY) === '1')
      const saved = localStorage.getItem(EMAIL_KEY)
      if (saved) setEmail(saved)
    } catch { /* storage unavailable */ }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting) return
    if (!email.trim() || !password) {
      setError({ tone: 'destructive', title: t('login.error.enterCredentials') })
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, remember }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        try {
          if (remember) { localStorage.setItem(REMEMBER_KEY, '1'); localStorage.setItem(EMAIL_KEY, email.trim()) }
          else { localStorage.removeItem(REMEMBER_KEY); localStorage.removeItem(EMAIL_KEY) }
        } catch { /* storage unavailable */ }
        // Persist the bearer token (works where third-party cookies are
        // blocked, e.g. the sandbox preview iframe) before flipping the UI.
        if (typeof data.sessionToken === 'string' && data.sessionToken) {
          setSessionToken(data.sessionToken)
        }
        onAuthed()
        return
      }
      if (res.status === 403) {
        if (data.code === 'pending') {
          setError({ tone: 'warning', title: t('login.error.pending.title'), detail: t('login.error.pending.detail') })
        } else if (data.code === 'rejected') {
          setError({
            tone: 'destructive',
            title: t('login.error.rejected.title'),
            detail: data.rejectionReason ? t('login.error.rejected.reason', { reason: String(data.rejectionReason) }) : undefined,
          })
        } else {
          setError({ tone: 'destructive', title: data.error || t('login.error.fallback') })
        }
      } else if (res.status === 429) {
        setError({ tone: 'warning', title: data.error || t('login.error.tooMany') })
      } else {
        setError({ tone: 'destructive', title: data.error || t('login.error.invalid') })
      }
    } catch {
      setError({ tone: 'destructive', title: t('login.error.network') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      <GoogleGate />
      <Divider />
      <div className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="signin-email" className="text-[13px] font-semibold">{t('login.email')}</Label>
          <div className={iconField}>
            <Mail className={iconGlyph} aria-hidden="true" />
            <Input
              id="signin-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              className={iconInput}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="signin-password" className="text-[13px] font-semibold">{t('login.password')}</Label>
          </div>
          <div className={iconField}>
            <Lock className={iconGlyph} aria-hidden="true" />
            <Input
              id="signin-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              className="h-11 pl-10 pr-11 transition-all duration-200 focus-visible:border-brand/50 focus-visible:ring-brand/20"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
              className="absolute right-0 top-0 h-11 w-11 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              tabIndex={0}
            >
              {showPassword ? <EyeOff className="h-4 w-4 transition-transform duration-200 active:scale-90" /> : <Eye className="h-4 w-4 transition-transform duration-200 active:scale-90" />}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <Checkbox
            id="signin-remember"
            checked={remember}
            onCheckedChange={(v) => setRemember(v === true)}
            disabled={submitting}
          />
          <Label htmlFor="signin-remember" className="text-sm font-normal text-muted-foreground cursor-pointer">{t('login.rememberMe')}</Label>
        </div>
        <AnimatePresence initial={false}>
          {error && <ErrorAlert key={error.title} error={error} />}
        </AnimatePresence>
        <Button
          type="submit"
          disabled={submitting}
          className="btn-sheen group/btn h-11 w-full rounded-lg bg-gradient-to-b from-primary to-primary/90 hover:from-primary hover:to-primary/85 text-primary-foreground text-sm font-semibold shadow-md shadow-primary/25 hover:shadow-lg hover:shadow-primary/40 active:scale-[0.98] transition-all duration-200"
        >
          {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {submitting ? t('login.signingIn') : t('login.signin')}
          {!submitting && (
            <ArrowRight className="h-4 w-4 ml-1.5 transition-transform duration-200 group-hover/btn:translate-x-0.5" aria-hidden="true" />
          )}
        </Button>
        {seedHint && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.4, ease: 'easeOut' }}
            className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-3.5 py-2.5 pt-3 text-xs text-foreground/70 dark:text-zinc-300 leading-relaxed"
          >
            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              {t('login.seedHintPrefix')} <code className="font-mono">admin@dashboard.local</code> · <code className="font-mono">admin123456</code> — {t('login.seedHintSuffix')}
            </span>
          </motion.div>
        )}
      </div>
    </form>
  )
}

/** Fetches /api/auth/google/status once and renders the Google button. */
function GoogleGate() {
  const [status, setStatus] = React.useState<GoogleStatus | null>(null)
  React.useEffect(() => {
    let cancelled = false
    fetch('/api/auth/google/status')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('status error'))))
      .then((data) => { if (!cancelled) setStatus({ configured: !!data.configured, redirectUri: data.redirectUri || '', clientIdMasked: data.clientIdMasked ?? null }) })
      .catch(() => { if (!cancelled) setStatus({ configured: false, redirectUri: '', clientIdMasked: null }) })
    return () => { cancelled = true }
  }, [])
  return <GoogleSignInButton status={status} />
}

// ======================== REGISTER FORM ========================

interface RegisterFields { name: string; email: string; password: string; confirm: string }
type RegisterErrors = Partial<Record<keyof RegisterFields, string>>

function validateRegister(f: RegisterFields, t: I18nContextValue['t']): RegisterErrors {
  const errors: RegisterErrors = {}
  const name = f.name.trim()
  if (name.length < 2 || name.length > 40) errors.name = t('login.register.error.name')
  if (!EMAIL_RE.test(f.email.trim())) errors.email = t('login.register.error.email')
  if (f.password.length < 8 || !/[A-Za-z]/.test(f.password) || !/\d/.test(f.password)) {
    errors.password = t('login.register.error.password')
  }
  if (f.confirm !== f.password) errors.confirm = t('login.register.error.confirm')
  return errors
}

function RegisterForm({ onBackToSignIn }: { onBackToSignIn: () => void }) {
  const t = useT()
  const [fields, setFields] = React.useState<RegisterFields>({ name: '', email: '', password: '', confirm: '' })
  const [errors, setErrors] = React.useState<RegisterErrors>({})
  const [submitting, setSubmitting] = React.useState(false)
  const [serverError, setServerError] = React.useState<FormError | null>(null)
  const [succeeded, setSucceeded] = React.useState(false)
  const [showPassword, setShowPassword] = React.useState(false)
  const [showConfirm, setShowConfirm] = React.useState(false)

  const set = (key: keyof RegisterFields) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFields((f) => ({ ...f, [key]: e.target.value }))
    setErrors((prev) => ({ ...prev, [key]: undefined }))
    setServerError(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting) return
    const validation = validateRegister(fields, t)
    setErrors(validation)
    if (Object.keys(validation).length > 0) return
    setSubmitting(true)
    setServerError(null)
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fields.name.trim(), email: fields.email.trim(), password: fields.password }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && res.status === 201) {
        setSucceeded(true)
        return
      }
      if (res.status === 409) {
        setServerError({ tone: 'destructive', title: t('login.register.error.exists') })
      } else if (res.status === 429) {
        setServerError({ tone: 'warning', title: data.error || t('login.register.error.tooMany') })
      } else {
        setServerError({ tone: 'destructive', title: data.error || t('login.register.error.failed') })
      }
    } catch {
      setServerError({ tone: 'destructive', title: t('login.error.network') })
    } finally {
      setSubmitting(false)
    }
  }

  if (succeeded) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: EASE_OUT }}
        className="py-4 flex flex-col items-center text-center"
      >
        <motion.div
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 320, damping: 18, delay: 0.08 }}
          className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-950/40 ring-4 ring-emerald-100 dark:ring-emerald-900/40 mb-5"
        >
          <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
        </motion.div>
        <h3 className="text-lg font-semibold tracking-tight">{t('login.register.success.title')}</h3>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed max-w-[300px]">
          {t('login.register.success.desc')}
        </p>
        <Button variant="outline" onClick={onBackToSignIn} className="mt-6 h-11 px-6 text-sm transition-all duration-200 active:scale-[0.98]">
          {t('login.register.back')}
        </Button>
      </motion.div>
    )
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="register-name" className="text-[13px] font-semibold">{t('login.register.name')}</Label>
        <div className={iconField}>
          <User className={iconGlyph} aria-hidden="true" />
          <Input
            id="register-name"
            type="text"
            autoComplete="name"
            placeholder={t('login.register.namePlaceholder')}
            value={fields.name}
            onChange={set('name')}
            disabled={submitting}
            aria-invalid={!!errors.name}
            className={iconInput}
          />
        </div>
        <FieldError message={errors.name} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="register-email" className="text-[13px] font-semibold">{t('login.register.email')}</Label>
        <div className={iconField}>
          <Mail className={iconGlyph} aria-hidden="true" />
          <Input
            id="register-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={fields.email}
            onChange={set('email')}
            disabled={submitting}
            aria-invalid={!!errors.email}
            className={iconInput}
          />
        </div>
        <FieldError message={errors.email} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="register-password" className="text-[13px] font-semibold">{t('login.register.password')}</Label>
        <div className={iconField}>
          <Lock className={iconGlyph} aria-hidden="true" />
          <Input
            id="register-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder={t('login.register.passwordPlaceholder')}
            value={fields.password}
            onChange={set('password')}
            disabled={submitting}
            aria-invalid={!!errors.password}
            className="h-11 pl-10 pr-11 transition-all duration-200 focus-visible:border-brand/50 focus-visible:ring-brand/20"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
            className="absolute right-0 top-0 h-11 w-11 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            tabIndex={0}
          >
            {showPassword ? <EyeOff className="h-4 w-4 transition-transform duration-200 active:scale-90" /> : <Eye className="h-4 w-4 transition-transform duration-200 active:scale-90" />}
          </button>
        </div>
        <FieldError message={errors.password} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="register-confirm" className="text-[13px] font-semibold">{t('login.register.confirm')}</Label>
        <div className={iconField}>
          <Lock className={iconGlyph} aria-hidden="true" />
          <Input
            id="register-confirm"
            type={showConfirm ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder={t('login.register.confirmPlaceholder')}
            value={fields.confirm}
            onChange={set('confirm')}
            disabled={submitting}
            aria-invalid={!!errors.confirm}
            className="h-11 pl-10 pr-11 transition-all duration-200 focus-visible:border-brand/50 focus-visible:ring-brand/20"
          />
          <button
            type="button"
            onClick={() => setShowConfirm((v) => !v)}
            aria-label={showConfirm ? t('login.hidePassword') : t('login.showPassword')}
            className="absolute right-0 top-0 h-11 w-11 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            tabIndex={0}
          >
            {showConfirm ? <EyeOff className="h-4 w-4 transition-transform duration-200 active:scale-90" /> : <Eye className="h-4 w-4 transition-transform duration-200 active:scale-90" />}
          </button>
        </div>
        <FieldError message={errors.confirm} />
      </div>
      <AnimatePresence initial={false}>
        {serverError && <ErrorAlert key={serverError.title} error={serverError} />}
      </AnimatePresence>
      <Button
        type="submit"
        disabled={submitting}
        className="btn-sheen group/btn h-11 w-full rounded-lg bg-gradient-to-b from-primary to-primary/90 hover:from-primary hover:to-primary/85 text-primary-foreground text-sm font-semibold shadow-md shadow-primary/25 hover:shadow-lg hover:shadow-primary/40 active:scale-[0.98] transition-all duration-200"
      >
        {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        {submitting ? t('login.register.submitting') : t('login.register.createAccount')}
        {!submitting && (
          <ArrowRight className="h-4 w-4 ml-1.5 transition-transform duration-200 group-hover/btn:translate-x-0.5" aria-hidden="true" />
        )}
      </Button>
      <p className="text-[11px] text-foreground/75 dark:text-zinc-400 text-center leading-relaxed">
        {t('login.register.notice')}
      </p>
    </form>
  )
}

// ======================== HERO PANEL (bold landing, refined round 5) ========================

/** Eased count-up — fires after the hero settles so the stat numbers land
    together with the rest of the choreography. */
function CountUp({ to, suffix = '', delay = 700, duration = 1500 }: { to: number; suffix?: string; delay?: number; duration?: number }) {
  const [value, setValue] = React.useState(0)
  React.useEffect(() => {
    let raf = 0
    let start = 0
    const timer = window.setTimeout(() => {
      const tick = (now: number) => {
        if (!start) start = now
        const p = Math.min((now - start) / duration, 1)
        const eased = 1 - Math.pow(1 - p, 3)
        setValue(Math.round(eased * to))
        if (p < 1) raf = window.requestAnimationFrame(tick)
      }
      raf = window.requestAnimationFrame(tick)
    }, delay)
    return () => { window.clearTimeout(timer); window.cancelAnimationFrame(raf) }
  }, [to, delay, duration])
  return <span className="tabular-nums">{value}{suffix}</span>
}

/** Decorative terminal — the signature "dev tool" prop, with a spring 3D
    tilt that follows the pointer. Round 5 decluttered it: the tacked-on
    floating LIVE chip and the side device rail are gone (they read as
    clutter, and the chip clipped at the column edge); the live status now
    lives INSIDE the title bar as an integrated mono indicator, and the
    window stretches the full column width so the hero block feels anchored.
    Lines type in after the panel settles; a block cursor keeps blinking on
    the trailing prompt. Pure decoration (aria-hidden). */
function TiltTerminal() {
  const ref = React.useRef<HTMLDivElement>(null)
  const mx = useMotionValue(0.5)
  const my = useMotionValue(0.5)
  const rotateX = useSpring(useTransform(my, [0, 1], [4.5, -4.5]), { stiffness: 140, damping: 18 })
  const rotateY = useSpring(useTransform(mx, [0, 1], [-4.5, 4.5]), { stiffness: 140, damping: 18 })

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    mx.set(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)))
    my.set(Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)))
  }
  const reset = () => { mx.set(0.5); my.set(0.5) }

  const lines = [
    { prompt: true, text: 'mesh start --all' },
    { prompt: false, text: '✓ environments started — mesh online' },
    { prompt: false, text: '✓ llm auto-repair armed' },
    { prompt: false, text: '✓ mesh sync — 6 devices joined' },
  ]
  return (
    <motion.div variants={itemVariants} aria-hidden="true" className="relative isolate w-full">
      <div className="absolute -inset-4 -z-10 rounded-2xl bg-brand/10 blur-2xl dark:bg-brand/15" />
      <motion.div
        ref={ref}
        onPointerMove={onMove}
        onPointerLeave={reset}
        style={{ rotateX, rotateY, transformPerspective: 1000 }}
        className="relative overflow-hidden rounded-xl border border-zinc-200/90 dark:border-zinc-700/60 bg-white/90 dark:bg-zinc-900/90 shadow-xl shadow-black/5 dark:shadow-black/40 backdrop-blur-sm"
      >
        <div className="flex items-center gap-1.5 border-b border-zinc-200/80 dark:border-zinc-800/80 px-3.5 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
          <span className="ml-2 font-mono text-[10px] text-zinc-400 dark:text-zinc-500">mesh — dashboard</span>
          {/* Integrated live indicator — replaces the old floating chip. */}
          <span className="ml-auto flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-brand opacity-60 animate-ping" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand" />
            </span>
            <span className="font-mono text-[10px] font-semibold tracking-[0.14em] text-brand-strong dark:text-brand">LIVE</span>
          </span>
        </div>
        <div className="px-4 py-3 font-mono text-xs leading-[1.7] space-y-0.5">
          {lines.map((line, i) => (
            <motion.p
              key={line.text}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1.0 + i * 0.35, duration: 0.3 }}
              className={line.prompt
                ? 'text-zinc-700 dark:text-zinc-300'
                : 'text-zinc-500 dark:text-zinc-500'}
            >
              {line.prompt && <span className="text-brand-strong dark:text-brand mr-1.5">$</span>}
              {line.text}
            </motion.p>
          ))}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.0 + lines.length * 0.35, duration: 0.3 }}
            className="text-zinc-700 dark:text-zinc-300"
          >
            <span className="text-brand-strong dark:text-brand mr-1.5">$</span>
            <span className="terminal-cursor inline-block h-3 w-[7px] translate-y-[2px] bg-brand-strong/70 dark:bg-brand/70" />
          </motion.p>
        </div>
      </motion.div>
    </motion.div>
  )
}

/** The immersive left column of the full-bleed auth split: oversized display
    type with a static two-tone gradient tagline (always complete — round 5
    removed the rotating typewriter and the edge-clipped ticker, both read
    as "text not fully displayed"), the full-width tilting terminal and a
    glass CountUp stats strip. No column-scoped canvas anymore: both columns
    share the one continuous backdrop, so no seam forms between them. */
function HeroPanel() {
  const t = useT()
  const stats = [
    { icon: MonitorSmartphone, value: 100, suffix: '%', label: t('login.stat.sync') },
    { icon: Rocket, value: 10, suffix: '×', label: t('login.stat.faster') },
    { icon: Sparkles, value: 24, suffix: '/7', label: t('login.stat.repair') },
  ]
  return (
    <motion.aside
      variants={panelVariants}
      initial="hidden"
      animate="show"
      className="relative hidden lg:flex h-full flex-col justify-center p-10 xl:p-14"
    >
      {/* Right-anchored display group (user ask: the hero content should sit
          close to the login form, not stranded at the far left). The whole
          cluster hugs the form column — fixed ~90px gap at every lg+ width —
          and is capped at max-w-2xl so the terminal keeps editorial
          proportions; below the cap it fills the column exactly like before
          (no regression at the smallest lg widths). The login root caps the
          whole grid at 1280px + mx-auto, so this cluster + the card form one
          mid-page group (user ask: all login content centered). */}
      <div className="ml-auto flex w-full max-w-2xl flex-col gap-8 xl:gap-10">
      {/* Display block — eyebrow, oversized wordmark, gradient tagline, subtitle. */}
      <div>
        <motion.div variants={itemVariants}>
          <div className="inline-flex items-center gap-2 rounded-full border border-brand/25 bg-brand-soft/60 px-3 py-1">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-brand opacity-60 animate-ping" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand" />
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-brand-strong dark:text-brand">
              {t('login.eyebrow')}
            </span>
          </div>
        </motion.div>
        <motion.h1
          variants={itemVariants}
          className="mt-6 text-6xl xl:text-7xl font-extrabold tracking-tighter leading-[0.95] text-foreground"
        >
          {t('login.brand')}
        </motion.h1>
        {/* Static gradient tagline — the pan animation moves color through
            complete glyphs; the phrase itself never types, erases or clips. */}
        <motion.p variants={itemVariants} className="login-gradient-text mt-4 text-3xl xl:text-4xl font-bold tracking-tight leading-snug max-w-xl">
          {t('login.tagline')}
        </motion.p>
        <motion.p variants={itemVariants} className="mt-4 max-w-md text-base text-muted-foreground leading-relaxed">
          {t('login.subtitle')}
        </motion.p>
      </div>

      {/* Showcase + proof as one anchored group — the terminal and the
          stats strip travel together (fixed gap) so the stats never float
          disconnected at the bottom of tall viewports; the flexible space
          sits between the display block and this group, the classic
          split-hero rhythm. */}
      <div className="space-y-6">
        <TiltTerminal />

        {/* Proof block — glass CountUp chips; labels wrap instead of
            truncating so every word stays fully visible at every lg+ width. */}
        <motion.ul variants={itemVariants} className="grid grid-cols-3 gap-3">
          {stats.map((s) => (
            <li
              key={s.label}
              aria-label={`${s.value}${s.suffix} — ${s.label}`}
              className="flex items-center gap-3 rounded-xl border border-border/60 dark:border-white/10 bg-white/55 dark:bg-white/5 backdrop-blur-md px-4 py-3 shadow-xs"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-brand/25 bg-brand-soft/70 text-brand-strong dark:text-brand">
                <s.icon className="h-4.5 w-4.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-lg font-bold leading-none tracking-tight">
                  <CountUp to={s.value} suffix={s.suffix} />
                </span>
                <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">{s.label}</span>
              </span>
            </li>
          ))}
        </motion.ul>
      </div>
      </div>
    </motion.aside>
  )
}

// ======================== LOGIN SCREEN ========================

export function LoginScreen({ onAuthed, seedHint }: { onAuthed: () => void; seedHint?: boolean }) {
  const t = useT()
  const [tab, setTab] = React.useState<'signin' | 'register'>('signin')
  const [googleError, setGoogleError] = React.useState<string | null>(null)

  // Surface ?authError=<code> (Google OAuth failure redirect), then strip it
  // from the URL so a refresh doesn't replay the message.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('authError')
    if (code) {
      setGoogleError(code)
      setTab('signin')
      params.delete('authError')
      const qs = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
    }
  }, [])

  return (
    <MotionConfig reducedMotion="user">
      {/* Full-bleed auth split: the immersive hero column takes the LEFT
          side on lg+, the form zone owns a snug fixed 520px rail on the
          right — both columns stretch to the same (viewport) height, which
          resolves the earlier equal-height ask structurally. The fixed rail
          (instead of a proportional 1fr column) is what keeps the login card
          a constant ~90px from the hero cluster at every width — a fluid
          column used to park the card far from the hero on wide screens
          (user ask: "hero content too far from the login window"). Both sit
          on ONE continuous backdrop (no column-scoped tint, so no seam where
          they meet). Below lg the hero hides and the form centers over the
          shared backdrop.

          Centering: the grid is capped at 1280px and mx-auto'd (user ask:
          "all login content centered") — the hero cluster + card group now
          sits mid-page with symmetric page margins at every lg+ width
          (previously the group drifted right as the viewport widened: at
          1920px it sat ~300px right of center). Below the cap (lg..1280) the
          grid fills the viewport exactly as before, zero regression. The
          backdrop is position:fixed so it stays full-bleed despite the cap. */}
      <div className="relative min-h-screen lg:grid lg:grid-cols-[1fr_520px] lg:mx-auto lg:max-w-[1280px] overflow-x-clip">
        {/* Layered hero backdrop: brand sky washes, grid, drifting orbs,
            rising particles, stars, grain — shared by both columns. */}
        <div className="login-backdrop" aria-hidden="true">
          <div className="login-orb login-orb-a" />
          <div className="login-orb login-orb-b" />
          <div className="login-orb login-orb-c" />
          <div className="login-particles">
            {PARTICLES.map((p, i) => (
              <span key={i} className="login-particle" style={p} />
            ))}
          </div>
          <div className="login-stars" />
          <div className="login-noise" />
        </div>
        {/* Standalone language switcher (task 17) — viewport top-right corner.
            position:fixed (not absolute) so it stays pinned to the screen
            even though the grid container is capped + centered. */}
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.45, ease: 'easeOut' }}
          className="fixed top-4 right-4 z-20 flex items-center gap-1"
        >
          <LanguageToggle />
        </motion.div>

        {/* ---------- LEFT hero column (lg+) ---------- */}
        <HeroPanel />

        {/* ---------- RIGHT form column ---------- */}
        <div className="relative z-10 flex min-h-screen flex-col">
          <main className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 24, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 260, damping: 26, delay: 0.12 }}
              className="relative isolate flex w-full max-w-md mx-auto lg:mx-0"
            >
              {/* Ambient brand glow behind the card. */}
              <div
                aria-hidden="true"
                className="absolute -inset-6 -z-10 rounded-[2.25rem] bg-brand/10 blur-2xl opacity-80 dark:opacity-60"
              />
              {/* Rotating two-tone conic ring — the card's living border. The
                  1.5px padding box frames the spinning gradient; the content
                  surface sits on top, untouched by the rotation. */}
              <div className="login-card-glow relative w-full overflow-hidden rounded-[1.4rem] p-[1.5px]">
                <div aria-hidden="true" className="login-conic" />
                <div className="relative flex flex-col overflow-hidden rounded-[calc(1.4rem-1.5px)] bg-background/95 backdrop-blur-md p-6 sm:p-8">
                  {/* Brand hairline across the card top — same decoration the
                      interior project cards and stat tiles carry. */}
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-0 left-0 right-0 h-[2px] z-10 bg-gradient-to-r from-brand/50 via-brand/20 to-transparent"
                  />
                  {/* Mobile eyebrow — mirrors the hero column's category pill
                      below lg. */}
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.25, duration: 0.4, ease: 'easeOut' }}
                    className="flex justify-center lg:hidden mb-5"
                  >
                    <div className="inline-flex items-center gap-2 rounded-full border border-brand/25 bg-brand-soft/60 px-3 py-1">
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full rounded-full bg-brand opacity-60 animate-ping" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand" />
                      </span>
                      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-brand-strong dark:text-brand">
                        {t('login.eyebrow')}
                      </span>
                    </div>
                  </motion.div>

                  {/* Heading + subtitle + form swap as one crossfading unit. */}
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={tab}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.22, ease: 'easeOut' }}
                    >
                      <h2 className="text-[1.6rem] font-bold tracking-tight">
                        {tab === 'signin' ? t('login.welcomeBack') : t('login.createAccount')}
                      </h2>
                      <p className="text-sm text-muted-foreground mt-1.5 mb-5">
                        {tab === 'signin' ? t('login.signinSubtitle') : t('login.registerSubtitle')}
                      </p>

                      <Tabs value={tab} onValueChange={(v) => setTab(v as 'signin' | 'register')}>
                        <TabsList className="h-9 w-full justify-start bg-transparent p-0 gap-2 mb-5">
                          {/* Sliding pill indicator — one shared layoutId
                              springs between the two triggers on switch. */}
                          <TabsTrigger value="signin" className="relative h-8 px-4 text-xs rounded-full border-transparent text-muted-foreground transition-colors data-[state=active]:text-brand-strong data-[state=active]:bg-transparent data-[state=active]:shadow-none">
                            {tab === 'signin' && (
                              <motion.span
                                layoutId="auth-tab-pill"
                                transition={{ type: 'spring', stiffness: 480, damping: 34 }}
                                className="absolute inset-0 rounded-full bg-brand-soft ring-1 ring-inset ring-brand/30"
                              />
                            )}
                            <span className="relative">{t('login.tab.signin')}</span>
                          </TabsTrigger>
                          <TabsTrigger value="register" className="relative h-8 px-4 text-xs rounded-full border-transparent text-muted-foreground transition-colors data-[state=active]:text-brand-strong data-[state=active]:bg-transparent data-[state=active]:shadow-none">
                            {tab === 'register' && (
                              <motion.span
                                layoutId="auth-tab-pill"
                                transition={{ type: 'spring', stiffness: 480, damping: 34 }}
                                className="absolute inset-0 rounded-full bg-brand-soft ring-1 ring-inset ring-brand/30"
                              />
                            )}
                            <span className="relative">{t('login.tab.register')}</span>
                          </TabsTrigger>
                        </TabsList>
                        {googleError && (
                          <div className="mb-4">
                            <ErrorAlert error={{ tone: 'destructive', title: t(googleAuthErrorKey(googleError) as Parameters<typeof t>[0]) }} />
                          </div>
                        )}
                        {tab === 'signin' ? (
                          <SignInForm key="signin" onAuthed={onAuthed} seedHint={seedHint} />
                        ) : (
                          <RegisterForm key="register" onBackToSignIn={() => setTab('signin')} />
                        )}
                      </Tabs>
                    </motion.div>
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          </main>

          <motion.footer
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.55, duration: 0.6 }}
            className="mt-auto pb-7 pt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground"
          >
            <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
            {t('login.footer')}
          </motion.footer>
        </div>
      </div>
    </MotionConfig>
  )
}

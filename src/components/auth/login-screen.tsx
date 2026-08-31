'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Zap, MonitorSmartphone, PlayCircle, Sparkles, Eye, EyeOff,
  AlertCircle, CheckCircle2, Loader2, Info,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { GoogleStatus } from './auth-types'

const REMEMBER_KEY = 'dashboard-auth-remember'
const EMAIL_KEY = 'dashboard-auth-email'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface FormError { tone: 'destructive' | 'warning'; title: string; detail?: string }

function googleAuthError(code: string): FormError {
  switch (code) {
    case 'email_conflict':
      return { tone: 'destructive', title: 'This email is registered with a password account. Sign in with email and password instead.' }
    case 'state_mismatch':
      return { tone: 'warning', title: 'Sign-in session expired, try again.' }
    case 'rejected':
      return { tone: 'destructive', title: 'Your access has been rejected.' }
    default:
      return { tone: 'destructive', title: 'Google sign-in failed.' }
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
    <div
      role="alert"
      className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${amber
        ? 'border-amber-300/70 bg-amber-50/80 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300'
        : 'border-destructive/40 bg-card text-destructive dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-400'}`}
    >
      <AlertCircle className={`h-4 w-4 shrink-0 mt-0.5 ${amber ? 'text-amber-500' : 'text-destructive dark:text-red-400'}`} />
      <div className="min-w-0">
        <p className="font-medium leading-snug">{error.title}</p>
        {error.detail && <p className="mt-0.5 text-xs opacity-80 leading-relaxed">{error.detail}</p>}
      </div>
    </div>
  )
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="text-xs text-destructive dark:text-red-400 mt-1.5 leading-snug">{message}</p>
}

/** Google sign-in button + configuration status chip. */
function GoogleSignInButton({ status }: { status: GoogleStatus | null }) {
  const loading = status === null
  const configured = !!status?.configured
  const button = (
    <Button
      type="button"
      variant="outline"
      disabled={loading || !configured}
      onClick={() => { window.location.href = '/api/auth/google' }}
      className="h-11 w-full bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-700/70 text-zinc-700 dark:text-zinc-200 text-sm font-medium shadow-xs transition-colors disabled:opacity-60"
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <GoogleLogo className="h-4 w-4 shrink-0" />
      )}
      <span className="ml-2.5">Continue with Google</span>
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
              Google sign-in is not configured. Ask an admin to configure it (Settings → User Management → Google Sign-in).
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {!loading && !configured && (
        <p className="text-[11px] text-muted-foreground/80 text-center">Not configured — ask an admin to enable Google sign-in</p>
      )}
    </div>
  )
}

function Divider() {
  return (
    <div className="relative my-5" aria-hidden="true">
      <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-border/60" /></div>
      <div className="relative flex justify-center">
        <span className="bg-background px-3 text-[11px] uppercase tracking-wider text-muted-foreground">or continue with email</span>
      </div>
    </div>
  )
}

// ======================== SIGN IN FORM ========================

function SignInForm({ onAuthed, seedHint }: { onAuthed: () => void; seedHint?: boolean }) {
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
      setError({ tone: 'destructive', title: 'Please enter your email and password.' })
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
        onAuthed()
        return
      }
      if (res.status === 403) {
        if (data.code === 'pending') {
          setError({ tone: 'warning', title: 'Your registration is awaiting admin approval.', detail: 'You will be able to sign in once an administrator approves your account.' })
        } else if (data.code === 'rejected') {
          setError({ tone: 'destructive', title: 'Your access has been rejected.', detail: data.rejectionReason ? `Reason: ${data.rejectionReason}` : undefined })
        } else {
          setError({ tone: 'destructive', title: data.error || 'Sign-in failed.' })
        }
      } else if (res.status === 429) {
        setError({ tone: 'warning', title: data.error || 'Too many attempts — please wait a moment and try again.' })
      } else {
        setError({ tone: 'destructive', title: data.error || 'Invalid email or password.' })
      }
    } catch {
      setError({ tone: 'destructive', title: 'Network error — could not reach the server.' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <GoogleGate />
      <Divider />
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="signin-email">Email</Label>
          <Input
            id="signin-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            className="h-11"
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="signin-password">Password</Label>
          </div>
          <div className="relative">
            <Input
              id="signin-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              className="h-11 pr-11"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-0 top-0 h-11 w-11 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              tabIndex={0}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
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
          <Label htmlFor="signin-remember" className="text-sm font-normal text-muted-foreground cursor-pointer">Remember me</Label>
        </div>
        {error && <ErrorAlert error={error} />}
        <Button
          type="submit"
          disabled={submitting}
          className="h-11 w-full bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold shadow-sm transition-colors"
        >
          {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
        {seedHint && (
          <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-3.5 py-2.5 text-xs text-muted-foreground leading-relaxed">
            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              Default admin: <code className="font-mono">admin@dashboard.local</code> · <code className="font-mono">admin123456</code> — change the password after first sign-in.
            </span>
          </div>
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

function validateRegister(f: RegisterFields): RegisterErrors {
  const errors: RegisterErrors = {}
  const name = f.name.trim()
  if (name.length < 2 || name.length > 40) errors.name = 'Name must be 2–40 characters.'
  if (!EMAIL_RE.test(f.email.trim())) errors.email = 'Enter a valid email address.'
  if (f.password.length < 8 || !/[A-Za-z]/.test(f.password) || !/\d/.test(f.password)) {
    errors.password = 'At least 8 characters, including a letter and a digit.'
  }
  if (f.confirm !== f.password) errors.confirm = 'Passwords do not match.'
  return errors
}

function RegisterForm({ onBackToSignIn }: { onBackToSignIn: () => void }) {
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
    const validation = validateRegister(fields)
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
        setServerError({ tone: 'destructive', title: 'This email is already registered.' })
      } else if (res.status === 429) {
        setServerError({ tone: 'warning', title: data.error || 'Too many attempts — please wait a moment and try again.' })
      } else {
        setServerError({ tone: 'destructive', title: data.error || 'Registration failed.' })
      }
    } catch {
      setServerError({ tone: 'destructive', title: 'Network error — could not reach the server.' })
    } finally {
      setSubmitting(false)
    }
  }

  if (succeeded) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="py-4 flex flex-col items-center text-center"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-950/40 ring-4 ring-emerald-100 dark:ring-emerald-900/40 mb-4">
          <CheckCircle2 className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />
        </div>
        <h3 className="text-lg font-semibold">Application submitted</h3>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed max-w-[300px]">
          An administrator will review your registration. Once approved you can sign in with these credentials.
        </p>
        <Button variant="outline" onClick={onBackToSignIn} className="mt-6 h-11 px-6 text-sm">
          Back to sign in
        </Button>
      </motion.div>
    )
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="register-name">Name</Label>
        <Input
          id="register-name"
          type="text"
          autoComplete="name"
          placeholder="Your name"
          value={fields.name}
          onChange={set('name')}
          disabled={submitting}
          aria-invalid={!!errors.name}
          className="h-11"
        />
        <FieldError message={errors.name} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="register-email">Email</Label>
        <Input
          id="register-email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={fields.email}
          onChange={set('email')}
          disabled={submitting}
          aria-invalid={!!errors.email}
          className="h-11"
        />
        <FieldError message={errors.email} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="register-password">Password</Label>
        <div className="relative">
          <Input
            id="register-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder="At least 8 characters"
            value={fields.password}
            onChange={set('password')}
            disabled={submitting}
            aria-invalid={!!errors.password}
            className="h-11 pr-11"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            className="absolute right-0 top-0 h-11 w-11 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            tabIndex={0}
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <FieldError message={errors.password} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="register-confirm">Confirm password</Label>
        <div className="relative">
          <Input
            id="register-confirm"
            type={showConfirm ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder="Repeat your password"
            value={fields.confirm}
            onChange={set('confirm')}
            disabled={submitting}
            aria-invalid={!!errors.confirm}
            className="h-11 pr-11"
          />
          <button
            type="button"
            onClick={() => setShowConfirm((v) => !v)}
            aria-label={showConfirm ? 'Hide password' : 'Show password'}
            className="absolute right-0 top-0 h-11 w-11 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            tabIndex={0}
          >
            {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <FieldError message={errors.confirm} />
      </div>
      {serverError && <ErrorAlert error={serverError} />}
      <Button
        type="submit"
        disabled={submitting}
        className="h-11 w-full bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold shadow-sm transition-colors"
      >
        {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        {submitting ? 'Submitting…' : 'Create account'}
      </Button>
      <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
        New accounts require administrator approval before first sign-in.
      </p>
    </form>
  )
}

// ======================== LOGIN SCREEN ========================

export function LoginScreen({ onAuthed, seedHint }: { onAuthed: () => void; seedHint?: boolean }) {
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

  const features = [
    { icon: MonitorSmartphone, title: 'Multi-device control', desc: 'Local and remote machines from one surface.' },
    { icon: PlayCircle, title: 'One-click environment start', desc: 'Start, stop and restart project environments.' },
    { icon: Sparkles, title: 'LLM analysis & auto-repair', desc: 'Automated analysis and failure self-healing.' },
  ]

  return (
    <div className="min-h-screen flex flex-col">
      <div className="page-backdrop" aria-hidden="true" />
      <main className="flex-1 flex items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-4xl lg:grid lg:grid-cols-[1fr_minmax(0,26rem)] lg:gap-14 items-center">
          {/* ---------- LEFT brand panel (lg+) ---------- */}
          <div className="hidden lg:flex flex-col gap-9 max-w-md">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-sm shadow-primary/40 ring-1 ring-primary/30 ring-inset">
                <Zap className="h-5 w-5" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
            </div>
            <p className="text-base text-muted-foreground leading-relaxed -mt-4">
              Multi-device project dashboard — environments, logs and repair tooling in one place.
            </p>
            <ul className="space-y-5">
              {features.map((f) => (
                <li key={f.title} className="flex items-start gap-3.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/80 text-brand-strong dark:text-brand">
                    <f.icon className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{f.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{f.desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* ---------- RIGHT auth card ---------- */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="w-full max-w-md mx-auto lg:mx-0"
          >
            <div className="rounded-xl border border-border/60 bg-background/95 backdrop-blur-sm shadow-sm p-6 sm:p-8">
              {/* Mobile logo row */}
              <div className="flex items-center gap-2.5 lg:hidden mb-5">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-sm shadow-primary/40 ring-1 ring-primary/30 ring-inset">
                  <Zap className="h-4 w-4" />
                </div>
                <span className="text-base font-bold">Dashboard</span>
              </div>

              <h2 className="text-xl font-semibold tracking-tight">
                {tab === 'signin' ? 'Welcome back' : 'Create your account'}
              </h2>
              <p className="text-sm text-muted-foreground mt-1 mb-5">
                {tab === 'signin' ? 'Sign in to continue to your dashboard.' : 'Register to request access to the dashboard.'}
              </p>

              <Tabs value={tab} onValueChange={(v) => setTab(v as 'signin' | 'register')}>
                <TabsList className="h-9 w-full justify-start bg-transparent p-0 gap-2 mb-5">
                  <TabsTrigger value="signin" className="px-3.5 py-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-brand-soft data-[state=active]:text-brand-strong dark:data-[state=active]:bg-brand-soft dark:data-[state=active]:text-brand-strong rounded-full transition-colors">Sign in</TabsTrigger>
                  <TabsTrigger value="register" className="px-3.5 py-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-brand-soft data-[state=active]:text-brand-strong dark:data-[state=active]:bg-brand-soft dark:data-[state=active]:text-brand-strong rounded-full transition-colors">Register</TabsTrigger>
                </TabsList>
                {googleError && (
                  <div className="mb-4">
                    <ErrorAlert error={googleAuthError(googleError)} />
                  </div>
                )}
                {tab === 'signin' ? (
                  <SignInForm key="signin" onAuthed={onAuthed} seedHint={seedHint} />
                ) : (
                  <RegisterForm key="register" onBackToSignIn={() => setTab('signin')} />
                )}
              </Tabs>
            </div>
          </motion.div>
        </div>
      </main>
      <footer className="mt-auto pb-5 pt-2 text-center text-[11px] text-muted-foreground/70">
        Dashboard · internal tooling
      </footer>
    </div>
  )
}

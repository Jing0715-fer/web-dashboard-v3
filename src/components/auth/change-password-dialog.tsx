'use client'

import * as React from 'react'
import { Eye, EyeOff, KeyRound, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useT, type I18nContextValue } from '@/lib/i18n'

interface ChangePasswordDialogProps {
  open: boolean
  onClose: () => void
}

interface Fields { current: string; next: string; confirm: string }
type FieldErrors = Partial<Record<keyof Fields, string>>

function validate(f: Fields, t: I18nContextValue['t']): FieldErrors {
  const errors: FieldErrors = {}
  if (!f.current) errors.current = t('auth.changePw.error.current')
  if (f.next.length < 8 || !/[A-Za-z]/.test(f.next) || !/\d/.test(f.next)) {
    errors.next = t('auth.changePw.error.next')
  }
  if (f.confirm !== f.next) errors.confirm = t('auth.changePw.error.confirm')
  return errors
}

export function ChangePasswordDialog({ open, onClose }: ChangePasswordDialogProps) {
  const t = useT()
  const [fields, setFields] = React.useState<Fields>({ current: '', next: '', confirm: '' })
  const [errors, setErrors] = React.useState<FieldErrors>({})
  const [showCurrent, setShowCurrent] = React.useState(false)
  const [showNext, setShowNext] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const [succeeded, setSucceeded] = React.useState(false)

  // Reset state whenever the dialog opens; auto-close shortly after success.
  React.useEffect(() => {
    if (open) {
      setFields({ current: '', next: '', confirm: '' })
      setErrors({})
      setServerError(null)
      setSucceeded(false)
      setShowCurrent(false)
      setShowNext(false)
    }
  }, [open])

  React.useEffect(() => {
    if (!succeeded) return
    const timer = setTimeout(() => onClose(), 1500)
    return () => clearTimeout(timer)
  }, [succeeded, onClose])

  const set = (key: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFields((f) => ({ ...f, [key]: e.target.value }))
    setErrors((prev) => ({ ...prev, [key]: undefined }))
    setServerError(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting) return
    const validation = validate(fields, t)
    setErrors(validation)
    if (Object.keys(validation).length > 0) return
    setSubmitting(true)
    setServerError(null)
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: fields.current, newPassword: fields.next }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setSucceeded(true)
        return
      }
      setServerError(data.error || (res.status === 401 ? t('auth.changePw.error.incorrect') : t('auth.changePw.error.failed')))
    } catch {
      setServerError(t('login.error.network'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-brand-strong" />
            {t('auth.changePw.title')}
          </DialogTitle>
          <DialogDescription>{t('auth.changePw.desc')}</DialogDescription>
        </DialogHeader>
        {succeeded ? (
          <div className="py-5 flex flex-col items-center text-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-950/40 ring-4 ring-emerald-100 dark:ring-emerald-900/40">
              <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <p className="text-sm font-medium">{t('auth.changePw.updated')}</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="chpw-current">{t('auth.changePw.current')}</Label>
              <div className="relative">
                <Input
                  id="chpw-current"
                  type={showCurrent ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={fields.current}
                  onChange={set('current')}
                  disabled={submitting}
                  aria-invalid={!!errors.current}
                  className="h-10 pr-10"
                />
                <button type="button" tabIndex={0} onClick={() => setShowCurrent((v) => !v)} aria-label={showCurrent ? t('login.hidePassword') : t('login.showPassword')}
                  className="absolute right-0 top-0 h-10 w-10 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.current && <p className="text-xs text-destructive dark:text-red-400 mt-1.5">{errors.current}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="chpw-new">{t('auth.changePw.new')}</Label>
              <div className="relative">
                <Input
                  id="chpw-new"
                  type={showNext ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder={t('auth.changePw.newPlaceholder')}
                  value={fields.next}
                  onChange={set('next')}
                  disabled={submitting}
                  aria-invalid={!!errors.next}
                  className="h-10 pr-10"
                />
                <button type="button" tabIndex={0} onClick={() => setShowNext((v) => !v)} aria-label={showNext ? t('login.hidePassword') : t('login.showPassword')}
                  className="absolute right-0 top-0 h-10 w-10 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {showNext ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.next && <p className="text-xs text-destructive dark:text-red-400 mt-1.5">{errors.next}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="chpw-confirm">{t('auth.changePw.confirm')}</Label>
              <Input
                id="chpw-confirm"
                type="password"
                autoComplete="new-password"
                placeholder={t('auth.changePw.confirmPlaceholder')}
                value={fields.confirm}
                onChange={set('confirm')}
                disabled={submitting}
                aria-invalid={!!errors.confirm}
                className="h-10"
              />
              {errors.confirm && <p className="text-xs text-destructive dark:text-red-400 mt-1.5">{errors.confirm}</p>}
            </div>
            {serverError && (
              <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-card px-3.5 py-2.5 text-sm text-destructive dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <p className="font-medium leading-snug">{serverError}</p>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting} className="h-10">{t('common.cancel')}</Button>
              <Button type="submit" disabled={submitting} className="h-10 bg-primary hover:bg-primary/90 text-primary-foreground">
                {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {submitting ? t('auth.changePw.submitting') : t('auth.changePw.submit')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

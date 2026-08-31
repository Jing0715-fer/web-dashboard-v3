'use client'

import * as React from 'react'
import { Eye, EyeOff, KeyRound, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface ChangePasswordDialogProps {
  open: boolean
  onClose: () => void
}

interface Fields { current: string; next: string; confirm: string }
type FieldErrors = Partial<Record<keyof Fields, string>>

function validate(f: Fields): FieldErrors {
  const errors: FieldErrors = {}
  if (!f.current) errors.current = 'Enter your current password.'
  if (f.next.length < 8 || !/[A-Za-z]/.test(f.next) || !/\d/.test(f.next)) {
    errors.next = 'At least 8 characters, including a letter and a digit.'
  }
  if (f.confirm !== f.next) errors.confirm = 'Passwords do not match.'
  return errors
}

export function ChangePasswordDialog({ open, onClose }: ChangePasswordDialogProps) {
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
    const t = setTimeout(() => onClose(), 1500)
    return () => clearTimeout(t)
  }, [succeeded, onClose])

  const set = (key: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFields((f) => ({ ...f, [key]: e.target.value }))
    setErrors((prev) => ({ ...prev, [key]: undefined }))
    setServerError(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting) return
    const validation = validate(fields)
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
      setServerError(data.error || (res.status === 401 ? 'Current password is incorrect.' : 'Failed to update password.'))
    } catch {
      setServerError('Network error — could not reach the server.')
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
            Change Password
          </DialogTitle>
          <DialogDescription>Set a new password for your account.</DialogDescription>
        </DialogHeader>
        {succeeded ? (
          <div className="py-5 flex flex-col items-center text-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-950/40 ring-4 ring-emerald-100 dark:ring-emerald-900/40">
              <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <p className="text-sm font-medium">Password updated</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="chpw-current">Current password</Label>
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
                <button type="button" tabIndex={0} onClick={() => setShowCurrent((v) => !v)} aria-label={showCurrent ? 'Hide password' : 'Show password'}
                  className="absolute right-0 top-0 h-10 w-10 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.current && <p className="text-xs text-destructive dark:text-red-400 mt-1.5">{errors.current}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="chpw-new">New password</Label>
              <div className="relative">
                <Input
                  id="chpw-new"
                  type={showNext ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  value={fields.next}
                  onChange={set('next')}
                  disabled={submitting}
                  aria-invalid={!!errors.next}
                  className="h-10 pr-10"
                />
                <button type="button" tabIndex={0} onClick={() => setShowNext((v) => !v)} aria-label={showNext ? 'Hide password' : 'Show password'}
                  className="absolute right-0 top-0 h-10 w-10 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {showNext ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.next && <p className="text-xs text-destructive dark:text-red-400 mt-1.5">{errors.next}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="chpw-confirm">Confirm new password</Label>
              <Input
                id="chpw-confirm"
                type="password"
                autoComplete="new-password"
                placeholder="Repeat your new password"
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
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting} className="h-10">Cancel</Button>
              <Button type="submit" disabled={submitting} className="h-10 bg-primary hover:bg-primary/90 text-primary-foreground">
                {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {submitting ? 'Updating…' : 'Update password'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

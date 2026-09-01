'use client'

import * as React from 'react'
import {
  Monitor, Smartphone, Tablet, Laptop, RefreshCw, Loader2,
  Ban, LogOut, AlertCircle, ShieldCheck,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { addToast } from '@/hooks/use-toast'
import { useI18n, type I18nContextValue } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * Active-sessions manager (Task 19).
 * Lists the signed-in devices for the current account — admins can switch to
 * a system-wide view — and lets the user revoke individual sessions (or all
 * other sessions at once). Session rows come from GET /api/auth/sessions;
 * every request auto-carries the bearer token via the session-token fetch
 * patch, so this works in the sandbox preview iframe as well.
 */

interface SessionInfo {
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

interface SessionsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when the current session turned out to be revoked (401) — forces sign-out. */
  onForceLogout?: () => void
  /** Whether the current user is an admin (shows the all-users scope). */
  isAdmin?: boolean
}

const DEVICE_ICONS: Record<string, React.ElementType> = {
  desktop: Monitor,
  mobile: Smartphone,
  tablet: Tablet,
  unknown: Laptop,
}

/** Relative time via the shared `time.*` dictionary keys. */
function timeAgo(iso: string, t: I18nContextValue['t']): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return t('time.now')
  if (mins < 60) return t('time.minutesAgo', { count: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('time.hoursAgo', { count: hours })
  return t('time.daysAgo', { count: Math.floor(hours / 24) })
}

export function SessionsDialog({ open, onOpenChange, onForceLogout, isAdmin = false }: SessionsDialogProps) {
  const { t, lang } = useI18n()
  const [scope, setScope] = React.useState<'mine' | 'all'>('mine')
  const [sessions, setSessions] = React.useState<SessionInfo[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [loadError, setLoadError] = React.useState(false)
  const [revokingId, setRevokingId] = React.useState<string | null>(null)
  const [revokingAll, setRevokingAll] = React.useState(false)

  const fmtDate = React.useCallback(
    (iso: string) =>
      new Date(iso).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [lang],
  )

  // ---- data loading ----
  const load = React.useCallback(async () => {
    if (!open) return
    setLoading(true)
    setLoadError(false)
    try {
      const res = await fetch(`/api/auth/sessions${scope === 'all' ? '?scope=all' : ''}`, { cache: 'no-store' })
      if (res.status === 401) {
        // Our own session was revoked elsewhere — hand off to sign-out.
        onOpenChange(false)
        onForceLogout?.()
        return
      }
      if (!res.ok) throw new Error(`sessions ${res.status}`)
      const data = (await res.json()) as { sessions?: SessionInfo[] }
      setSessions(Array.isArray(data.sessions) ? data.sessions : [])
    } catch {
      setLoadError(true)
      setSessions(null)
    } finally {
      setLoading(false)
    }
  }, [open, scope, onOpenChange, onForceLogout])

  React.useEffect(() => {
    if (open) void load()
  }, [open, load])

  // Refresh every 30s while the dialog is open.
  React.useEffect(() => {
    if (!open) return
    const timer = setInterval(() => { void load() }, 30_000)
    return () => clearInterval(timer)
  }, [open, load])

  // Reset the scope when reopening.
  React.useEffect(() => {
    if (open) setScope('mine')
  }, [open])

  // ---- actions ----
  const handleRevoke = async (session: SessionInfo) => {
    if (revokingId || session.current) return
    setRevokingId(session.id)
    try {
      const res = await fetch(`/api/auth/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' })
      if (res.status === 401) {
        onOpenChange(false)
        onForceLogout?.()
        return
      }
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        addToast({ title: t('sessions.loadFailed'), description: data.error, variant: 'destructive' })
        return
      }
      addToast({ title: t('sessions.revoked'), variant: 'default' })
      await load()
    } catch {
      addToast({ title: t('sessions.loadFailed'), variant: 'destructive' })
    } finally {
      setRevokingId(null)
    }
  }

  const handleRevokeAll = async () => {
    if (revokingAll) return
    setRevokingAll(true)
    try {
      const res = await fetch('/api/auth/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (res.status === 401) {
        onOpenChange(false)
        onForceLogout?.()
        return
      }
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        addToast({ title: t('sessions.loadFailed'), description: data.error, variant: 'destructive' })
        return
      }
      addToast({ title: t('sessions.revokedCount', { count: data.revokedCount ?? 0 }), variant: 'default' })
      await load()
    } catch {
      addToast({ title: t('sessions.loadFailed'), variant: 'destructive' })
    } finally {
      setRevokingAll(false)
    }
  }

  const list = sessions ?? []
  const otherCount = list.filter((s) => !s.current).length
  const showRevokeAll = scope === 'mine' && otherCount > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[calc(100vh-2rem)] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-brand-strong" />
            {t('sessions.title')}
          </DialogTitle>
          <DialogDescription>{t('sessions.desc')}</DialogDescription>
        </DialogHeader>

        {/* Toolbar: scope switcher (admin) + count + refresh */}
        <div className="px-6 pb-3 flex items-center gap-2 flex-wrap shrink-0">
          {isAdmin && (
            <Tabs value={scope} onValueChange={(v) => setScope(v as 'mine' | 'all')}>
              <TabsList className="h-7 p-0.5">
                <TabsTrigger value="mine" className="h-6 px-2.5 text-xs">{t('sessions.myScope')}</TabsTrigger>
                <TabsTrigger value="all" className="h-6 px-2.5 text-xs">{t('sessions.allScope')}</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          {sessions && (
            <Badge variant="secondary" className="text-[10px] font-medium">
              {t('sessions.count', { count: list.length })}
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void load()}
              disabled={loading}
              title={t('sessions.refresh')}
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              <span className="sr-only">{t('sessions.refresh')}</span>
            </Button>
            {showRevokeAll && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs text-red-600 dark:text-red-400 border-red-200 dark:border-red-900/60 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-700 dark:hover:text-red-300" disabled={revokingAll}>
                    {revokingAll ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Ban className="h-3.5 w-3.5 mr-1" />}
                    {t('sessions.revokeAll')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('sessions.revokeAllTitle')}</AlertDialogTitle>
                    <AlertDialogDescription>{t('sessions.revokeAllDesc')}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-red-600 hover:bg-red-700 text-white"
                      onClick={() => { void handleRevokeAll() }}
                    >
                      {t('sessions.revokeAllConfirm')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>

        {scope === 'all' && (
          <p className="px-6 pb-2 text-[11px] text-muted-foreground shrink-0">{t('sessions.adminHint')}</p>
        )}

        {/* Session list */}
        <div className="px-4 pb-5 overflow-y-auto flex-1 min-h-0 max-h-[420px] [scrollbar-width:thin]">
          {loadError && (
            <div className="py-10 flex flex-col items-center gap-3 text-center">
              <AlertCircle className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">{t('sessions.loadFailed')}</p>
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => void load()}>
                {t('sessions.retry')}
              </Button>
            </div>
          )}
          {!loadError && loading && sessions === null && (
            <div className="space-y-2.5 pt-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 rounded-lg border border-border/60 p-3">
                  <Skeleton className="h-9 w-9 rounded-lg" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-56" />
                  </div>
                  <Skeleton className="h-7 w-16 rounded-md" />
                </div>
              ))}
            </div>
          )}
          {!loadError && !loading && sessions !== null && list.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {t(scope === 'all' ? 'sessions.emptyAll' : 'sessions.empty')}
            </div>
          )}
          {!loadError && sessions !== null && list.length > 0 && (
            <div className="space-y-2.5 pt-1">
              {list.map((s) => {
                const DeviceIcon = DEVICE_ICONS[s.deviceType] ?? Laptop
                const deviceLabel = t(`sessions.device.${s.deviceType === 'unknown' ? 'unknown' : s.deviceType}` as Parameters<I18nContextValue['t']>[0])
                return (
                  <div
                    key={s.id}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border p-3 transition-colors',
                      s.current
                        ? 'border-brand/40 bg-brand-soft/50'
                        : 'border-border/60 hover:border-border',
                    )}
                  >
                    <div className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
                      s.current
                        ? 'border-brand/30 bg-background text-brand-strong'
                        : 'border-border/60 bg-muted/40 text-muted-foreground',
                    )}>
                      <DeviceIcon className="h-4.5 w-4.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium truncate">
                          {s.browser} · {s.os}
                        </p>
                        {s.current && (
                          <Badge className="bg-brand-soft text-brand-strong border border-brand/30 text-[10px] px-1.5 py-0">
                            {t('sessions.current')}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {scope === 'all' && (
                          <span className="font-medium text-foreground/80">{s.userName} ({s.userEmail}) · </span>
                        )}
                        {deviceLabel}
                        {s.ip && <> · {t('sessions.ip')} {s.ip}</>}
                      </p>
                      <p className="text-[11px] text-muted-foreground/80 mt-1 flex items-center gap-1.5 flex-wrap">
                        <span title={t('sessions.currentHint')}>{t('sessions.lastActive')} {timeAgo(s.lastSeenAt, t)}</span>
                        <span aria-hidden>·</span>
                        <span>{t('sessions.created')} {fmtDate(s.createdAt)}</span>
                        <span aria-hidden>·</span>
                        <span title={fmtDate(s.expiresAt)}>{s.remember ? t('sessions.remembered') : t('sessions.standard')}</span>
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={s.current || revokingId === s.id}
                      onClick={() => void handleRevoke(s)}
                      title={s.current ? t('sessions.currentHint') : t('sessions.revoke')}
                      className="h-7 px-2.5 text-xs text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-40 shrink-0"
                    >
                      {revokingId === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogOut className="h-3.5 w-3.5" />}
                      <span className="ml-1 hidden sm:inline">{t('sessions.revoke')}</span>
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

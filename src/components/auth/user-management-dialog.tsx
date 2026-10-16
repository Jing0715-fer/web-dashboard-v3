'use client'

import * as React from 'react'
import {
  Users, Loader2, Trash2, CheckCircle2, XCircle, Clock, Copy,
  AlertCircle, LogOut, WifiOff, Globe, KeyRound, Network,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { AppDialog, AppDialogHeader, AppDialogBody, AppAlertDialog, AppDialogFooter, AppDialogSection, AppDialogDivider } from '@/components/app-dialog'
import { AlertDialogAction, AlertDialogCancel } from '@/components/ui/alert-dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { addToast } from '@/hooks/use-toast'
import { useT, type I18nContextValue } from '@/lib/i18n'
import { useAuth } from './auth-provider'
import type { GoogleStatus, PublicUser, UserRole } from './auth-types'

type UserFilter = 'pending' | 'approved' | 'rejected' | 'all'
type AdminAction = 'approve' | 'reject' | 'setRole' | 'reactivate'

export interface UserManagementDialogProps {
  open: boolean
  onClose: () => void
  /** Notifies the header avatar badge whenever the pending count changes. */
  onPendingChange: (count: number) => void
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function timeAgo(dateStr: string | null, t?: I18nContextValue['t']): string {
  if (!dateStr) return t ? t('dlg.common.never') : 'never'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t ? t('time.now') : 'just now'
  if (mins < 60) return t ? t('time.minutesAgo', { count: mins }) : `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t ? t('time.hoursAgo', { count: hours }) : `${hours}h ago`
  const days = Math.floor(hours / 24)
  return t ? t('time.daysAgo', { count: days }) : `${days}d ago`
}

function UserAvatar({ user, className = 'h-9 w-9 text-xs' }: { user: PublicUser; className?: string }) {
  if (user.avatarUrl) {
    return <img src={user.avatarUrl} alt="" className={`rounded-full ring-1 ring-border object-cover ${className}`} />
  }
  return (
    <div className={`flex items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/80 font-semibold text-primary-foreground ring-1 ring-primary/30 ring-inset ${className}`}>
      {initials(user.name)}
    </div>
  )
}

function StatusBadge({ status }: { status: PublicUser['status'] }) {
  const t = useT()
  if (status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-200/80 bg-amber-50/80 dark:border-amber-900/60 dark:bg-amber-950/40 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
        <Clock className="h-3 w-3" />{t('dlg.userMgmt.filter.pending')}
      </span>
    )
  }
  if (status === 'approved') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200/80 bg-emerald-50/80 dark:border-emerald-900/60 dark:bg-emerald-950/40 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />{t('dlg.userMgmt.filter.approved')}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-rose-200/80 bg-rose-50/80 dark:border-rose-900/60 dark:bg-rose-950/40 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:text-rose-400">
      <XCircle className="h-3 w-3" />{t('dlg.userMgmt.filter.rejected')}
    </span>
  )
}

function ProviderBadge({ provider }: { provider: PublicUser['provider'] }) {
  const t = useT()
  return (
    <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {provider === 'google' ? t('dlg.userMgmt.provider.google') : t('dlg.userMgmt.provider.email')}
    </span>
  )
}

// ======================== MAIN DIALOG ========================

export function UserManagementDialog({ open, onClose, onPendingChange }: UserManagementDialogProps) {
  const { user: currentUser } = useAuth()
  const t = useT()
  const [tab, setTab] = React.useState<'users' | 'google' | 'network'>('users')

  // Users tab state
  const [users, setUsers] = React.useState<PublicUser[] | null>(null)
  const [filter, setFilter] = React.useState<UserFilter>('pending')
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [rejectTarget, setRejectTarget] = React.useState<PublicUser | null>(null)
  const [rejectReason, setRejectReason] = React.useState('')
  const [rejectBusy, setRejectBusy] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<PublicUser | null>(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)

  // Google tab state
  const [googleStatus, setGoogleStatus] = React.useState<GoogleStatus | null>(null)
  const [clientId, setClientId] = React.useState('')
  const [clientSecret, setClientSecret] = React.useState('')
  const [savingGoogle, setSavingGoogle] = React.useState(false)
  const [googleError, setGoogleError] = React.useState<string | null>(null)
  const [removeConfirm, setRemoveConfirm] = React.useState(false)
  const [removeBusy, setRemoveBusy] = React.useState(false)

  // Git network tab state (v1.27): admin-owned proxy for every network git
  // call (fetch / ls-remote / update checks) — the fix for links where
  // github.com:443 resets or stalls.
  const [gitProxy, setGitProxy] = React.useState('')
  const [gitProxyConfigured, setGitProxyConfigured] = React.useState(false)
  const [gitProxyMasked, setGitProxyMasked] = React.useState<string | null>(null)
  const [gitProxySource, setGitProxySource] = React.useState<'setting' | 'env' | null>(null)
  const [savingProxy, setSavingProxy] = React.useState(false)
  const [proxyError, setProxyError] = React.useState<string | null>(null)
  const [proxySavedAt, setProxySavedAt] = React.useState(0)

  const fetchUsers = React.useCallback(async () => {
    try {
      const res = await fetch('/api/admin/users', { cache: 'no-store' })
      if (!res.ok) throw new Error(`users ${res.status}`)
      const data = await res.json()
      // Response: { users: AdminUser[], pendingCount } (AdminUser ⊇ PublicUser).
      const list: PublicUser[] = Array.isArray(data) ? data : (Array.isArray(data?.users) ? data.users : [])
      setUsers(list)
      onPendingChange(typeof data?.pendingCount === 'number' ? data.pendingCount : list.filter((u) => u.status === 'pending').length)
    } catch {
      setUsers([])
    }
  }, [onPendingChange])

  /** Loads Google OAuth status + the admin settings (masked client id). */
  const refreshGoogle = React.useCallback(async () => {
    const [statusRes, settingsRes] = await Promise.all([
      fetch('/api/auth/google/status', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/admin/settings', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    // /api/auth/google/status → { configured, redirectUri, clientIdMasked }
    const fromStatus = statusRes ?? {}
    // /api/admin/settings → { google: {…}, git: { proxyConfigured, proxyMasked, proxySource } }
    const fromSettings = (settingsRes && settingsRes.google) ? settingsRes.google : {}
    setGoogleStatus({
      configured: !!(fromSettings.configured ?? fromStatus.configured),
      redirectUri: fromSettings.redirectUri || fromStatus.redirectUri || '',
      clientIdMasked: fromSettings.clientIdMasked ?? fromStatus.clientIdMasked ?? null,
    })
    const git = settingsRes?.git
    setGitProxyConfigured(!!git?.proxyConfigured)
    setGitProxyMasked(git?.proxyMasked ?? null)
    setGitProxySource(git?.proxySource ?? null)
  }, [])

  React.useEffect(() => {
    if (!open) return
    setTab('users')
    setUsers(null)
    setRejectTarget(null)
    setDeleteTarget(null)
    setRejectReason('')
    setGoogleError(null)
    setClientId('')
    setClientSecret('')
    setProxyError(null)
    setProxySavedAt(0)
    void fetchUsers()
    void refreshGoogle()
  }, [open, fetchUsers, refreshGoogle])

  /** v1.27: persist the git proxy (or clear it when the input is empty). */
  const handleSaveProxy = async () => {
    setSavingProxy(true)
    setProxyError(null)
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gitProxy: gitProxy.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setProxyError(String(data?.error || `HTTP ${res.status}`))
        return
      }
      setGitProxy('')
      setProxySavedAt(Date.now())
      addToast({
        title: t('dlg.userMgmt.gitProxySaved'),
        description: data?.git?.proxyConfigured ? t('dlg.userMgmt.gitProxySavedDesc') : t('dlg.userMgmt.gitProxyClearedDesc'),
        variant: 'success',
      })
      await refreshGoogle()
    } catch {
      setProxyError(t('dlg.userMgmt.gitProxyNetError'))
    } finally {
      setSavingProxy(false)
    }
  }

  // ---------- user mutations ----------

  const mutateUser = async (target: PublicUser, action: AdminAction, extra?: { reason?: string; role?: UserRole }): Promise<boolean> => {
    setBusyId(target.id)
    try {
      // PATCH /api/admin/users/[id] body { action, reason?, role? } → { user }
      const res = await fetch(`/api/admin/users/${encodeURIComponent(target.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        addToast({ title: t('dlg.userMgmt.opFailed'), description: data.error || t('dlg.userMgmt.couldNot', { action: t(`dlg.userMgmt.act.${action}` as Parameters<typeof t>[0]), name: target.name }), variant: 'destructive' })
        return false
      }
      return true
    } catch {
      addToast({ title: t('dlg.userMgmt.networkError'), description: t('dlg.userMgmt.couldNotReach'), variant: 'destructive' })
      return false
    } finally {
      setBusyId(null)
    }
  }

  const handleApprove = async (target: PublicUser) => {
    if (await mutateUser(target, 'approve')) {
      addToast({ title: t('dlg.userMgmt.approvedToast'), description: t('dlg.userMgmt.approvedDesc', { name: target.name }), variant: 'success' })
      await fetchUsers()
    }
  }

  const handleRejectConfirm = async () => {
    if (!rejectTarget || rejectBusy) return
    setRejectBusy(true)
    const ok = await mutateUser(rejectTarget, 'reject', { reason: rejectReason.trim().slice(0, 200) || undefined })
    setRejectBusy(false)
    if (ok) {
      addToast({ title: t('dlg.userMgmt.rejectedToast'), description: t('dlg.userMgmt.rejectedDesc', { name: rejectTarget.name }), variant: 'default' })
      setRejectTarget(null)
      setRejectReason('')
      await fetchUsers()
    }
  }

  const handleReactivate = async (target: PublicUser) => {
    if (await mutateUser(target, 'reactivate')) {
      addToast({ title: t('dlg.userMgmt.reactivatedToast'), description: t('dlg.userMgmt.reactivatedDesc', { name: target.name }), variant: 'success' })
      await fetchUsers()
    }
  }

  const handleRoleChange = async (target: PublicUser, role: UserRole) => {
    if (target.role === role) return
    if (await mutateUser(target, 'setRole', { role })) {
      addToast({ title: t('dlg.userMgmt.roleUpdated'), description: t(role === 'admin' ? 'dlg.userMgmt.roleAdminDesc' : 'dlg.userMgmt.roleUserDesc', { name: target.name }), variant: 'success' })
      await fetchUsers()
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget || deleteBusy) return
    setDeleteBusy(true)
    setBusyId(deleteTarget.id)
    let ok = false
    try {
      // DELETE /api/admin/users/[id] → { ok: true }
      const res = await fetch(`/api/admin/users/${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE' })
      if (res.ok) {
        ok = true
        addToast({ title: t('dlg.userMgmt.userDeleted'), description: t('dlg.userMgmt.userDeletedDesc', { name: deleteTarget.name }), variant: 'success' })
      } else {
        const data = await res.json().catch(() => ({}))
        addToast({ title: t('dlg.userMgmt.deleteFailed'), description: data.error || t('dlg.userMgmt.deleteFailedDesc'), variant: 'destructive' })
      }
    } catch {
      addToast({ title: t('dlg.userMgmt.networkError'), description: t('dlg.userMgmt.couldNotReach'), variant: 'destructive' })
    } finally {
      setDeleteBusy(false)
      setBusyId(null)
    }
    if (ok) {
      setDeleteTarget(null)
      await fetchUsers()
    }
  }

  // ---------- google settings mutations ----------

  const handleSaveGoogle = async () => {
    const configured = !!googleStatus?.configured
    const payload: Record<string, string> = {}
    if (clientId.trim()) payload.googleClientId = clientId.trim()
    else if (!configured) { setGoogleError(t('dlg.userMgmt.clientIdRequired')); return }
    if (clientSecret.trim()) payload.googleClientSecret = clientSecret.trim()
    else if (!configured) { setGoogleError(t('dlg.userMgmt.secretRequired')); return }
    if (Object.keys(payload).length === 0) { setGoogleError(t('dlg.userMgmt.nothingToSave')); return }
    setSavingGoogle(true)
    setGoogleError(null)
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        addToast({ title: t('dlg.userMgmt.googleSaved'), variant: 'success' })
        setClientId('')
        setClientSecret('')
        await refreshGoogle()
      } else {
        const data = await res.json().catch(() => ({}))
        setGoogleError(data.error || t('dlg.userMgmt.saveFailed'))
      }
    } catch {
      setGoogleError(t('dlg.userMgmt.netErrLong'))
    } finally {
      setSavingGoogle(false)
    }
  }

  const handleRemoveGoogle = async () => {
    if (removeBusy) return
    setRemoveBusy(true)
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ googleClientId: '', googleClientSecret: '' }),
      })
      if (res.ok) {
        addToast({ title: t('dlg.userMgmt.googleDisabled'), description: t('dlg.userMgmt.googleDisabledDesc'), variant: 'default' })
        setRemoveConfirm(false)
        setClientId('')
        setClientSecret('')
        await refreshGoogle()
      } else {
        const data = await res.json().catch(() => ({}))
        addToast({ title: t('dlg.userMgmt.removeFailed'), description: data.error || t('dlg.userMgmt.tryAgain'), variant: 'destructive' })
      }
    } catch {
      addToast({ title: t('dlg.userMgmt.networkError'), description: t('dlg.userMgmt.couldNotReach'), variant: 'destructive' })
    } finally {
      setRemoveBusy(false)
    }
  }

  const copyToClipboard = (text: string) => {
    if (!text) return
    navigator.clipboard.writeText(text)
    addToast({ title: t('dlg.userMgmt.copied'), description: text, variant: 'success' })
  }

  // ---------- derived ----------

  const filtered = React.useMemo(() => {
    if (!users) return []
    return filter === 'all' ? users : users.filter((u) => u.status === filter)
  }, [users, filter])

  const counts = React.useMemo(() => ({
    pending: users?.filter((u) => u.status === 'pending').length ?? 0,
    approved: users?.filter((u) => u.status === 'approved').length ?? 0,
    rejected: users?.filter((u) => u.status === 'rejected').length ?? 0,
    all: users?.length ?? 0,
  }), [users])

  const configured = !!googleStatus?.configured
  const maskedClient = googleStatus?.clientIdMasked ?? null
  const redirectUri = googleStatus?.redirectUri || ''

  const filterChips: Array<{ id: UserFilter; label: string; count: number }> = [
    { id: 'pending', label: t('dlg.userMgmt.filter.pending'), count: counts.pending },
    { id: 'approved', label: t('dlg.userMgmt.filter.approved'), count: counts.approved },
    { id: 'rejected', label: t('dlg.userMgmt.filter.rejected'), count: counts.rejected },
    { id: 'all', label: t('dlg.userMgmt.filter.all'), count: counts.all },
  ]

  return (
    <AppDialog open={open} onOpenChange={(v) => !v && onClose()} size="3xl">
      <AppDialogHeader icon={Users} iconTone="sky" title={t('dlg.userMgmt.title')} description={t('dlg.userMgmt.desc')} />

      <AppDialogBody>
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'users' | 'google' | 'network')}>
          <TabsList className="h-9 w-full justify-start bg-transparent p-0 gap-1.5 mb-5 border-b border-border/60 pb-3">
            <TabsTrigger value="users" className="px-3.5 py-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-emerald-500/[0.12] data-[state=active]:text-emerald-700 dark:data-[state=active]:text-emerald-300 rounded-full transition-colors">
              {t('dlg.userMgmt.users')}
              {counts.pending > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-400 text-[10px] font-bold">{counts.pending > 9 ? '9+' : counts.pending}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="google" className="px-3.5 py-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-emerald-500/[0.12] data-[state=active]:text-emerald-700 dark:data-[state=active]:text-emerald-300 rounded-full transition-colors">{t('dlg.userMgmt.google')}</TabsTrigger>
            <TabsTrigger value="network" className="px-3.5 py-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-emerald-500/[0.12] data-[state=active]:text-emerald-700 dark:data-[state=active]:text-emerald-300 rounded-full transition-colors">{t('dlg.userMgmt.gitNetwork')}</TabsTrigger>
          </TabsList>

          {/* ==================== USERS TAB ==================== */}
          {tab === 'users' && (
            <AppDialogSection icon={Users} label={t('dlg.userMgmt.sectionUsers')}>
              {/* Filter chips */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {filterChips.map((chip) => {
                  const active = filter === chip.id
                  return (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() => setFilter(chip.id)}
                      className={`inline-flex items-center gap-1.5 rounded-full border h-7 px-3 text-xs font-medium cursor-pointer transition-all ${active
                        ? 'border-transparent bg-emerald-500/[0.06] dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/40'
                        : 'border-border/70 bg-card text-muted-foreground hover:border-muted-foreground/30 hover:shadow-sm'}`}
                    >
                      {chip.label}
                      <span className={`text-[10px] tabular-nums ${active ? 'text-emerald-700/80 dark:text-emerald-300/80' : 'text-muted-foreground/70'}`}>{chip.count}</span>
                    </button>
                  )
                })}
              </div>

              {/* User list */}
              {users === null ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  {filter === 'pending'
                    ? <Clock className="size-8 text-muted-foreground/50 mb-3" />
                    : <Users className="size-8 text-muted-foreground/50 mb-3" />}
                  <p className="text-sm font-medium">
                    {filter === 'pending' ? t('dlg.userMgmt.noPending') : filter === 'approved' ? t('dlg.userMgmt.noApproved') : filter === 'rejected' ? t('dlg.userMgmt.noRejected') : t('dlg.userMgmt.noUsers')}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                    {filter === 'pending' ? t('dlg.userMgmt.allCaughtUp') : t('dlg.userMgmt.usersAppear')}
                  </p>
                </div>
              ) : (
                <ul className="space-y-2.5">
                  {filtered.map((u) => {
                    const isSelf = currentUser?.id === u.id
                    const busy = busyId === u.id
                    return (
                      <li
                        key={u.id}
                        className={`flex flex-col md:grid md:grid-cols-[minmax(0,1fr)_128px_auto_auto] md:items-center gap-2.5 md:gap-3 rounded-xl border border-border/60 bg-card p-3 transition-all hover:border-muted-foreground/30 hover:shadow-sm ${busy ? 'opacity-60' : ''}`}
                      >
                        {/* Identity */}
                        <div className="flex items-center gap-3 min-w-0">
                          <UserAvatar user={u} className="h-10 w-10 text-xs shrink-0" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <p className="text-sm font-medium truncate max-w-[180px] sm:max-w-[240px]">{u.name}</p>
                              {isSelf && (
                                <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">{t('dlg.userMgmt.you')}</span>
                              )}
                              <ProviderBadge provider={u.provider} />
                            </div>
                            <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                            <p className="text-[11px] text-muted-foreground/70 mt-0.5 flex items-center gap-1.5 flex-wrap">
                              <span>{t('dlg.userMgmt.joined', { time: timeAgo(u.createdAt, t) })}</span>
                              <span aria-hidden>·</span>
                              <span>{t('dlg.userMgmt.lastLogin', { time: timeAgo(u.lastLoginAt, t) })}</span>
                            </p>
                          </div>
                        </div>

                        {/* Role select (disabled on self) */}
                        <div className="min-w-0">
                          {isSelf ? (
                            <TooltipProvider delayDuration={200}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="block w-[112px] cursor-not-allowed">
                                    <Select value={u.role} disabled>
                                      <SelectTrigger className="h-8 text-xs w-full"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="admin">{t('dlg.userMgmt.roleAdmin')}</SelectItem>
                                        <SelectItem value="user">{t('dlg.userMgmt.roleUser')}</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>{t('dlg.userMgmt.you')}</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : (
                            <Select value={u.role} onValueChange={(v) => void handleRoleChange(u, v as UserRole)} disabled={busy}>
                              <SelectTrigger className="h-8 text-xs w-full" aria-label={t('dlg.userMgmt.role', { name: u.name })}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="admin">{t('dlg.userMgmt.roleAdmin')}</SelectItem>
                                <SelectItem value="user">{t('dlg.userMgmt.roleUser')}</SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                        </div>

                        {/* Status */}
                        <div><StatusBadge status={u.status} /></div>

                        {/* Actions */}
                        <div className="flex items-center gap-1.5 md:justify-end flex-wrap">
                          {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                          {u.status === 'pending' && (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => void handleApprove(u)}
                                disabled={busy}
                                className="h-8 px-3 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />{t('dlg.userMgmt.approve')}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => { setRejectTarget(u); setRejectReason('') }}
                                disabled={busy}
                                className="h-8 px-3 text-xs border-rose-300/70 text-rose-600 dark:border-rose-900/60 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-700 dark:hover:text-rose-300"
                              >
                                <XCircle className="h-3.5 w-3.5 mr-1" />{t('dlg.userMgmt.reject')}
                              </Button>
                            </>
                          )}
                          {u.status === 'rejected' && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => void handleReactivate(u)}
                              disabled={busy}
                              className="h-8 px-3 text-xs"
                            >
                              {t('dlg.userMgmt.reactivate')}
                            </Button>
                          )}
                          {!isSelf && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setDeleteTarget(u)}
                              disabled={busy}
                              aria-label={t('dlg.userMgmt.deleteUser', { name: u.name })}
                              className="h-8 w-8 px-0 text-rose-500 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-600 dark:hover:text-rose-300"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </AppDialogSection>
          )}

          {/* ==================== GOOGLE SIGN-IN TAB ==================== */}
          {tab === 'google' && (
            <div className="space-y-5">
              {/* Status */}
              <AppDialogSection icon={Globe} label={t('dlg.userMgmt.sectionStatus')}>
                <div className="rounded-xl border border-border/60 bg-card p-3.5 flex items-start gap-3 transition-all">
                  <span className={`mt-1.5 size-2 rounded-full shrink-0 ${configured ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium flex items-center gap-2 flex-wrap">
                      {configured ? t('dlg.userMgmt.configured') : t('dlg.userMgmt.notConfigured')}
                      {configured && maskedClient && (
                        <code className="font-mono text-xs text-muted-foreground font-normal break-all">{maskedClient}</code>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {configured
                        ? t('dlg.userMgmt.testHint')
                        : t('dlg.userMgmt.enableHint')}
                    </p>
                  </div>
                </div>
              </AppDialogSection>

              <AppDialogDivider />

              {/* Redirect URI + setup instructions */}
              <AppDialogSection icon={Copy} label={t('dlg.userMgmt.redirectUri')}>
                <div className="rounded-lg bg-zinc-950/[0.97] border border-zinc-800 p-2.5 flex items-center gap-2 custom-scrollbar">
                  <code className="flex-1 min-w-0 font-mono text-xs text-zinc-200 truncate">{redirectUri || t('dlg.userMgmt.redirectNA')}</code>
                  <Button type="button" variant="outline" size="sm" onClick={() => copyToClipboard(redirectUri)} disabled={!redirectUri} className="h-7 px-2.5 text-xs shrink-0 bg-transparent border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100">
                    <Copy className="h-3 w-3 mr-1" />{t('dlg.common.copy')}
                  </Button>
                </div>
                <ol className="space-y-1.5 text-xs text-muted-foreground list-decimal list-inside leading-relaxed pt-1">
                  <li>{t('dlg.userMgmt.instr1')}</li>
                  <li>{t('dlg.userMgmt.instr2')}</li>
                  <li>{t('dlg.userMgmt.instr3')}</li>
                  <li>{t('dlg.userMgmt.instr4')}</li>
                </ol>
              </AppDialogSection>

              <AppDialogDivider />

              {/* Credentials form */}
              <AppDialogSection icon={KeyRound} label={t('dlg.userMgmt.sectionCredentials')}>
                <div className="space-y-3.5 rounded-xl border border-border/60 bg-card p-3.5">
                  <div className="space-y-1.5">
                    <Label htmlFor="google-client-id" className="text-[13px] font-medium">{t('dlg.userMgmt.clientId')}</Label>
                    {configured && maskedClient && (
                      <p className="text-[11px] text-muted-foreground">
                        {t('dlg.userMgmt.current')} <code className="font-mono break-all">{maskedClient}</code>
                      </p>
                    )}
                    <Input
                      id="google-client-id"
                      type="text"
                      autoComplete="off"
                      placeholder="123456789-abcdefg.apps.googleusercontent.com"
                      value={clientId}
                      onChange={(e) => { setClientId(e.target.value); setGoogleError(null) }}
                      disabled={savingGoogle}
                      className="h-10 font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="google-client-secret" className="text-[13px] font-medium">{t('dlg.userMgmt.clientSecret')}</Label>
                    <Input
                      id="google-client-secret"
                      type="password"
                      autoComplete="new-password"
                      placeholder={configured ? t('dlg.userMgmt.keepSecret') : 'GOCSPX-…'}
                      value={clientSecret}
                      onChange={(e) => { setClientSecret(e.target.value); setGoogleError(null) }}
                      disabled={savingGoogle}
                      className="h-10 font-mono text-xs"
                    />
                  </div>
                  {googleError && (
                    <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-card px-3.5 py-2.5 text-sm text-destructive dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-400">
                      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                      <p className="font-medium leading-snug">{googleError}</p>
                    </div>
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button type="button" onClick={() => void handleSaveGoogle()} disabled={savingGoogle} className="h-10 px-5 text-sm bg-primary hover:bg-primary/90 text-primary-foreground">
                      {savingGoogle && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      {savingGoogle ? t('dlg.userMgmt.saving') : t('dlg.userMgmt.save')}
                    </Button>
                    {configured && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setRemoveConfirm(true)}
                        disabled={savingGoogle}
                        className="h-10 px-5 text-sm border-rose-300/70 text-rose-600 dark:border-rose-900/60 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                      >
                        <LogOut className="h-4 w-4 mr-2 rotate-180" />{t('dlg.userMgmt.removeConfig')}
                      </Button>
                    )}
                  </div>
                </div>
              </AppDialogSection>
            </div>
          )}

          {/* ==================== GIT NETWORK TAB (v1.27) ==================== */}
          {tab === 'network' && (
            <div className="space-y-5">
              {/* Status */}
              <AppDialogSection icon={gitProxyConfigured ? CheckCircle2 : WifiOff} label={t('dlg.userMgmt.sectionStatus')}>
                <div className={`flex items-start gap-3 rounded-xl border p-3.5 ${gitProxyConfigured
                  ? 'border-emerald-500/30 bg-emerald-500/[0.06] dark:bg-emerald-500/10'
                  : 'border-amber-500/30 bg-amber-500/[0.06] dark:bg-amber-500/10'}`}>
                  {gitProxyConfigured
                    ? <CheckCircle2 className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400 mt-0.5" />
                    : <WifiOff className="size-5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />}
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug">
                      {gitProxyConfigured ? t('dlg.userMgmt.gitProxyOn') : t('dlg.userMgmt.gitProxyOff')}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1 break-all">
                      {gitProxyConfigured
                        ? t('dlg.userMgmt.gitProxyCurrent', {
                            proxy: gitProxyMasked || '',
                            source: gitProxySource === 'env' ? t('dlg.userMgmt.gitProxySourceEnv') : t('dlg.userMgmt.gitProxySourceSetting'),
                          })
                        : t('dlg.userMgmt.gitProxyOffDesc')}
                    </p>
                  </div>
                </div>
              </AppDialogSection>

              <AppDialogDivider />

              {/* Proxy form + scope */}
              <AppDialogSection icon={Network} label={t('dlg.userMgmt.sectionProxy')}>
                <div className="space-y-3.5 rounded-xl border border-border/60 bg-card p-3.5">
                  <div className="space-y-1.5">
                    <Label htmlFor="git-proxy-url" className="text-[13px] font-medium">{t('dlg.userMgmt.gitProxyUrl')}</Label>
                    <Input
                      id="git-proxy-url"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="http://127.0.0.1:7890"
                      value={gitProxy}
                      onChange={(e) => { setGitProxy(e.target.value); setProxyError(null); setProxySavedAt(0) }}
                      disabled={savingProxy}
                      className="h-10 font-mono text-xs"
                    />
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{t('dlg.userMgmt.gitProxyHint')}</p>
                  </div>
                  {proxyError && (
                    <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-card px-3.5 py-2.5 text-sm text-destructive dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-400">
                      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                      <p className="font-medium leading-snug">{proxyError}</p>
                    </div>
                  )}
                  {proxySavedAt > 0 && !proxyError && (
                    <p className="text-xs text-emerald-600 dark:text-emerald-400">{t('dlg.userMgmt.gitProxySavedDesc')}</p>
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      type="button"
                      onClick={() => void handleSaveProxy()}
                      disabled={savingProxy || gitProxy.trim() === ''}
                      className="h-10 px-5 text-sm"
                    >
                      {savingProxy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      {t('dlg.userMgmt.save')}
                    </Button>
                    {gitProxyConfigured && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => { setGitProxy(''); void handleSaveProxy() }}
                        disabled={savingProxy}
                        className="h-10 px-5 text-sm border-rose-300/70 text-rose-600 dark:border-rose-900/60 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                      >
                        <LogOut className="h-4 w-4 mr-2 rotate-180" />{t('dlg.userMgmt.gitProxyRemove')}
                      </Button>
                    )}
                  </div>
                  {gitProxy.trim() === '' && gitProxyConfigured && !savingProxy && (
                    <p className="text-[11px] text-muted-foreground">{t('dlg.userMgmt.gitProxyClearHint')}</p>
                  )}
                </div>

                {/* What this affects */}
                <div className="rounded-xl border border-border/60 bg-muted/30 p-3.5">
                  <p className="text-xs font-medium mb-1.5">{t('dlg.userMgmt.gitProxyAffects')}</p>
                  <ul className="space-y-1 text-xs text-muted-foreground leading-relaxed">
                    <li>· {t('dlg.userMgmt.gitProxyAffect1')}</li>
                    <li>· {t('dlg.userMgmt.gitProxyAffect2')}</li>
                    <li>· {t('dlg.userMgmt.gitProxyAffect3')}</li>
                  </ul>
                </div>
              </AppDialogSection>
            </div>
          )}
        </Tabs>
      </AppDialogBody>

      {/* ---------- Reject reason dialog ---------- */}
      <AppDialog open={!!rejectTarget} onOpenChange={(v) => { if (!v) { setRejectTarget(null); setRejectReason('') } }} size="md">
        <AppDialogHeader icon={XCircle} iconTone="rose" title={t('dlg.userMgmt.rejectTitle')} description={rejectTarget ? t('dlg.userMgmt.rejectDesc', { name: rejectTarget.name, email: rejectTarget.email }) : ''} />
        <AppDialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="reject-reason" className="text-[13px] font-medium">{t('dlg.userMgmt.reason')}</Label>
            <Textarea
              id="reject-reason"
              placeholder={t('dlg.userMgmt.reasonPlaceholder')}
              value={rejectReason}
              maxLength={200}
              onChange={(e) => setRejectReason(e.target.value)}
              disabled={rejectBusy}
              className="min-h-[88px] text-sm"
            />
            <p className="text-[11px] text-muted-foreground text-right tabular-nums">{rejectReason.length}/200</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => { setRejectTarget(null); setRejectReason('') }} disabled={rejectBusy} className="h-10">{t('dlg.common.cancel')}</Button>
            <Button type="button" onClick={() => void handleRejectConfirm()} disabled={rejectBusy} className="h-10 bg-rose-600 hover:bg-rose-700 text-white">
              {rejectBusy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('dlg.userMgmt.reject')}
            </Button>
          </div>
        </AppDialogBody>
      </AppDialog>

      {/* ---------- Delete confirm ---------- */}
      <AppAlertDialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null) }} size="lg">
        <AppDialogHeader
          icon={Trash2}
          iconTone="rose"
          title={t('dlg.userMgmt.deleteTitle')}
          description={deleteTarget
            ? t('dlg.userMgmt.deleteDesc', { name: deleteTarget.name, email: deleteTarget.email })
            : ''}
        />
        <AppDialogFooter>
          <AlertDialogCancel disabled={deleteBusy}>{t('dlg.common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); void handleDeleteConfirm() }}
            disabled={deleteBusy}
            className="bg-rose-600 hover:bg-rose-700 text-white focus:ring-rose-600"
          >
            {deleteBusy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t('dlg.common.delete')}
          </AlertDialogAction>
        </AppDialogFooter>
      </AppAlertDialog>

      {/* ---------- Remove Google configuration confirm ---------- */}
      <AppAlertDialog open={removeConfirm} onOpenChange={setRemoveConfirm} size="lg">
        <AppDialogHeader icon={LogOut} iconTone="rose" title={t('dlg.userMgmt.removeGoogleTitle')} description={t('dlg.userMgmt.removeGoogleDesc')} />
        <AppDialogFooter>
          <AlertDialogCancel disabled={removeBusy}>{t('dlg.common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); void handleRemoveGoogle() }}
            disabled={removeBusy}
            className="bg-rose-600 hover:bg-rose-700 text-white focus:ring-rose-600"
          >
            {removeBusy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t('dlg.userMgmt.remove')}
          </AlertDialogAction>
        </AppDialogFooter>
      </AppAlertDialog>
    </AppDialog>
  )
}

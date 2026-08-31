'use client'

import * as React from 'react'
import {
  Users, Loader2, Trash2, CheckCircle2, XCircle, Clock, Copy,
  AlertCircle, LogOut,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { addToast } from '@/hooks/use-toast'
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

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'never'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
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
  if (status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-200/80 bg-amber-50/80 dark:border-amber-900/60 dark:bg-amber-950/40 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
        <Clock className="h-3 w-3" />Pending
      </span>
    )
  }
  if (status === 'approved') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200/80 bg-emerald-50/80 dark:border-emerald-900/60 dark:bg-emerald-950/40 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />Approved
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-red-200/80 bg-red-50/80 dark:border-red-900/60 dark:bg-red-950/40 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-400">
      <XCircle className="h-3 w-3" />Rejected
    </span>
  )
}

function ProviderBadge({ provider }: { provider: PublicUser['provider'] }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {provider === 'google' ? 'Google' : 'Email'}
    </span>
  )
}

// ======================== MAIN DIALOG ========================

export function UserManagementDialog({ open, onClose, onPendingChange }: UserManagementDialogProps) {
  const { user: currentUser } = useAuth()
  const [tab, setTab] = React.useState<'users' | 'google'>('users')

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
    // /api/admin/settings → { google: { configured, clientIdMasked, redirectUri } }
    const fromSettings = (settingsRes && settingsRes.google) ? settingsRes.google : {}
    setGoogleStatus({
      configured: !!(fromSettings.configured ?? fromStatus.configured),
      redirectUri: fromSettings.redirectUri || fromStatus.redirectUri || '',
      clientIdMasked: fromSettings.clientIdMasked ?? fromStatus.clientIdMasked ?? null,
    })
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
    void fetchUsers()
    void refreshGoogle()
  }, [open, fetchUsers, refreshGoogle])

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
        const labels: Record<AdminAction, string> = { approve: 'approve', reject: 'reject', setRole: 'update the role of', reactivate: 'reactivate' }
        addToast({ title: 'Operation failed', description: data.error || `Could not ${labels[action]} ${target.name}.`, variant: 'destructive' })
        return false
      }
      return true
    } catch {
      addToast({ title: 'Network error', description: 'Could not reach the server.', variant: 'destructive' })
      return false
    } finally {
      setBusyId(null)
    }
  }

  const handleApprove = async (target: PublicUser) => {
    if (await mutateUser(target, 'approve')) {
      addToast({ title: 'Approved', description: `${target.name} can now sign in.`, variant: 'success' })
      await fetchUsers()
    }
  }

  const handleRejectConfirm = async () => {
    if (!rejectTarget || rejectBusy) return
    setRejectBusy(true)
    const ok = await mutateUser(rejectTarget, 'reject', { reason: rejectReason.trim().slice(0, 200) || undefined })
    setRejectBusy(false)
    if (ok) {
      addToast({ title: 'Rejected', description: `${rejectTarget.name} will be informed on next sign-in.`, variant: 'default' })
      setRejectTarget(null)
      setRejectReason('')
      await fetchUsers()
    }
  }

  const handleReactivate = async (target: PublicUser) => {
    if (await mutateUser(target, 'reactivate')) {
      addToast({ title: 'Reactivated', description: `${target.name} is pending approval again.`, variant: 'success' })
      await fetchUsers()
    }
  }

  const handleRoleChange = async (target: PublicUser, role: UserRole) => {
    if (target.role === role) return
    if (await mutateUser(target, 'setRole', { role })) {
      addToast({ title: 'Role updated', description: `${target.name} is now ${role === 'admin' ? 'an administrator' : 'a standard user'}.`, variant: 'success' })
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
        addToast({ title: 'User deleted', description: `${deleteTarget.name} has been removed.`, variant: 'success' })
      } else {
        const data = await res.json().catch(() => ({}))
        addToast({ title: 'Delete failed', description: data.error || 'Could not delete the user.', variant: 'destructive' })
      }
    } catch {
      addToast({ title: 'Network error', description: 'Could not reach the server.', variant: 'destructive' })
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
    else if (!configured) { setGoogleError('Client ID is required.'); return }
    if (clientSecret.trim()) payload.googleClientSecret = clientSecret.trim()
    else if (!configured) { setGoogleError('Client secret is required.'); return }
    if (Object.keys(payload).length === 0) { setGoogleError('Nothing to save — enter a new Client ID or secret.'); return }
    setSavingGoogle(true)
    setGoogleError(null)
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        addToast({ title: 'Google sign-in settings saved', variant: 'success' })
        setClientId('')
        setClientSecret('')
        await refreshGoogle()
      } else {
        const data = await res.json().catch(() => ({}))
        setGoogleError(data.error || 'Failed to save settings.')
      }
    } catch {
      setGoogleError('Network error — could not reach the server.')
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
        addToast({ title: 'Google sign-in disabled', description: 'The Google button on the sign-in page is now disabled.', variant: 'default' })
        setRemoveConfirm(false)
        setClientId('')
        setClientSecret('')
        await refreshGoogle()
      } else {
        const data = await res.json().catch(() => ({}))
        addToast({ title: 'Failed to remove configuration', description: data.error || 'Please try again.', variant: 'destructive' })
      }
    } catch {
      addToast({ title: 'Network error', description: 'Could not reach the server.', variant: 'destructive' })
    } finally {
      setRemoveBusy(false)
    }
  }

  const copyToClipboard = (text: string) => {
    if (!text) return
    navigator.clipboard.writeText(text)
    addToast({ title: 'Copied', description: text, variant: 'success' })
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
    { id: 'pending', label: 'Pending', count: counts.pending },
    { id: 'approved', label: 'Approved', count: counts.approved },
    { id: 'rejected', label: 'Rejected', count: counts.rejected },
    { id: 'all', label: 'All', count: counts.all },
  ]

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto custom-scrollbar p-5 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-brand-strong" />
            User Management
          </DialogTitle>
          <DialogDescription>Approve registrations, manage roles and configure Google sign-in.</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'users' | 'google')}>
          <TabsList className="h-9 w-full justify-start bg-transparent p-0 gap-2 mb-4">
            <TabsTrigger value="users" className="px-3.5 py-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-brand-soft data-[state=active]:text-brand-strong dark:data-[state=active]:bg-brand-soft dark:data-[state=active]:text-brand-strong rounded-full transition-colors">
              Users
              {counts.pending > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-400 text-[10px] font-bold">{counts.pending > 9 ? '9+' : counts.pending}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="google" className="px-3.5 py-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-brand-soft data-[state=active]:text-brand-strong dark:data-[state=active]:bg-brand-soft dark:data-[state=active]:text-brand-strong rounded-full transition-colors">Google Sign-in</TabsTrigger>
          </TabsList>

          {/* ==================== USERS TAB ==================== */}
          {tab === 'users' && (
            <div className="space-y-3">
              {/* Filter chips */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {filterChips.map((chip) => {
                  const active = filter === chip.id
                  return (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() => setFilter(chip.id)}
                      className={`inline-flex items-center gap-1.5 rounded-md border h-7 px-2.5 text-xs font-medium cursor-pointer transition-colors ${active
                        ? 'border-brand/50 bg-brand-soft text-brand-strong'
                        : 'border-zinc-200 dark:border-zinc-700 bg-card shadow-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60'}`}
                    >
                      {chip.label}
                      <span className={`text-[10px] tabular-nums ${active ? 'text-brand-strong/80' : 'text-muted-foreground/70'}`}>{chip.count}</span>
                    </button>
                  )
                })}
              </div>

              {/* User list */}
              {users === null ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-brand" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/50 mb-3">
                    {filter === 'pending' ? <Clock className="h-6 w-6 text-muted-foreground" /> : <Users className="h-6 w-6 text-muted-foreground" />}
                  </div>
                  <p className="text-sm font-medium">
                    {filter === 'pending' ? 'No pending registrations' : filter === 'approved' ? 'No approved users yet' : filter === 'rejected' ? 'No rejected users' : 'No users yet'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {filter === 'pending' ? 'All caught up — new registrations will appear here.' : 'Users will appear here as they register.'}
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {filtered.map((u) => {
                    const isSelf = currentUser?.id === u.id
                    const busy = busyId === u.id
                    return (
                      <li
                        key={u.id}
                        className={`rounded-lg border border-border/60 bg-card p-3 flex flex-col md:grid md:grid-cols-[minmax(0,1fr)_118px_102px_minmax(0,132px)_auto] md:items-center gap-2.5 md:gap-3 transition-opacity ${busy ? 'opacity-60' : ''}`}
                      >
                        {/* Identity */}
                        <div className="flex items-center gap-2.5 min-w-0">
                          <UserAvatar user={u} className="h-9 w-9 text-xs shrink-0" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <p className="text-sm font-medium truncate max-w-[160px] sm:max-w-[220px]">{u.name}</p>
                              {isSelf && (
                                <span className="inline-flex items-center rounded-full border border-brand/40 bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand-strong">You</span>
                              )}
                              <ProviderBadge provider={u.provider} />
                            </div>
                            <p className="text-xs text-muted-foreground truncate">{u.email}</p>
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
                                        <SelectItem value="admin">Admin</SelectItem>
                                        <SelectItem value="user">User</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>You</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : (
                            <Select value={u.role} onValueChange={(v) => void handleRoleChange(u, v as UserRole)} disabled={busy}>
                              <SelectTrigger className="h-8 text-xs w-full" aria-label={`Role for ${u.name}`}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="admin">Admin</SelectItem>
                                <SelectItem value="user">User</SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                        </div>

                        {/* Status */}
                        <div><StatusBadge status={u.status} /></div>

                        {/* Dates */}
                        <div className="text-[11px] text-muted-foreground leading-relaxed">
                          <p>Joined {timeAgo(u.createdAt)}</p>
                          <p>Last login {timeAgo(u.lastLoginAt)}</p>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1.5 md:justify-end flex-wrap">
                          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                          {u.status === 'pending' && (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => void handleApprove(u)}
                                disabled={busy}
                                className="h-8 px-3 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />Approve
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => { setRejectTarget(u); setRejectReason('') }}
                                disabled={busy}
                                className="h-8 px-3 text-xs border-red-300/70 text-red-600 dark:border-red-900/60 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-700 dark:hover:text-red-300"
                              >
                                <XCircle className="h-3.5 w-3.5 mr-1" />Reject
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
                              Reactivate
                            </Button>
                          )}
                          {!isSelf && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setDeleteTarget(u)}
                              disabled={busy}
                              aria-label={`Delete ${u.name}`}
                              className="h-8 w-8 px-0 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600 dark:hover:text-red-300"
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
            </div>
          )}

          {/* ==================== GOOGLE SIGN-IN TAB ==================== */}
          {tab === 'google' && (
            <div className="space-y-4">
              {/* Status card */}
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3.5 flex items-start gap-3">
                <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${configured ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium flex items-center gap-2 flex-wrap">
                    {configured ? 'Configured' : 'Not configured'}
                    {configured && maskedClient && (
                      <code className="font-mono text-xs text-muted-foreground font-normal break-all">{maskedClient}</code>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {configured
                      ? 'Test: open the sign-in page and use the Google button.'
                      : 'Complete the steps below to enable Google sign-in for this dashboard.'}
                  </p>
                </div>
              </div>

              {/* Redirect URI */}
              <div className="space-y-1.5">
                <Label className="text-xs">Redirect URI</Label>
                <div className="rounded-md bg-zinc-900 dark:bg-zinc-950 border border-zinc-800 dark:border-zinc-800 p-2.5 flex items-center gap-2">
                  <code className="flex-1 min-w-0 font-mono text-xs text-zinc-300 truncate">{redirectUri || '— (available once the server knows its origin)'}</code>
                  <Button type="button" variant="outline" size="sm" onClick={() => copyToClipboard(redirectUri)} disabled={!redirectUri} className="h-7 px-2.5 text-xs shrink-0 bg-transparent border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100">
                    <Copy className="h-3 w-3 mr-1" />Copy
                  </Button>
                </div>
              </div>

              {/* Instructions */}
              <ol className="space-y-1.5 text-xs text-muted-foreground list-decimal list-inside leading-relaxed">
                <li>Open Google Cloud Console → APIs &amp; Services → Credentials.</li>
                <li>"Create Credentials" → OAuth client ID → Web application.</li>
                <li>Add the redirect URI above as an Authorized redirect URI.</li>
                <li>Paste the Client ID and Client secret here and Save.</li>
              </ol>

              {/* Form */}
              <div className="space-y-3.5 rounded-lg border border-border/60 bg-card p-3.5">
                <div className="space-y-1.5">
                  <Label htmlFor="google-client-id" className="text-xs">Client ID</Label>
                  {configured && maskedClient && (
                    <p className="text-[11px] text-muted-foreground">
                      Current: <code className="font-mono break-all">{maskedClient}</code>
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
                  <Label htmlFor="google-client-secret" className="text-xs">Client Secret</Label>
                  <Input
                    id="google-client-secret"
                    type="password"
                    autoComplete="new-password"
                    placeholder={configured ? 'Leave blank to keep current secret' : 'GOCSPX-…'}
                    value={clientSecret}
                    onChange={(e) => { setClientSecret(e.target.value); setGoogleError(null) }}
                    disabled={savingGoogle}
                    className="h-10 font-mono text-xs"
                  />
                </div>
                {googleError && (
                  <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-card px-3.5 py-2.5 text-sm text-destructive dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-400">
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <p className="font-medium leading-snug">{googleError}</p>
                  </div>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <Button type="button" onClick={() => void handleSaveGoogle()} disabled={savingGoogle} className="h-10 px-5 text-sm bg-primary hover:bg-primary/90 text-primary-foreground">
                    {savingGoogle && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    {savingGoogle ? 'Saving…' : 'Save'}
                  </Button>
                  {configured && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setRemoveConfirm(true)}
                      disabled={savingGoogle}
                      className="h-10 px-5 text-sm border-red-300/70 text-red-600 dark:border-red-900/60 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
                    >
                      <LogOut className="h-4 w-4 mr-2 rotate-180" />Remove configuration
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </Tabs>

        {/* ---------- Reject reason dialog ---------- */}
        <Dialog open={!!rejectTarget} onOpenChange={(v) => { if (!v) { setRejectTarget(null); setRejectReason('') } }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <XCircle className="h-5 w-5 text-red-500 dark:text-red-400" />
                Reject registration
              </DialogTitle>
              <DialogDescription>
                {rejectTarget ? `Reject ${rejectTarget.name} (${rejectTarget.email}). They will see this decision on their next sign-in attempt.` : ''}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="reject-reason">Reason (optional)</Label>
              <Textarea
                id="reject-reason"
                placeholder="Optional explanation shown to the user…"
                value={rejectReason}
                maxLength={200}
                onChange={(e) => setRejectReason(e.target.value)}
                disabled={rejectBusy}
                className="min-h-[72px] text-sm"
              />
              <p className="text-[11px] text-muted-foreground text-right tabular-nums">{rejectReason.length}/200</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => { setRejectTarget(null); setRejectReason('') }} disabled={rejectBusy} className="h-10">Cancel</Button>
              <Button type="button" onClick={() => void handleRejectConfirm()} disabled={rejectBusy} className="h-10 bg-red-600 hover:bg-red-700 text-white">
                {rejectBusy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Reject
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* ---------- Delete confirm ---------- */}
        <AlertDialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete user?</AlertDialogTitle>
              <AlertDialogDescription>
                {deleteTarget
                  ? `This permanently removes ${deleteTarget.name} (${deleteTarget.email}) from the dashboard. They will be able to register again afterwards.`
                  : ''}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); void handleDeleteConfirm() }}
                disabled={deleteBusy}
                className="bg-red-600 hover:bg-red-700 text-white focus:ring-red-600"
              >
                {deleteBusy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* ---------- Remove Google configuration confirm ---------- */}
        <AlertDialog open={removeConfirm} onOpenChange={setRemoveConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove Google sign-in?</AlertDialogTitle>
              <AlertDialogDescription>
                The Google button on the sign-in page will be disabled immediately. Existing Google sessions are not affected.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={removeBusy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); void handleRemoveGoogle() }}
                disabled={removeBusy}
                className="bg-red-600 hover:bg-red-700 text-white focus:ring-red-600"
              >
                {removeBusy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}

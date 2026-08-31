'use client'

import * as React from 'react'
import { Users, KeyRound, LogOut, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { PublicUser } from './auth-types'

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export interface UserMenuProps {
  user: PublicUser
  onLogout: () => void
  onOpenUserManagement: () => void
  onOpenChangePassword: () => void
  /** Number of pending registrations (admins see a badge). */
  pendingCount?: number
}

export function UserMenu({ user, onLogout, onOpenUserManagement, onOpenChangePassword, pendingCount = 0 }: UserMenuProps) {
  const [signingOut, setSigningOut] = React.useState(false)
  const isAdmin = user.role === 'admin'
  const showPendingBadge = isAdmin && pendingCount > 0

  const handleSignOut = async () => {
    if (signingOut) return
    setSigningOut(true)
    await onLogout()
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="relative rounded-full h-8 w-8 cursor-pointer transition hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 shrink-0"
        >
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full ring-1 ring-border object-cover" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/80 text-[10px] font-semibold text-primary-foreground ring-1 ring-primary/30 ring-inset">
              {initials(user.name)}
            </div>
          )}
          {showPendingBadge && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-[3px] flex items-center justify-center rounded-full bg-red-500 text-[8px] font-bold text-white ring-2 ring-background leading-none pointer-events-none"
              aria-label={`${pendingCount} pending registration${pendingCount === 1 ? '' : 's'}`}
            >
              {pendingCount > 9 ? '9+' : pendingCount}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[240px] p-1.5 text-sm">
        {/* Header block */}
        <div className="px-2.5 py-2.5 flex items-center gap-2.5">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="h-9 w-9 rounded-full ring-1 ring-border object-cover" />
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/80 text-xs font-semibold text-primary-foreground ring-1 ring-primary/30 ring-inset">
              {initials(user.name)}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium truncate leading-tight">{user.name}</p>
            <p className="text-xs text-muted-foreground truncate leading-tight mt-0.5">{user.email}</p>
            <div className="flex items-center gap-1.5 mt-1.5">
              <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {user.provider === 'google' ? 'Google' : 'Email'}
              </span>
              {isAdmin && (
                <span className="inline-flex items-center rounded-full border border-emerald-200/70 bg-emerald-50/80 dark:border-emerald-900/60 dark:bg-emerald-950/40 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                  Admin
                </span>
              )}
            </div>
          </div>
        </div>
        <DropdownMenuSeparator />
        {isAdmin && (
          <DropdownMenuItem onClick={onOpenUserManagement} className="px-2.5 py-2 text-sm rounded-md cursor-pointer">
            <Users className="h-3.5 w-3.5 mr-2.5" />
            <span className="flex-1">User Management</span>
            {pendingCount > 0 && (
              <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-400 text-[10px] font-bold">
                {pendingCount > 9 ? '9+' : pendingCount}
              </span>
            )}
          </DropdownMenuItem>
        )}
        {user.provider === 'credentials' && (
          <DropdownMenuItem onClick={onOpenChangePassword} className="px-2.5 py-2 text-sm rounded-md cursor-pointer">
            <KeyRound className="h-3.5 w-3.5 mr-2.5" />
            Change Password
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleSignOut}
          disabled={signingOut}
          className="px-2.5 py-2 text-sm rounded-md cursor-pointer text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400 focus:bg-red-50 dark:focus:bg-red-950/40"
        >
          {signingOut ? <Loader2 className="h-3.5 w-3.5 mr-2.5 animate-spin" /> : <LogOut className="h-3.5 w-3.5 mr-2.5" />}
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import { Clock, XCircle, LogOut, Loader2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n'
import type { PublicUser } from './auth-types'

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function UserChip({ user }: { user: PublicUser }) {
  const t = useT()
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5">
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" className="h-7 w-7 rounded-full ring-1 ring-border object-cover" />
      ) : (
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/80 text-[10px] font-semibold text-primary-foreground shrink-0">
          {initials(user.name)}
        </div>
      )}
      <div className="min-w-0 text-left">
        <p className="text-sm font-medium truncate">{user.name}</p>
        <p className="text-xs text-muted-foreground truncate">{user.email}</p>
      </div>
      <span className="ml-auto shrink-0 inline-flex items-center rounded-full border border-border/60 bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        {user.provider === 'google' ? t('auth.viaGoogle') : t('auth.viaEmail')}
      </span>
    </div>
  )
}

export function AccountStatusScreen({ user, onLogout }: { user: PublicUser; onLogout: () => void }) {
  const t = useT()
  const [signingOut, setSigningOut] = React.useState(false)
  const pending = user.status === 'pending'

  const handleSignOut = async () => {
    if (signingOut) return
    setSigningOut(true)
    await onLogout()
  }

  return (
    <div className="min-h-screen flex flex-col">
      <div className="page-backdrop" aria-hidden="true" />
      <main className="flex-1 flex items-center justify-center px-4 py-10 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="w-full max-w-md"
        >
          <div className="rounded-xl border border-border/60 bg-background/95 backdrop-blur-sm shadow-sm p-6 sm:p-8">
            {/* Mobile logo row */}
            <div className="flex items-center gap-2.5 lg:hidden mb-6">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-sm shadow-primary/40 ring-1 ring-primary/30 ring-inset">
                <Zap className="h-4 w-4" />
              </div>
              <span className="text-base font-bold">Dashboard</span>
            </div>

            {pending ? (
              <>
                <div className="flex justify-center mb-5">
                  <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-amber-50 dark:bg-amber-950/40 ring-4 ring-amber-100 dark:ring-amber-900/40 animate-pulse">
                    <Clock className="h-8 w-8 text-amber-500" />
                  </div>
                </div>
                <h1 className="text-xl font-semibold tracking-tight text-center">{t('auth.status.pending.title')}</h1>
                <p className="mt-2 text-sm text-muted-foreground text-center leading-relaxed">
                  {t('auth.status.pending.desc')}
                </p>
                <div className="mt-6">
                  <UserChip user={user} />
                </div>
                <div className="mt-6 flex justify-center">
                  <Button
                    variant="outline"
                    onClick={handleSignOut}
                    disabled={signingOut}
                    className="h-11 px-6 text-sm"
                  >
                    {signingOut ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <LogOut className="h-4 w-4 mr-2" />}
                    {t('auth.menu.signOut')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex justify-center mb-5">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-50 dark:bg-red-950/40 ring-4 ring-red-100 dark:ring-red-900/40">
                    <XCircle className="h-8 w-8 text-red-500 dark:text-red-400" />
                  </div>
                </div>
                <h1 className="text-xl font-semibold tracking-tight text-center">{t('auth.status.rejected.title')}</h1>
                <p className="mt-2 text-sm text-muted-foreground text-center leading-relaxed">
                  {t('auth.status.rejected.desc')}
                </p>
                {user.rejectionReason && (
                  <div className="mt-4 rounded-lg border border-red-200/70 bg-red-50/70 dark:border-red-900/60 dark:bg-red-950/30 px-3.5 py-2.5 text-sm text-red-700 dark:text-red-300" role="alert">
                    <span className="font-medium">{t('auth.status.rejected.reason')}</span>{user.rejectionReason}
                  </div>
                )}
                <div className="mt-6">
                  <UserChip user={user} />
                </div>
                <p className="mt-5 text-xs text-muted-foreground text-center">
                  {t('auth.status.rejected.help')}
                </p>
                <div className="mt-5 flex justify-center">
                  <Button
                    variant="outline"
                    onClick={handleSignOut}
                    disabled={signingOut}
                    className="h-11 px-6 text-sm"
                  >
                    {signingOut ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <LogOut className="h-4 w-4 mr-2" />}
                    {t('auth.menu.signOut')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </motion.div>
      </main>
      <footer className="mt-auto pb-5 pt-2 text-center text-[11px] text-muted-foreground/70">
        {t('login.footer')}
      </footer>
    </div>
  )
}

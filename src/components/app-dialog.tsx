'use client'

/**
 * AppDialog — the ONE modal system for the whole dashboard (v1.27 UI).
 *
 * Before this, ~30 dialogs across page.tsx and the component files each
 * rolled their own combination of max-w-*, max-h-*, overflow-*, p-*, gap-*
 * and footer treatments — seven different visual dialects for the same
 * concept. AppDialog replaces all of them with a single, dense,
 * professional structure:
 *
 *   ┌──────────────────────────────────────────┐
 *   │ [icon] Title                    (close ✕)│  header — border-b, px-5/6 py-4
 *   │        Secondary line (13px muted)        │
 *   ├──────────────────────────────────────────┤
 *   │                                          │
 *   │   body — flex-1, scrolls, custom bar     │
 *   │                                          │
 *   ├──────────────────────────────────────────┤
 *   │                        [Cancel] [Save]   │  footer — border-t, bg-muted/40
 *   └──────────────────────────────────────────┘
 *
 * Rules of the system (keep it looking like ONE product):
 *   - sizes come from the `size` scale ONLY (sm → 3xl) — never ad-hoc max-w
 *   - height: every dialog is capped at min(88dvh, 800px) and the BODY
 *     scrolls, never the dialog shell — headers and footers never leave
 *     the screen
 *   - headers carry an optional 36px icon chip + 15px semibold title +
 *     13px muted description — custom header rows are allowed via children
 *   - footers sit on a hairline-muted strip, buttons right-aligned
 *   - padding is owned by the sections (px-5 py-4 · py-5 · py-3.5), never
 *     by the shell — content can go flush (tables, lists, terminal output)
 *
 * AppAlertDialog mirrors the exact same anatomy on radix's alert-dialog
 * (focus stays trapped, no close on outside click) for destructive
 * confirmations.
 */

import * as React from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'

/* ---------------------------------------------------------------- variant */

/** Which radix family the sections are rendered into. Radix requires
 *  matching pairs — a DialogTitle inside an AlertDialog root throws
 *  "DialogTitle must be used within Dialog" the moment the alert opens
 *  (real crash caught by browser E2E on the delete-project confirm). The
 *  shells set this; the section components pick the right primitives. */
const AppDialogVariantContext = React.createContext<'dialog' | 'alert'>('dialog')

/* ------------------------------------------------------------------ sizes */

export type AppDialogSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl'

const SIZE_CLASSES: Record<AppDialogSize, string> = {
  sm: 'sm:max-w-[420px]',     // small confirms, single-field prompts
  md: 'sm:max-w-[480px]',     // standard forms (default)
  lg: 'sm:max-w-[560px]',     // details, diagnoses, multi-field forms
  xl: 'sm:max-w-[640px]',     // settings, monitors
  '2xl': 'sm:max-w-[760px]',  // tables, wizards
  '3xl': 'sm:max-w-[900px]',  // wide tables, log viewers
}

/* ----------------------------------------------------------------- dialog */

/** The unified dialog shell — Dialog + DialogContent with the system styles. */
export function AppDialog({
  open,
  onOpenChange,
  size = 'md',
  showClose = true,
  className,
  children,
  ...rest
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  size?: AppDialogSize
  showClose?: boolean
  className?: string
  children: React.ReactNode
} & Omit<React.ComponentProps<typeof Dialog>, 'open' | 'onOpenChange' | 'children'>) {
  return (
    <AppDialogVariantContext.Provider value="dialog">
      <Dialog open={open} onOpenChange={onOpenChange} {...rest}>
        <DialogContent showCloseButton={showClose} className={cn(APP_DIALOG_SHELL, SIZE_CLASSES[size], className)}>
          {children}
        </DialogContent>
      </Dialog>
    </AppDialogVariantContext.Provider>
  )
}

/** Destructive-confirmation variant — same anatomy, alert semantics. */
export function AppAlertDialog({
  open,
  onOpenChange,
  size = 'md',
  className,
  children,
  ...rest
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  size?: AppDialogSize
  className?: string
  children: React.ReactNode
} & Omit<React.ComponentProps<typeof AlertDialog>, 'open' | 'onOpenChange' | 'children'>) {
  return (
    <AppDialogVariantContext.Provider value="alert">
      <AlertDialog open={open} onOpenChange={onOpenChange} {...rest}>
        <AlertDialogContent className={cn(APP_DIALOG_SHELL, SIZE_CLASSES[size], className)}>
          {children}
        </AlertDialogContent>
      </AlertDialog>
    </AppDialogVariantContext.Provider>
  )
}

/** Shared shell classes — height cap, column flex, no shell padding,
 *  overflow owned by the body section. Kept in one constant so the alert
 *  variant can never drift from the plain one. */
const APP_DIALOG_SHELL =
  'flex max-h-[min(88dvh,800px)] w-full flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-xl'

/* ---------------------------------------------------------------- header  */

export function AppDialogHeader({
  icon: Icon,
  title,
  description,
  className,
  children,
}: {
  /** Optional leading icon — rendered inside a 36px muted chip. */
  icon?: LucideIcon
  /** 15px semibold heading. Omit when passing custom children (which must
   *  then include their own <DialogTitle> for accessibility). */
  title?: React.ReactNode
  /** 13px muted support line. */
  description?: React.ReactNode
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div
      data-app-dialog-header
      className={cn(
        'flex min-h-0 shrink-0 items-start gap-3 border-b px-5 py-4 sm:px-6',
        className,
      )}
    >
      {Icon ? (
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
          <Icon className="size-4 text-muted-foreground" />
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        {children ?? (
          <>
            <AppDialogTitle>{title}</AppDialogTitle>
            {description ? <AppDialogDescription>{description}</AppDialogDescription> : null}
          </>
        )}
      </div>
    </div>
  )
}

/** Bare title for custom header children — same typography as the
 *  `title` prop so hand-rolled headers can't drift. Renders the radix
 *  Title matching the surrounding shell (Dialog vs AlertDialog). */
export function AppDialogTitle({ className, ...props }: React.ComponentProps<typeof DialogTitle>) {
  const variant = React.useContext(AppDialogVariantContext)
  const Comp = variant === 'alert' ? AlertDialogTitle : DialogTitle
  return <Comp className={cn('text-left text-[15px] leading-6 font-semibold tracking-tight', className)} {...props} />
}
export function AppDialogDescription({ className, ...props }: React.ComponentProps<typeof DialogDescription>) {
  const variant = React.useContext(AppDialogVariantContext)
  const Comp = variant === 'alert' ? AlertDialogDescription : DialogDescription
  return <Comp className={cn('mt-0.5 text-left text-[13px] leading-relaxed', className)} {...props} />
}

/* ------------------------------------------------------------------ body  */

export function AppDialogBody({
  flush = false,
  className,
  children,
}: {
  /** Edge-to-edge content (tables, lists, terminals) — drops the section
   *  padding but keeps the scroll behavior. */
  flush?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      data-app-dialog-body
      className={cn(
        'custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain',
        flush ? 'p-0' : 'px-5 py-4 sm:px-6 sm:py-5',
        className,
      )}
    >
      {children}
    </div>
  )
}

/* ---------------------------------------------------------------- footer  */

export function AppDialogFooter({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      data-app-dialog-footer
      className={cn(
        'flex shrink-0 flex-col-reverse gap-2 border-t bg-muted/40 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-end sm:px-6',
        className,
      )}
    >
      {children}
    </div>
  )
}

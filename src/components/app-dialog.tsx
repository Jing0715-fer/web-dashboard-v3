'use client'

/**
 * AppDialog — the ONE modal system for the whole dashboard (v1.31 "Clear").
 *
 * v1.31 is a full visual refactor of the previous v1.27 anatomy. The
 * structure below is unchanged (header / body / footer, sizes sm→3xl,
 * body scrolls, alert variant) — every existing caller keeps working —
 * but the visual language is rebuilt:
 *
 *   ┌────────────────────────────────────────────┐
 *   │ ◻ [icon]  Title (16px semibold)     (✕)    │  header — py-5, 40px chip, hairline border
 *   │           Support line (13px muted)        │
 *   ├────────────────────────────────────────────┤
 *   │  SECTION LABEL (11px uppercase, muted)     │  AppDialogSection — new in v1.31:
 *   │                                            │  quiet section headers inside bodies
 *   │   body — flex-1, scrolls, px-6 py-5        │
 *   ├────────────────────────────────────────────┤
 *   │                        [Cancel] [Save]     │  footer — py-4 on muted/40 strip
 *   └────────────────────────────────────────────┘
 *
 * Design rules of the system (keep it looking like ONE product):
 *   - quiet chrome: labels and headers recede (uppercase micro-labels,
 *     muted color); the user's DATA is the foreground — never decoration
 *   - one accent: colored chips/dots only for status, links and primary
 *     actions — section headers carry NO color bars
 *   - soft depth: rounded-2xl shell, layered soft shadow, hairline ring
 *     instead of the old hard shadow-2xl edge
 *   - sizes come from the `size` scale ONLY (sm → 3xl) — never ad-hoc max-w
 *   - height: capped at min(88dvh, 800px); the BODY scrolls, never the
 *     shell — headers and footers never leave the screen
 *   - padding is owned by the sections (px-6 · py-5 · py-4), never by the
 *     shell — content can go flush (tables, lists, terminal output)
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
 *  variant can never drift from the plain one. v1.31: rounded-2xl + layered
 *  soft shadow + hairline ring — the old shadow-2xl/ring-5% edge read as
 *  heavy; this one sits softer on the blurred backdrop. */
const APP_DIALOG_SHELL =
  'flex max-h-[min(88dvh,800px)] w-full flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-6px_rgba(0,0,0,0.14),0_24px_48px_-12px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.06] dark:shadow-[0_1px_2px_rgba(0,0,0,0.4),0_8px_24px_-6px_rgba(0,0,0,0.5)] dark:ring-white/[0.08]'

/* ---------------------------------------------------------------- header  */

/** Optional tint for the header icon chip. `default` keeps the neutral
 *  muted chip; the others let a dialog signal intent (agent run = emerald,
 *  conflict = amber, destructive = rose, info = sky) while staying inside
 *  the same 40px anatomy. Purely opt-in — every existing caller that does
 *  not pass it renders exactly as before. */
export type AppDialogIconTone = 'default' | 'emerald' | 'amber' | 'rose' | 'sky'

const ICON_TONE_CLASSES: Record<AppDialogIconTone, { chip: string; icon: string }> = {
  default: { chip: 'border bg-muted/60', icon: 'text-muted-foreground' },
  emerald: { chip: 'border-emerald-500/25 bg-emerald-500/10 dark:bg-emerald-500/15', icon: 'text-emerald-600 dark:text-emerald-400' },
  amber: { chip: 'border-amber-500/25 bg-amber-500/10 dark:bg-amber-500/15', icon: 'text-amber-600 dark:text-amber-400' },
  rose: { chip: 'border-rose-500/25 bg-rose-500/10 dark:bg-rose-500/15', icon: 'text-rose-600 dark:text-rose-400' },
  sky: { chip: 'border-sky-500/25 bg-sky-500/10 dark:bg-sky-500/15', icon: 'text-sky-600 dark:text-sky-400' },
}

export function AppDialogHeader({
  icon: Icon,
  iconTone = 'default',
  title,
  description,
  className,
  children,
}: {
  /** Optional leading icon — rendered inside a 40px chip (see iconTone). */
  icon?: LucideIcon
  /** Chip + icon tint, default keeps the neutral muted look. */
  iconTone?: AppDialogIconTone
  /** 16px semibold heading. Omit when passing custom children (which must
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
        'flex min-h-0 shrink-0 items-start gap-4 border-b border-border/70 px-6 py-5',
        className,
      )}
    >
      {Icon ? (
        <div className={`mt-0 flex size-10 shrink-0 items-center justify-center rounded-xl ${ICON_TONE_CLASSES[iconTone].chip}`}>
          <Icon className={`size-[18px] ${ICON_TONE_CLASSES[iconTone].icon}`} />
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
  return <Comp className={cn('text-left text-base leading-6 font-semibold tracking-[-0.01em]', className)} {...props} />
}
export function AppDialogDescription({ className, ...props }: React.ComponentProps<typeof DialogDescription>) {
  const variant = React.useContext(AppDialogVariantContext)
  const Comp = variant === 'alert' ? AlertDialogDescription : DialogDescription
  return <Comp className={cn('mt-1 text-left text-[13px] leading-relaxed', className)} {...props} />
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
        flush ? 'p-0' : 'px-6 py-5',
        className,
      )}
    >
      {children}
    </div>
  )
}

/* --------------------------------------------------------------- section  */

/** Quiet section header for dialog bodies — NEW in v1.31.
 *
 * Dialog bodies used to open with an <h4> semibold line (or worse, colored
 * bars) that competed with the dialog title. AppDialogSection replaces all
 * of them with the receding pattern: 11px uppercase tracking label in
 * muted color, an optional one-line hint, and an optional action slot on
 * the right. The section's content stays in the foreground.
 *
 *   <AppDialogSection title="Connection" hint="Tested on save"
 *                     action={<Button …/>}>
 *     …fields…
 *   </AppDialogSection>
 *
 * `divider` (default true) draws the hairline under the label row; pass
 * false for stacked sections inside one card. */
export function AppDialogSection({
  title,
  hint,
  action,
  divider = true,
  className,
  children,
}: {
  title: React.ReactNode
  hint?: React.ReactNode
  action?: React.ReactNode
  /** Hairline under the label row (default true). */
  divider?: boolean
  className?: string
  children?: React.ReactNode
}) {
  return (
    <section data-app-dialog-section className={cn('min-w-0', className)}>
      <div className={cn('mb-3 flex flex-wrap items-center gap-x-3 gap-y-1', divider && 'border-b border-border/60 pb-2.5')}>
        <h3 className="text-[11px] leading-4 font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {title}
        </h3>
        {hint ? (
          <p className="min-w-0 flex-1 basis-52 text-xs leading-4 text-muted-foreground/70">{hint}</p>
        ) : (
          <span className="flex-1" aria-hidden />
        )}
        {action ? <div className="ml-auto flex shrink-0 items-center">{action}</div> : null}
      </div>
      {children}
    </section>
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
        'flex shrink-0 flex-col-reverse gap-2.5 border-t border-border/70 bg-muted/40 px-6 py-4 sm:flex-row sm:items-center sm:justify-end',
        className,
      )}
    >
      {children}
    </div>
  )
}

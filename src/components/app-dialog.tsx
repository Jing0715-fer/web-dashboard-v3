'use client'

/**
 * AppDialog — the ONE modal system for the whole dashboard (v1.30 visual pass).
 *
 * The v1.27 pass unified ~30 dialogs structurally (one shell, one size scale,
 * body-owned scrolling) but kept the visuals plain — the shell was a flat
 * rounded-xl card and bodies were stock label/input stacks. This pass gives
 * the system an actual design language:
 *
 *   ╭──────────────────────────────────────────────╮
 *   │ ▓▓▓▓▓▓▓▓░░░  tone gradient accent strip       │  3px, tone-tinted
 *   │                                              │
 *   │  ▢  Title                                    │  gradient icon tile (40px)
 *   │     Secondary line (13px muted)          ✕  │  header sits on a soft
 *   ├──────────────────────────────────────────────┤  muted wash
 *   │  SECTION EYEBROW                             │  AppDialogSection
 *   │  fields / lists / option cards               │
 *   │  ── fade divider ──                          │  AppDialogDivider
 *   │  ...                                         │
 *   ├──────────────────────────────────────────────┤
 *   │                          [Cancel] [Save]     │  footer on hairline strip
 *   ╰──────────────────────────────────────────────╯
 *
 * Rules of the system (keep it looking like ONE product):
 *   - sizes come from the `size` scale ONLY (sm → 3xl) — never ad-hoc max-w
 *   - height: every dialog is capped at min(88dvh, 800px) and the BODY
 *     scrolls, never the dialog shell — headers and footers never leave
 *     the screen
 *   - headers carry an optional 40px gradient icon tile + 16px semibold
 *     title + 13px muted description, plus a tone-colored accent strip
 *     along the top edge of the dialog; the header reserves the top-right
 *     corner so content never overlaps the floating close button (v1.33)
 *   - bodies are organized with AppDialogSection eyebrows instead of bare
 *     label stacks; AppDialogDivider separates groups with a fading hairline
 *   - footers sit on a hairline-muted strip, buttons right-aligned
 *   - padding is owned by the sections (px-5 py-4 · py-5 · py-4), never
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
  md: 'sm:max-w-[520px]',     // standard forms (default)
  lg: 'sm:max-w-[580px]',     // details, diagnoses, multi-field forms
  xl: 'sm:max-w-[660px]',     // settings, monitors
  '2xl': 'sm:max-w-[780px]',  // tables, wizards
  '3xl': 'sm:max-w-[920px]',  // wide tables, log viewers
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
 *  variant can never drift from the plain one. The v1.30 look: softer
 *  2xl radius, a two-layer depth shadow (tight contact shadow + wide
 *  ambient) and a hairline ring so the card reads as a physical sheet
 *  floating over the frosted page. */
const APP_DIALOG_SHELL =
  'flex max-h-[min(88dvh,800px)] w-full flex-col gap-0 overflow-hidden rounded-2xl border border-border/70 p-0 ' +
  'shadow-[0_6px_16px_-6px_rgb(0_0_0/0.10),0_32px_72px_-16px_rgb(0_0_0/0.28)] ' +
  'ring-1 ring-black/[0.04] dark:ring-white/[0.06]'

/* ---------------------------------------------------------------- header  */

/** Optional tint for the header icon tile and the top accent strip.
 *  `default` keeps the neutral look; the others let a dialog signal intent
 *  (agent run = emerald, conflict = amber, destructive = rose, info = sky)
 *  while staying inside the same 40px anatomy. Purely opt-in — every
 *  existing caller that does not pass it renders exactly as before. */
export type AppDialogIconTone = 'default' | 'emerald' | 'amber' | 'rose' | 'sky' | 'violet'

const ICON_TONE_CLASSES: Record<AppDialogIconTone, { tile: string; icon: string; accent: string }> = {
  default: {
    tile: 'bg-gradient-to-br from-foreground/[0.08] to-foreground/[0.03] ring-1 ring-foreground/[0.08]',
    icon: 'text-foreground/70',
    accent: 'bg-gradient-to-r from-foreground/[0.16] via-foreground/[0.06] to-transparent',
  },
  emerald: {
    tile: 'bg-gradient-to-br from-emerald-500/25 to-emerald-500/[0.06] ring-1 ring-emerald-500/25',
    icon: 'text-emerald-600 dark:text-emerald-400',
    accent: 'bg-gradient-to-r from-emerald-500/80 via-emerald-500/25 to-transparent',
  },
  amber: {
    tile: 'bg-gradient-to-br from-amber-500/25 to-amber-500/[0.06] ring-1 ring-amber-500/25',
    icon: 'text-amber-600 dark:text-amber-400',
    accent: 'bg-gradient-to-r from-amber-500/80 via-amber-500/25 to-transparent',
  },
  rose: {
    tile: 'bg-gradient-to-br from-rose-500/25 to-rose-500/[0.06] ring-1 ring-rose-500/25',
    icon: 'text-rose-600 dark:text-rose-400',
    accent: 'bg-gradient-to-r from-rose-500/80 via-rose-500/25 to-transparent',
  },
  sky: {
    tile: 'bg-gradient-to-br from-sky-500/25 to-sky-500/[0.06] ring-1 ring-sky-500/25',
    icon: 'text-sky-600 dark:text-sky-400',
    accent: 'bg-gradient-to-r from-sky-500/80 via-sky-500/25 to-transparent',
  },
  violet: {
    tile: 'bg-gradient-to-br from-violet-500/25 to-violet-500/[0.06] ring-1 ring-violet-500/25',
    icon: 'text-violet-600 dark:text-violet-400',
    accent: 'bg-gradient-to-r from-violet-500/80 via-violet-500/25 to-transparent',
  },
}

export function AppDialogHeader({
  icon: Icon,
  iconTone = 'default',
  title,
  description,
  className,
  children,
}: {
  /** Optional leading icon — rendered inside a 40px gradient tile (see iconTone). */
  icon?: LucideIcon
  /** Tile + icon + accent strip tint, default keeps the neutral look. */
  iconTone?: AppDialogIconTone
  /** 16px semibold heading. Omit when passing custom children (which must
   *  then include their own <DialogTitle> for accessibility). */
  title?: React.ReactNode
  /** 13px muted support line. */
  description?: React.ReactNode
  className?: string
  children?: React.ReactNode
}) {
  const tone = ICON_TONE_CLASSES[iconTone]
  // Dialog shells render an absolute ✕ at top-[18px] right-4 (zone: right
  // 16→44px). Reserve that strip on the header so titles, descriptions and
  // custom header rows can never run underneath it (the v1.32 overlap
  // complaint). Alert shells render no close button, so they skip the
  // reservation and keep symmetric padding.
  const variant = React.useContext(AppDialogVariantContext)
  return (
    <div
      data-app-dialog-header
      className={cn(
        'relative flex min-h-0 shrink-0 items-start gap-3.5 border-b border-border/60 bg-gradient-to-b from-muted/60 via-muted/25 to-transparent py-4 pl-5 sm:pl-6',
        variant === 'dialog' ? 'pr-13 sm:pr-14' : 'pr-5 sm:pr-6',
        className,
      )}
    >
      {/* Tone accent strip — runs along the very top edge of the dialog
          (the shell clips it to the rounded corners). Gives every dialog
          a signature colored edge that matches its intent. */}
      <div aria-hidden className={cn('absolute inset-x-0 top-0 h-[3px]', tone.accent)} />
      {Icon ? (
        <div className={`mt-0 flex size-10 shrink-0 items-center justify-center rounded-xl ${tone.tile}`}>
          <Icon className={`size-[18px] ${tone.icon}`} />
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
  return <Comp className={cn('text-left text-base leading-6 font-semibold tracking-tight', className)} {...props} />
}
export function AppDialogDescription({ className, ...props }: React.ComponentProps<typeof DialogDescription>) {
  const variant = React.useContext(AppDialogVariantContext)
  const Comp = variant === 'alert' ? AlertDialogDescription : DialogDescription
  return <Comp className={cn('mt-1 text-left text-[13px] leading-relaxed text-muted-foreground', className)} {...props} />
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
        flush ? 'p-0' : 'px-5 py-5 sm:px-6',
        className,
      )}
    >
      {children}
    </div>
  )
}

/* --------------------------------------------------------------- sections */

/** Labeled subsection for dialog bodies — the v1.30 form language. Instead
 *  of bare label/input stacks, bodies organize content into sections with
 *  a small icon chip + 11px uppercase eyebrow, an optional muted hint and
 *  an optional right-aligned action (e.g. a "detect" button). Purely
 *  presentational: children stay exactly what the caller renders.
 *
 *  API note: `title` is an alias of `label` kept for v1.31-era callers
 *  (theme-customizer passes title + divider); `divider` renders the
 *  v1.31-style hairline under the eyebrow row, off by default. */
export function AppDialogSection({
  icon: Icon,
  label,
  title,
  hint,
  action,
  divider = false,
  className,
  children,
}: {
  /** Optional 24px chip icon next to the eyebrow. */
  icon?: LucideIcon
  /** Eyebrow text — keep it short, it renders uppercase. */
  label?: React.ReactNode
  /** Alias of `label` (v1.31 API) — either prop works. */
  title?: React.ReactNode
  /** Optional muted aside on the eyebrow line. */
  hint?: React.ReactNode
  /** Optional right-aligned slot (buttons, badges…). */
  action?: React.ReactNode
  /** Hairline under the eyebrow row (v1.31 API, default off). */
  divider?: boolean
  className?: string
  children?: React.ReactNode
}) {
  const heading = label ?? title
  return (
    <section className={cn('space-y-3', className)}>
      <div className={cn('flex min-h-6 items-center gap-2', divider && 'border-b border-border/60 pb-2.5')}>
        {Icon ? (
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06] ring-1 ring-inset ring-foreground/[0.05]">
            <Icon className="size-3 text-muted-foreground" />
          </span>
        ) : null}
        <h3 className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {heading}
        </h3>
        {hint ? <span className="min-w-0 truncate text-[11px] text-muted-foreground/60">{hint}</span> : null}
        {action ? <div className="ml-auto shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

/** Fading hairline divider for between sections — quieter than a full
 *  border because it dissolves towards the edges. */
export function AppDialogDivider({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('h-px w-full bg-gradient-to-r from-transparent via-border to-transparent', className)}
    />
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
        'flex shrink-0 flex-col-reverse gap-2 border-t border-border/60 bg-muted/30 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-end sm:px-6',
        className,
      )}
    >
      {children}
    </div>
  )
}

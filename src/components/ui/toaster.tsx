"use client"

import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"
import { CopyErrorButton } from "@/components/ui/error-detail"
import { AlertCircle } from "lucide-react"
import { useT } from "@/lib/i18n"

// 全局回调，由 page.tsx 设置
let onToastClick: ((detail: string, title: string) => void) | null = null
export function setToastClickHandler(cb: (detail: string, title: string) => void) {
  onToastClick = cb
}

// The layout <Toaster /> is the SINGLE toast renderer (the page-level custom
// toast list was removed — rendering the same useToast store twice made every
// notification appear twice in two different styles).
//
// Semantic variants keep their colors here (the radix Toast only knows
// default/destructive), and the viewport is pinned to the bottom-right —
// raised above the mobile bottom nav — so toasts land where users expect
// them on every breakpoint.
const VARIANT_CLASS: Record<string, string> = {
  success:
    'border-emerald-500/60 bg-emerald-50 dark:bg-emerald-950/60 dark:border-emerald-800/60',
  warning:
    'border-amber-500/60 bg-amber-50 dark:bg-amber-950/60 dark:border-amber-800/60',
  info: 'border-border bg-card',
  destructive: '',
}

/** Compact action row for error toasts carrying a `detail` payload:
 *  one-click copy (full raw error) + a hint that clicking the toast opens
 *  the full detail dialog. */
function ErrorToastActions({ detail }: { detail: string }) {
  const t = useT()
  return (
    <div className="mt-1.5 flex items-center justify-between gap-2">
      <span className="select-none text-[10px] leading-4 text-muted-foreground/70">
        {t('dlg.error.clickToView')}
      </span>
      <CopyErrorButton
        text={detail}
        className="border-destructive/25 bg-background/60 text-destructive/80 hover:bg-background hover:text-destructive"
      />
    </div>
  )
}

export function Toaster() {
  const { toasts } = useToast()
  const t = useT()

  const mapVariant = (v: string | undefined) => {
    if (v === 'destructive') return 'destructive' as const
    return 'default' as const
  }

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, variant, ...props }) {
        const detail = (props as any).detail as string | undefined
        const isDestructive = variant === 'destructive'
        return (
          <Toast
            key={id}
            {...props}
            variant={mapVariant(variant)}
            onClick={detail ? () => onToastClick?.(detail, title || t('dlg.error.title')) : undefined}
            className={[
              detail ? 'cursor-pointer' : '',
              VARIANT_CLASS[variant || 'default'] || '',
            ].filter(Boolean).join(' ') || undefined}
          >
            <div className="grid min-w-0 flex-1 gap-1">
              {title && (
                <ToastTitle className={isDestructive ? 'flex min-w-0 items-center gap-2 text-destructive' : 'flex min-w-0 items-center gap-2'}>
                  {isDestructive && <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />}
                  <span className="min-w-0 break-words">{title}</span>
                </ToastTitle>
              )}
              {description && (
                <ToastDescription className="min-w-0 break-words line-clamp-3">
                  {description}
                </ToastDescription>
              )}
              {detail && isDestructive && <ErrorToastActions detail={detail} />}
            </div>
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport className="top-auto bottom-16 right-4 left-auto w-auto max-w-sm p-0 gap-2 sm:bottom-4 sm:right-4" />
    </ToastProvider>
  )
}

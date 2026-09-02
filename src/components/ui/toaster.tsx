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

export function Toaster() {
  const { toasts } = useToast()

  const mapVariant = (v: string | undefined) => {
    if (v === 'destructive') return 'destructive' as const
    return 'default' as const
  }

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, variant, ...props }) {
        const detail = (props as any).detail as string | undefined
        return (
          <Toast
            key={id}
            {...props}
            variant={mapVariant(variant)}
            onClick={detail ? () => onToastClick?.(detail, title || 'Error') : undefined}
            className={[
              detail ? 'cursor-pointer' : '',
              VARIANT_CLASS[variant || 'default'] || '',
            ].filter(Boolean).join(' ') || undefined}
          >
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport className="top-auto bottom-16 right-4 left-auto w-auto max-w-sm p-0 gap-2 sm:bottom-4 sm:right-4" />
    </ToastProvider>
  )
}

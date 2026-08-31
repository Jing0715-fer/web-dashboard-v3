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

export function Toaster() {
  const { toasts } = useToast()

  // Toast 组件只支持 default/destructive，success 映射为 default
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
            className={detail ? 'cursor-pointer' : undefined}
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
      <ToastViewport />
    </ToastProvider>
  )
}
'use client'

import * as React from 'react'

interface Toast {
  id: string
  title: string
  // ReactNode allowed since the error-UI rework — error toasts render a
  // compact copy-button row via components. Plain strings keep working.
  description?: React.ReactNode
  // 'warning' / 'info' / 'success' are semantic labels for callers; the
  // Toaster maps anything non-destructive to the default visual style.
  variant?: 'default' | 'destructive' | 'success' | 'warning' | 'info'
  detail?: string  // 完整错误信息，点击 toast 时展示
  /** Auto-dismiss delay in ms. Errors (destructive) default to 10s so
   *  the message can actually be read / copied; everything else 4s. */
  duration?: number
}

interface ToastState {
  toasts: Toast[]
}

const TOAST_TIMEOUT = 4000
/** Destructive toasts stick around longer — reading + copying an error
 *  takes more than the default 4s flash. */
const ERROR_TOAST_TIMEOUT = 10000

let count = 0
function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER
  return count.toString()
}

const listeners: Array<(state: ToastState) => void> = []
let memoryState: ToastState = { toasts: [] }

function dispatch(state: ToastState) {
  memoryState = state
  listeners.forEach((listener) => listener(state))
}

function addToast(toast: Omit<Toast, 'id'>) {
  const id = genId()
  dispatch({
    ...memoryState,
    toasts: [...memoryState.toasts, { ...toast, id }],
  })
  const duration =
    toast.duration ?? (toast.variant === 'destructive' ? ERROR_TOAST_TIMEOUT : TOAST_TIMEOUT)
  setTimeout(() => {
    dispatch({
      ...memoryState,
      toasts: memoryState.toasts.filter((t) => t.id !== id),
    })
  }, duration)
  return id
}

function dismissToast(id: string) {
  dispatch({
    ...memoryState,
    toasts: memoryState.toasts.filter((t) => t.id !== id),
  })
}

function useToast() {
  const [state, setState] = React.useState<ToastState>(memoryState)

  React.useEffect(() => {
    listeners.push(setState)
    return () => {
      const index = listeners.indexOf(setState)
      if (index > -1) listeners.splice(index, 1)
    }
  }, [])

  return {
    ...state,
    toast: addToast,
    dismiss: dismissToast,
  }
}

export { useToast, addToast, dismissToast }
export type { Toast }

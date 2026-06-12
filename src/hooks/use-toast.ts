'use client'

import * as React from 'react'

interface Toast {
  id: string
  title: string
  description?: string
  variant?: 'default' | 'destructive' | 'success'
}

interface ToastState {
  toasts: Toast[]
}

const TOAST_TIMEOUT = 4000

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
  setTimeout(() => {
    dispatch({
      ...memoryState,
      toasts: memoryState.toasts.filter((t) => t.id !== id),
    })
  }, TOAST_TIMEOUT)
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

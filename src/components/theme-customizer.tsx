'use client'

import * as React from 'react'
import { useTheme } from 'next-themes'
import { Palette, Sun, Moon, Monitor, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const STORAGE_KEY = 'dashboard-accent'

/** Accent presets — keep ids in sync with globals.css [data-accent] rules and layout.tsx init script. */
export const ACCENT_PRESETS = [
  { id: 'emerald', label: 'Emerald', light: '#059669', dark: '#34d399' },
  { id: 'teal', label: 'Teal', light: '#0d9488', dark: '#2dd4bf' },
  { id: 'cyan', label: 'Cyan', light: '#0891b2', dark: '#22d3ee' },
  { id: 'blue', label: 'Blue', light: '#2563eb', dark: '#60a5fa' },
  { id: 'violet', label: 'Violet', light: '#7c3aed', dark: '#a78bfa' },
  { id: 'rose', label: 'Rose', light: '#e11d48', dark: '#fb7185' },
  { id: 'orange', label: 'Orange', light: '#ea580c', dark: '#fb923c' },
  { id: 'amber', label: 'Amber', light: '#d97706', dark: '#fbbf24' },
] as const

type AccentId = (typeof ACCENT_PRESETS)[number]['id']

const isAccentId = (v: string | null): v is AccentId =>
  !!v && ACCENT_PRESETS.some((a) => a.id === v)

export function useAccent() {
  const [accent, setAccentState] = React.useState<AccentId>('emerald')

  React.useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (isAccentId(saved)) {
      setAccentState(saved)
      document.documentElement.setAttribute('data-accent', saved)
    }
  }, [])

  const setAccent = React.useCallback((id: AccentId) => {
    localStorage.setItem(STORAGE_KEY, id)
    document.documentElement.setAttribute('data-accent', id)
    setAccentState(id)
  }, [])

  return { accent, setAccent }
}

const MODES = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
] as const

/** Palette popover: dark/light/system mode + accent color swatches. Freely switchable. */
export function ThemeCustomizer() {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const { accent, setAccent } = useAccent()
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  const current = ACCENT_PRESETS.find((a) => a.id === accent) ?? ACCENT_PRESETS[0]
  const activeSwatch = mounted ? (resolvedTheme === 'dark' ? current.dark : current.light) : current.light

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-theme-customizer
          className="relative"
          title="Appearance — theme & accent color"
        >
          <Palette className="h-4 w-4" />
          {/* live accent dot */}
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-background ring-1 ring-border"
            style={{ backgroundColor: activeSwatch }}
          />
          <span className="sr-only">Customize appearance</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-3" sideOffset={8}>
        <p className="text-[11px] font-medium text-muted-foreground mb-2">Appearance</p>
        <div className="grid grid-cols-3 gap-1 mb-4" role="radiogroup" aria-label="Color mode">
          {MODES.map((m) => {
            const active = mounted && theme === m.id
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setTheme(m.id)}
                className={cn(
                  'inline-flex flex-col items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] font-medium cursor-pointer transition-colors',
                  active
                    ? 'border-brand/40 bg-brand-soft text-brand-strong'
                    : 'border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <m.icon className="h-3.5 w-3.5" />
                {m.label}
              </button>
            )
          })}
        </div>
        <p className="text-[11px] font-medium text-muted-foreground mb-2">Accent color</p>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Accent color">
          {ACCENT_PRESETS.map((a) => {
            const active = accent === a.id
            const swatch = mounted ? (resolvedTheme === 'dark' ? a.dark : a.light) : a.light
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={active}
                title={a.label}
                onClick={() => setAccent(a.id)}
                className={cn(
                  'relative h-7 w-7 rounded-full cursor-pointer transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'ring-2 ring-offset-2 ring-offset-popover' : 'ring-1 ring-border'
                )}
                style={{ backgroundColor: swatch, ...(active ? { '--tw-ring-color': swatch } as React.CSSProperties : {}) }}
              >
                {active && <Check className="absolute inset-0 m-auto h-3.5 w-3.5 text-white drop-shadow" />}
                <span className="sr-only">{a.label}</span>
              </button>
            )
          })}
        </div>
        <p className="mt-3 text-[10px] text-muted-foreground leading-relaxed">
          Applies to buttons, tags, highlights and focus rings. Saved to this browser.
        </p>
      </PopoverContent>
    </Popover>
  )
}

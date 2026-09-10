'use client'

/**
 * Polished error presentation (Task 17).
 *
 * Raw API error strings (Prisma validation dumps, Next/Turbopack traces, …)
 * used to be pasted verbatim into toasts — multi-hundred-character blobs with
 * ANSI codes and module paths that broke the layout, auto-vanished in 4s and
 * could not be copied. This module gives every error surface a consistent,
 * useful treatment:
 *
 *   summarizeError(raw)  — one-line human summary (ANSI-stripped, key-line
 *                          extracted, length-clamped) for toast descriptions.
 *   copyText(text)       — clipboard with execCommand fallback (iframes /
 *                          non-secure contexts where navigator.clipboard
 *                          throws NotAllowedError).
 *   CopyErrorButton      — one-click copy w/ success feedback.
 *   ErrorDetailsBlock    — full panel: summary strip + collapsible
 *                          terminal-styled technical details + copy button
 *                          (used by the error detail dialog).
 *
 * None of this touches how errors are PRODUCED — purely presentation.
 */

import * as React from 'react'
import { AlertCircle, Check, ChevronDown, Copy } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

// ------------------------------ helpers ------------------------------

/** ANSI escape sequences (Prisma chalks its errors) + stray carriage returns. */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

/** Lines that look like an actual error verdict — preferred for the summary. */
const KEY_LINE_RE =
  /unknown argument|got invalid|invalid value|expected|not found|unique constraint|constraint failed|does not exist|cannot find|connection|timeout|denied|unauthorized|forbidden|unsupported|unknown.*(field|argument|option)|available options/i

/**
 * Compress a raw error string into a single readable line.
 *
 * Strategy: strip ANSI, split into lines, prefer the line that states the
 * verdict ("Unknown argument `repoUrl`…") over noise ("Invalid", stack frames,
 * chunk paths), clamp to 160 chars.
 */
export function summarizeError(raw?: string | null): string {
  if (!raw) return ''
  const text = String(raw).replace(ANSI_RE, '').replace(/\r/g, '')
  const lines = text
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)
  if (lines.length === 0) return ''
  // Drop pure-noise lines (bare "Invalid", chunk-file brackets, JSON braces).
  const candidates = lines.filter(
    (l) =>
      l.length > 8 &&
      !/^\[.*\]:?$/.test(l) &&
      !/^[{}[\]]*$/.test(l) &&
      !/TURBOPACK/i.test(l),
  )
  const pool = candidates.length > 0 ? candidates : lines
  const verdict = pool.find((l) => KEY_LINE_RE.test(l))
  const summary = verdict || pool[0]
  return summary.length > 160 ? summary.slice(0, 157).trimEnd() + '…' : summary
}

/** Copy text to the clipboard; falls back to execCommand for iframes /
 *  non-secure contexts where navigator.clipboard throws NotAllowedError.
 *  The fallback textarea is hosted INSIDE any open dialog (Radix focus
 *  traps steal focus back from body-hosted elements before execCommand
 *  can read the selection), or document.body otherwise. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const host =
        document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]') ||
        document.body
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.top = '-1000px'
      ta.style.opacity = '0'
      host.appendChild(ta)
      ta.focus()
      ta.select()
      const ok = document.execCommand('copy')
      host.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

// ------------------------------ copy button ------------------------------

/** One-click copy with a 1.8s success state. stopPropagation keeps it from
 *  triggering a parent onClick (error toasts open the detail dialog). */
export function CopyErrorButton({ text, className }: { text: string; className?: string }) {
  const t = useT()
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const ok = await copyText(text)
    if (ok) {
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1800)
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={t('dlg.error.copyError')}
      title={t('dlg.error.copyError')}
      className={cn(
        'inline-flex shrink-0 select-none items-center gap-1.5 rounded-md border bg-background/70 px-2 py-1',
        'text-[11px] font-medium text-muted-foreground shadow-sm transition-all',
        'hover:bg-background hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'active:scale-95',
        copied ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'border-border/70',
        className,
      )}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      <span className="whitespace-nowrap">{copied ? t('dlg.error.copied') : t('dlg.error.copyError')}</span>
    </button>
  )
}

// ------------------------------ detail block ------------------------------

/**
 * Full error panel for the detail dialog: summary strip on top, collapsible
 * terminal-styled technical dump below, copy button in the header row.
 * `message` is always copied in FULL (summary is just the display).
 */
export function ErrorDetailsBlock({ message, className }: { message: string; className?: string }) {
  const t = useT()
  const summary = summarizeError(message)
  const trimmed = message.replace(ANSI_RE, '').replace(/\r/g, '').trim()
  const hasMore = trimmed.length > summary.length + 8 || trimmed.includes('\n')
  const lineCount = trimmed ? trimmed.split('\n').length : 0

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-destructive/25',
        'bg-destructive/[0.04] dark:bg-destructive/10',
        className,
      )}
    >
      {/* Summary strip */}
      <div className="flex items-start gap-2.5 px-3.5 py-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
        <p className="min-w-0 flex-1 break-words text-sm font-medium leading-relaxed text-foreground/90">
          {summary || message}
        </p>
        <CopyErrorButton text={message} />
      </div>

      {/* Technical details — collapsible terminal block */}
      {hasMore && (
        <Collapsible>
          <CollapsibleTrigger
            className={cn(
              'group flex w-full items-center gap-1.5 border-t border-destructive/15 px-3.5 py-2',
              'text-xs font-medium text-muted-foreground transition-colors',
              'hover:bg-destructive/5 hover:text-foreground focus:outline-none focus-visible:ring-2',
              'focus-visible:ring-inset focus-visible:ring-ring',
            )}
          >
            <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200 group-data-[state=open]:rotate-180" aria-hidden />
            <span>{t('dlg.error.technical')}</span>
            <span className="ml-auto font-mono text-[10px] tabular-nums opacity-60">
              {lineCount} {lineCount === 1 ? 'line' : 'lines'}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre
              className={cn(
                'max-h-72 overflow-y-auto whitespace-pre-wrap break-all border-t border-destructive/15',
                'bg-zinc-950 px-3.5 py-3 font-mono text-[12px] leading-relaxed text-zinc-300',
                '[scrollbar-width:thin] [scrollbar-color:zinc-700_transparent]',
                '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
                '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700',
                '[&::-webkit-scrollbar-thumb:hover]:bg-zinc-600',
              )}
            >
              {trimmed}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}

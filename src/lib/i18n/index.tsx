'use client'

/**
 * Lightweight client-side i18n for the dashboard (task 17).
 *
 * - Two locales: 'en' (default / source of truth) and 'zh'.
 * - Flat dotted keys, merged from section files under ./dictionaries.
 * - Language preference is persisted in BOTH:
 *     · localStorage  (`dashboard-lang`)  — instant client read
 *     · a cookie      (`dash_lang`)      — read by the server layout so the
 *       first SSR render already uses the right language (no flash / mismatch)
 * - When no stored preference exists, the browser language decides
 *   (zh* → Chinese, everything else → English).
 * - `t(key, vars)` interpolates `{placeholders}`; unknown keys fall back to
 *   the English entry, then to the raw key.
 */

import * as React from 'react'
import { en } from './dictionaries/en'
import { zh } from './dictionaries/zh'
import { LANG_COOKIE, LANG_STORAGE_KEY, LANGUAGES } from './constants'

export type Lang = 'en' | 'zh'

export { LANG_COOKIE, LANG_STORAGE_KEY, LANGUAGES }

/** Literal keys of the English dictionary (autocompletes in editors). */
export type TranslationKey = keyof typeof en & string

/**
 * Accept both literal keys (autocomplete) and dynamically-built strings.
 * Dynamic keys simply skip compile-time verification but still resolve at
 * runtime with English fallback.
 */
export type TranslationLookup = TranslationKey | (string & {})

type Dictionary = Record<string, string>

const DICTS: Record<Lang, Dictionary> = { en, zh }

function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'zh'
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  )
}

export interface I18nContextValue {
  /** Currently active language. */
  lang: Lang
  /** Switch language (persists to localStorage + cookie, updates <html lang>). */
  setLang: (lang: Lang) => void
  /** Translate a key with optional `{var}` interpolation. */
  t: (key: TranslationLookup, vars?: Record<string, string | number>) => string
}

const I18nContext = React.createContext<I18nContextValue | null>(null)

export function useI18n(): I18nContextValue {
  const ctx = React.useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>')
  return ctx
}

/**
 * Convenience variant for leaf components that only need `t`
 * (avoids destructuring the whole context object).
 */
export function useT(): I18nContextValue['t'] {
  return useI18n().t
}

export function I18nProvider({
  initialLang = 'en',
  children,
}: {
  /** Server-side value read from the `dash_lang` cookie (layout.tsx). */
  initialLang?: Lang
  children: React.ReactNode
}) {
  const [lang, setLangState] = React.useState<Lang>(initialLang)
  const initialRef = React.useRef(initialLang)

  // Resolve the client-side preference once on mount:
  //   stored preference (storage → cookie) wins; otherwise detect from the
  //   browser language. Runs after hydration, so SSR output stays consistent.
  React.useEffect(() => {
    let stored: string | null = null
    try {
      stored = window.localStorage.getItem(LANG_STORAGE_KEY)
    } catch {
      /* storage unavailable */
    }
    const cookieMatch = typeof document !== 'undefined'
      ? document.cookie.split('; ').find((row) => row.startsWith(`${LANG_COOKIE}=`))
      : undefined
    const cookieLang = cookieMatch ? decodeURIComponent(cookieMatch.split('=').slice(1).join('=')) : null

    const preferred = isLang(stored) ? stored : isLang(cookieLang) ? cookieLang : null
    if (preferred) {
      if (preferred !== initialRef.current) setLangState(preferred)
      document.documentElement.lang = preferred === 'zh' ? 'zh-CN' : 'en'
      return
    }
    const nav = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en').toLowerCase()
    const detected: Lang = nav.startsWith('zh') ? 'zh' : 'en'
    if (detected !== initialRef.current) setLangState(detected)
    document.documentElement.lang = detected === 'zh' ? 'zh-CN' : 'en'
  }, [])

  const setLang = React.useCallback((next: Lang) => {
    setLangState(next)
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, next)
    } catch {
      /* storage unavailable — cookie channel still applies */
    }
    try {
      // 1 year, same-site lax — readable by the server layout on next visit.
      document.cookie = `${LANG_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`
    } catch {
      /* ignore */
    }
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en'
  }, [])

  const t = React.useCallback(
    (key: TranslationLookup, vars?: Record<string, string | number>) => {
      const k = key as string
      const template = DICTS[lang][k] ?? DICTS.en[k] ?? k
      return interpolate(template, vars)
    },
    [lang],
  )

  const value = React.useMemo<I18nContextValue>(() => ({ lang, setLang, t }), [lang, setLang, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/**
 * Shared i18n constants — plain module (no 'use client') so both server
 * components (layout.tsx) and client components can import the values.
 * Values imported from 'use client' modules into server components resolve
 * to client-reference proxies, not the actual strings.
 */
export const LANG_COOKIE = 'dash_lang'
export const LANG_STORAGE_KEY = 'dashboard-lang'
export const LANGUAGES: readonly ['en', 'zh'] = ['en', 'zh']

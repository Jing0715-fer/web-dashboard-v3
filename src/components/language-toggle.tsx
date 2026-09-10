'use client'

import * as React from 'react'
import { Globe, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useI18n, LANGUAGES, type Lang } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * Standalone language switcher (task 17).
 * Shown in the dashboard top bar (next to the theme toggle) and on the
 * login screen. This is the ONLY language control — there is deliberately
 * no language radio group inside the settings menu.
 *
 * Language names are always shown as endonyms: English / 中文.
 */
export function LanguageToggle({ className }: { className?: string }) {
  const { lang, setLang, t } = useI18n()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-language-toggle
          className={cn('relative', className)}
          title={t('lang.toggle')}
          aria-label={t('lang.toggle')}
        >
          <Globe className="h-4 w-4" />
          <span className="sr-only">{t('lang.toggle')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[150px] p-1.5 text-sm">
        <p className="px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">{t('lang.label')}</p>
        {LANGUAGES.map((code: Lang) => {
          const active = lang === code
          return (
            <DropdownMenuItem
              key={code}
              onClick={() => setLang(code)}
              aria-checked={active}
              className={cn(
                'px-2.5 py-2 text-sm rounded-md cursor-pointer',
                active && 'font-medium',
              )}
            >
              <span className="flex-1">{t(code === 'en' ? 'lang.en' : 'lang.zh')}</span>
              {active && <Check className="h-3.5 w-3.5 ml-2 text-brand-strong" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import './globals.css'
import { ThemeProvider } from '@/components/theme-provider'
import { I18nProvider, type Lang } from '@/lib/i18n'
import { LANG_COOKIE } from '@/lib/i18n/constants'

export const metadata: Metadata = {
  title: 'Web Dashboard',
  description: 'Manage your web applications',
}

// Apply saved accent color before first paint (same pattern next-themes uses for dark mode)
// to avoid a flash of the default accent. Mirrors ACCENT_PRESETS ids in theme-customizer.
const ACCENT_INIT = `(function(){try{var v=["emerald","teal","cyan","blue","violet","rose","orange","amber"];var a=localStorage.getItem("dashboard-accent");document.documentElement.setAttribute("data-accent",v.indexOf(a)>-1?a:"emerald")}catch(e){document.documentElement.setAttribute("data-accent","emerald")}})()`

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Read the language cookie server-side so the very first render already
  // uses the right locale (no English flash for Chinese users, no hydration
  // mismatch). Falls back to English; the client provider detects the
  // browser language when no cookie exists yet.
  const cookieStore = await cookies()
  const cookieLang = cookieStore.get(LANG_COOKIE)?.value
  const initialLang: Lang = cookieLang === 'zh' ? 'zh' : 'en'

  return (
    <html lang={initialLang === 'zh' ? 'zh-CN' : 'en'} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: ACCENT_INIT }} />
      </head>
      <body className="font-sans">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <I18nProvider initialLang={initialLang}>
            {children}
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}

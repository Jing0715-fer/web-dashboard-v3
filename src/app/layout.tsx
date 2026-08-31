import type { Metadata } from 'next'
import './globals.css'
import { ThemeProvider } from '@/components/theme-provider'

export const metadata: Metadata = {
  title: 'Web Dashboard',
  description: 'Manage your web applications',
}

// Apply saved accent color before first paint (same pattern next-themes uses for dark mode)
// to avoid a flash of the default accent. Mirrors ACCENT_PRESETS ids in theme-customizer.
const ACCENT_INIT = `(function(){try{var v=["emerald","teal","cyan","blue","violet","rose","orange","amber"];var a=localStorage.getItem("dashboard-accent");document.documentElement.setAttribute("data-accent",v.indexOf(a)>-1?a:"emerald")}catch(e){document.documentElement.setAttribute("data-accent","emerald")}})()`

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
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
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}

/**
 * Minimal user-agent parser (Task 19) — no external dependency.
 * Heuristic regexes covering the mainstream browsers/OSes; anything
 * unrecognized degrades gracefully to "Unknown".
 */

export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'unknown'

export interface ParsedUserAgent {
  browser: string
  os: string
  deviceType: DeviceType
}

const BROWSER_RULES: Array<[RegExp, string]> = [
  [/edg(?:e|a|ios)?\//i, 'Edge'],
  [/opr\/|opera/i, 'Opera'],
  [/samsungbrowser/i, 'Samsung Internet'],
  [/firefox|fxios/i, 'Firefox'],
  [/chrome|crios/i, 'Chrome'],
  [/safari/i, 'Safari'],
  [/curl\//i, 'curl'],
  [/node|undici/i, 'Node'],
  [/bun\//i, 'Bun'],
]

const OS_RULES: Array<[RegExp, string]> = [
  [/windows phone/i, 'Windows Phone'],
  [/(?:iphone|ipod).*os ([\d_]+)/i, 'iOS'],
  [/ipad.*os ([\d_]+)/i, 'iPadOS'],
  [/\bipad\b/i, 'iPadOS'],
  [/android[ /]?([\d.]+)?/i, 'Android'],
  [/windows nt 10/i, 'Windows 10/11'],
  [/windows nt ([\d.]+)/i, 'Windows'],
  [/mac os x|macintosh/i, 'macOS'],
  [/cros/i, 'ChromeOS'],
  [/ubuntu/i, 'Ubuntu'],
  [/linux/i, 'Linux'],
]

function firstMatch(rules: Array<[RegExp, string]>, ua: string): string | null {
  for (const [re, label] of rules) {
    const m = ua.match(re)
    if (m) {
      // Append the major version when the rule captured one (e.g. Chrome 126).
      const version = m[1] ? ` ${String(m[1]).split(/[._]/)[0]}` : ''
      return `${label}${version}`
    }
  }
  return null
}

export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
  if (!ua) return { browser: 'Unknown', os: 'Unknown', deviceType: 'unknown' }
  const browser = firstMatch(BROWSER_RULES, ua) ?? 'Unknown'
  const os = firstMatch(OS_RULES, ua) ?? 'Unknown'
  let deviceType: DeviceType = 'desktop'
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(ua)) deviceType = 'tablet'
  else if (/mobi|iphone|ipod|android.*mobile|windows phone/i.test(ua)) deviceType = 'mobile'
  else if (!/windows|macintosh|cros|linux|ubuntu/i.test(ua)) deviceType = 'unknown'
  return { browser, os, deviceType }
}

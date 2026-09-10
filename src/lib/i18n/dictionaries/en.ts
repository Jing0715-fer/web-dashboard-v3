import { common } from './en/common'
import { topbar } from './en/topbar'
import { login } from './en/login'
import { auth } from './en/auth'
import { dialogs } from './en/dialogs'
import { sessions } from './en/sessions'

/**
 * English dictionary (source of truth for keys).
 * Sections live in ./en/*.ts — new sections are imported here so
 * `keyof typeof en` picks up their literal keys. NOTE: section exports
 * must stay un-annotated (no `Record<string, string>`) to preserve
 * literal key inference.
 */
export const en = {
  ...common,
  ...topbar,
  ...login,
  ...auth,
  ...dialogs,
  ...sessions,
}

import type { en } from './en'
import { common } from './zh/common'
import { topbar } from './zh/topbar'
import { login } from './zh/login'
import { auth } from './zh/auth'
import { dialogs } from './zh/dialogs'
import { sessions } from './zh/sessions'

/**
 * Chinese dictionary — MUST cover every key of the English dictionary
 * (enforced by the Record<keyof typeof en, string> annotation below).
 * Sections live in ./zh/*.ts and mirror ./en/*.ts one-to-one.
 */
export const zh: Record<keyof typeof en, string> = {
  ...common,
  ...topbar,
  ...login,
  ...auth,
  ...dialogs,
  ...sessions,
}

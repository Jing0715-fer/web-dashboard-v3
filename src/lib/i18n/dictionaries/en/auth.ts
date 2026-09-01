/**
 * English dictionary — auth chrome: user menu, auth loading splash,
 * account status screen, change-password dialog (auth components are owned
 * by task 17/19; the dialog-heavy translations live in dialogs.ts instead).
 */
export const auth = {
  // ---- loading splash ----
  'auth.loading': 'Loading…',
  'auth.loadingSr': 'Loading',
  // ---- user menu ----
  'auth.menu.account': 'Account menu',
  'auth.menu.userManagement': 'User Management',
  'auth.menu.changePassword': 'Change Password',
  'auth.menu.signOut': 'Sign out',
  'auth.badge.admin': 'Admin',
  'auth.badge.google': 'Google',
  'auth.badge.email': 'Email',
  'auth.pendingBadge.aria': '{count} pending registrations',
  // ---- change-password dialog ----
  'auth.changePw.title': 'Change Password',
  'auth.changePw.desc': 'Set a new password for your account.',
  'auth.changePw.updated': 'Password updated',
  'auth.changePw.current': 'Current password',
  'auth.changePw.new': 'New password',
  'auth.changePw.confirm': 'Confirm new password',
  'auth.changePw.newPlaceholder': 'At least 8 characters',
  'auth.changePw.confirmPlaceholder': 'Repeat your new password',
  'auth.changePw.error.current': 'Enter your current password.',
  'auth.changePw.error.next': 'At least 8 characters, including a letter and a digit.',
  'auth.changePw.error.confirm': 'Passwords do not match.',
  'auth.changePw.error.incorrect': 'Current password is incorrect.',
  'auth.changePw.error.failed': 'Failed to update password.',
  'auth.changePw.submit': 'Update password',
  'auth.changePw.submitting': 'Updating…',
  // ---- account status screen ----
  'auth.viaGoogle': 'via Google',
  'auth.viaEmail': 'via email',
  'auth.status.pending.title': 'Awaiting approval',
  'auth.status.pending.desc': 'Your registration is being reviewed by an administrator — this page updates automatically.',
  'auth.status.rejected.title': 'Access rejected',
  'auth.status.rejected.desc': 'Your registration was not approved for this dashboard.',
  'auth.status.rejected.reason': 'Reason: ',
  'auth.status.rejected.help': 'Ask an administrator if you believe this is a mistake.',
}

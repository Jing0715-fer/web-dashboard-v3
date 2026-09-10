/**
 * English dictionary — session management UI (task 19 scope, main agent).
 */
export const sessions = {
  // ---- user-menu entry ----
  'sessions.menuLabel': 'Active Sessions',
  // ---- dialog ----
  'sessions.title': 'Active Sessions',
  'sessions.desc': 'Devices and browsers currently signed in. Revoke anything you don\'t recognize.',
  'sessions.myScope': 'My sessions',
  'sessions.allScope': 'All users',
  'sessions.adminHint': 'Admin view — shows every active session in the system.',
  'sessions.count': '{count} active',
  'sessions.empty': 'No other active sessions.',
  'sessions.emptyAll': 'No active sessions.',
  'sessions.current': 'Current',
  'sessions.currentHint': 'This is the session you are using right now.',
  // ---- session card ----
  'sessions.ip': 'IP',
  'sessions.lastActive': 'Last active',
  'sessions.created': 'Created',
  'sessions.expires': 'Expires',
  'sessions.remembered': 'Remembered for 30 days',
  'sessions.standard': 'Expires in 7 days',
  // ---- actions ----
  'sessions.revoke': 'Revoke',
  'sessions.revokeAll': 'Revoke all other sessions',
  'sessions.revokeAllTitle': 'Revoke all other sessions?',
  'sessions.revokeAllDesc': 'Every other signed-in device will be signed out immediately. This cannot be undone.',
  'sessions.revokeAllConfirm': 'Revoke all',
  'sessions.revoked': 'Session revoked',
  'sessions.revokedCount': 'Revoked {count} session(s)',
  'sessions.revokedSelf': 'Your session was revoked',
  'sessions.revokedSelfDesc': 'You are being signed out…',
  // ---- states ----
  'sessions.loadFailed': 'Failed to load sessions',
  'sessions.retry': 'Retry',
  'sessions.refresh': 'Refresh',
  // ---- device types ----
  'sessions.device.desktop': 'Desktop',
  'sessions.device.mobile': 'Mobile',
  'sessions.device.tablet': 'Tablet',
  'sessions.device.unknown': 'Unknown device',
}

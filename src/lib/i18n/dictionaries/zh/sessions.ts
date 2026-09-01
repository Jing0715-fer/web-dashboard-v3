/**
 * 中文词典 — 会话管理界面（任务 19 范围，主代理）。
 */
export const sessions = {
  // ---- 用户菜单入口 ----
  'sessions.menuLabel': '活动会话',
  // ---- 对话框 ----
  'sessions.title': '活动会话',
  'sessions.desc': '当前已登录的设备与浏览器。可撤销任何可疑会话。',
  'sessions.myScope': '我的会话',
  'sessions.allScope': '全部用户',
  'sessions.adminHint': '管理员视图 — 显示系统内所有活动会话。',
  'sessions.count': '{count} 个活跃',
  'sessions.empty': '没有其他活动会话。',
  'sessions.emptyAll': '暂无活动会话。',
  'sessions.current': '当前',
  'sessions.currentHint': '这是你当前正在使用的会话。',
  // ---- 会话卡片 ----
  'sessions.ip': 'IP',
  'sessions.lastActive': '最近活跃',
  'sessions.created': '创建于',
  'sessions.expires': '有效期至',
  'sessions.remembered': '记住登录（30 天）',
  'sessions.standard': '有效期 7 天',
  // ---- 操作 ----
  'sessions.revoke': '撤销',
  'sessions.revokeAll': '撤销其他所有会话',
  'sessions.revokeAllTitle': '撤销其他所有会话？',
  'sessions.revokeAllDesc': '其他已登录的设备将立即退出登录。此操作无法撤销。',
  'sessions.revokeAllConfirm': '全部撤销',
  'sessions.revoked': '已撤销该会话',
  'sessions.revokedCount': '已撤销 {count} 个会话',
  'sessions.revokedSelf': '你的会话已被撤销',
  'sessions.revokedSelfDesc': '正在退出登录…',
  // ---- 状态 ----
  'sessions.loadFailed': '加载会话失败',
  'sessions.retry': '重试',
  'sessions.refresh': '刷新',
  // ---- 设备类型 ----
  'sessions.device.desktop': '桌面设备',
  'sessions.device.mobile': '移动设备',
  'sessions.device.tablet': '平板设备',
  'sessions.device.unknown': '未知设备',
}

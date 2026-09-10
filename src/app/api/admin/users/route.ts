import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureBootstrap, requireAdmin, toAdminUser, approverNameMap, type UserRow } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/users  (admin only)
 *   → 200 { users: AdminUser[], pendingCount }
 * Sorted: pending first, then newest.
 */
export async function GET(req: Request) {
  try {
    await ensureBootstrap()
    const guard = await requireAdmin(req)
    if (guard.error) return guard.error

    const rows = (await db.user.findMany({ orderBy: { createdAt: 'desc' } })) as UserRow[]
    const pendingCount = rows.filter((u) => u.status === 'pending').length

    const names = await approverNameMap(rows)

    const sorted = [...rows].sort((a, b) => {
      const aPending = a.status === 'pending' ? 0 : 1
      const bPending = b.status === 'pending' ? 0 : 1
      if (aPending !== bPending) return aPending - bPending
      return b.createdAt.getTime() - a.createdAt.getTime()
    })

    return NextResponse.json({
      users: sorted.map((u) => toAdminUser(u, names)),
      pendingCount,
    })
  } catch (err) {
    console.error('[admin/users] failed:', err)
    return NextResponse.json({ error: 'Failed to list users' }, { status: 500 })
  }
}

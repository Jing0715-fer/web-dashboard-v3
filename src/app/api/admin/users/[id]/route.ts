import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity'
import { ensureBootstrap, requireAdmin, toAdminUser, approverNameMap, type UserRow } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/admin/users/[id]  body { action, reason?, role? }
 *   approve      → status approved + approvedAt/approvedById (session admin)
 *   reject       → status rejected + rejectionReason
 *   setRole      → role 'admin' | 'user' (guards: no self-demotion, no last-admin demotion)
 *   reactivate   → rejected user back to pending
 *   → 200 { user: AdminUser } | 400 { error } | 404 { error }
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap()
    const guard = await requireAdmin(req)
    if (guard.error) return guard.error
    const admin = guard.user

    const { id } = await ctx.params
    const target = (await db.user.findUnique({ where: { id } })) as UserRow | null
    if (!target) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const action = typeof body.action === 'string' ? body.action : ''

    if (action === 'approve') {
      const updated = (await db.user.update({
        where: { id },
        data: {
          status: 'approved',
          approvedAt: new Date(),
          approvedById: admin.id,
          rejectionReason: null,
        },
      })) as UserRow
      logActivity({
        type: 'user',
        level: 'success',
        message: `User '${updated.name}' approved`,
        detail: `by ${admin.name}`,
      })
      const names = await approverNameMap([updated])
      return NextResponse.json({ user: toAdminUser(updated, names) })
    }

    if (action === 'reject') {
      const rawReason = typeof body.reason === 'string' ? body.reason.trim() : ''
      const reason = rawReason.slice(0, 500) || null
      const updated = (await db.user.update({
        where: { id },
        data: { status: 'rejected', rejectionReason: reason },
      })) as UserRow
      logActivity({
        type: 'user',
        level: 'warn',
        message: `User '${updated.name}' rejected`,
        ...(reason ? { detail: reason } : {}),
      })
      const names = await approverNameMap([updated])
      return NextResponse.json({ user: toAdminUser(updated, names) })
    }

    if (action === 'setRole') {
      const role = body.role
      if (role !== 'admin' && role !== 'user') {
        return NextResponse.json({ error: "role must be 'admin' or 'user'" }, { status: 400 })
      }
      if (role === target.role) {
        const names = await approverNameMap([target])
        return NextResponse.json({ user: toAdminUser(target, names) })
      }
      if (role === 'user') {
        if (target.id === admin.id) {
          return NextResponse.json({ error: 'You cannot demote yourself' }, { status: 400 })
        }
        if (target.role === 'admin') {
          const adminCount = await db.user.count({ where: { role: 'admin' } })
          if (adminCount <= 1) {
            return NextResponse.json({ error: 'Cannot demote the last admin' }, { status: 400 })
          }
        }
      }
      const updated = (await db.user.update({ where: { id }, data: { role } })) as UserRow
      logActivity({
        type: 'user',
        level: 'info',
        message: `User '${updated.name}' role changed to ${role}`,
        detail: `by ${admin.name}`,
      })
      const names = await approverNameMap([updated])
      return NextResponse.json({ user: toAdminUser(updated, names) })
    }

    if (action === 'reactivate') {
      if (target.status !== 'rejected') {
        return NextResponse.json(
          { error: 'Only rejected users can be reactivated' },
          { status: 400 },
        )
      }
      const updated = (await db.user.update({
        where: { id },
        data: { status: 'pending', rejectionReason: null, approvedAt: null, approvedById: null },
      })) as UserRow
      logActivity({
        type: 'user',
        level: 'info',
        message: `User '${updated.name}' reactivated (awaiting approval)`,
        detail: `by ${admin.name}`,
      })
      const names = await approverNameMap([updated])
      return NextResponse.json({ user: toAdminUser(updated, names) })
    }

    return NextResponse.json(
      { error: "action must be 'approve' | 'reject' | 'setRole' | 'reactivate'" },
      { status: 400 },
    )
  } catch (err) {
    console.error('[admin/users/[id] PATCH] failed:', err)
    return NextResponse.json({ error: 'Failed to update user' }, { status: 500 })
  }
}

/**
 * DELETE /api/admin/users/[id]
 *   → 200 { ok: true } | 404 | 422 (self / last admin)
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap()
    const guard = await requireAdmin(req)
    if (guard.error) return guard.error
    const admin = guard.user

    const { id } = await ctx.params
    const target = await db.user.findUnique({ where: { id } })
    if (!target) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    if (target.id === admin.id) {
      return NextResponse.json({ error: 'You cannot delete your own account' }, { status: 422 })
    }
    if (target.role === 'admin') {
      const adminCount = await db.user.count({ where: { role: 'admin' } })
      if (adminCount <= 1) {
        return NextResponse.json({ error: 'Cannot delete the last admin' }, { status: 422 })
      }
    }

    await db.user.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[admin/users/[id] DELETE] failed:', err)
    return NextResponse.json({ error: 'Failed to delete user' }, { status: 500 })
  }
}

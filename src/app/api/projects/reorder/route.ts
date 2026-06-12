import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// POST /api/projects/reorder - Persist drag-and-drop order
// Body: { order: [{ id: string }, ...] }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const order: Array<{ id: string }> = Array.isArray(body?.order) ? body.order : []

    if (order.length === 0) {
      return NextResponse.json({ error: 'order array is required' }, { status: 400 })
    }

    // Validate ids are strings and look like cuids (no SQL injection)
    const ids = order
      .map((o) => (typeof o?.id === 'string' ? o.id : null))
      .filter((id): id is string => Boolean(id && /^[a-z0-9]{20,40}$/i.test(id)))

    if (ids.length === 0) {
      return NextResponse.json({ error: 'no valid ids in order array' }, { status: 400 })
    }

    // Apply order: 0, 1, 2, ... (small step) — fast in SQLite, stable for future reorders
    // Use a single transaction for atomicity
    await db.$transaction(
      ids.map((id, idx) =>
        db.project.update({
          where: { id },
          data: { order: idx },
          select: { id: true, order: true },
        })
      )
    )

    return NextResponse.json({ ok: true, count: ids.length })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

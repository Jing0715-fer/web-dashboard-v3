import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { computeOrganizePlan, type OrganizePlan, type DevicePlan } from '@/lib/port-organize';
import { proxyProjectAction } from '@/lib/route-decision';
import { logActivity } from '@/lib/activity';
import { requireApprovedUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/ports/organize — dry-run preview of the one-click port
 * reorganization (no writes). Same deterministic computation POST applies,
 * so what the user confirms is exactly what lands.
 *
 * Rule: dev envs get 3001, 3002, … (dashboard keeps 3000), prod = dev + 1000.
 * Minimal change: already-compliant assignments are locked and untouched.
 */
export async function GET(req: NextRequest) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const plan = await computeOrganizePlan();
    return NextResponse.json({ plan });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message || 'Failed to compute port plan' }, { status: 500 });
  }
}

/**
 * POST /api/ports/organize — apply the plan.
 *   • local envs: direct DB update
 *   • remote envs: proxied to the device agent (PUT environment { port }),
 *     then the local mirror row is updated so the UI reflects immediately
 * Failures are collected per change and reported — the rest still applies.
 */
export async function POST(req: NextRequest) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const plan: OrganizePlan = await computeOrganizePlan();
    const applied: DevicePlan['changes'] = [];
    const failures: Array<{ projectName: string; envName: string; error: string }> = [];

    for (const group of plan.groups) {
      for (const change of group.changes) {
        try {
          if (group.deviceId) {
            // Remote env — agent owns the row; partial PUT { port } is
            // supported (agent updates only provided fields).
            const result = await proxyProjectAction(
              group.deviceId,
              `/projects/${change.projectId}/environments/${change.envId}`,
              'PUT',
              { port: change.newPort },
            );
            if (!result.ok) {
              failures.push({ projectName: change.projectName, envName: change.envName, error: String(result.data?.error || `agent HTTP ${result.status}`) });
              continue;
            }
            // Update the local mirror row so port badges refresh instantly
            // (the agent heartbeat would reconcile it eventually anyway).
            await db.environment.update({
              where: { id: change.envId },
              data: { port: change.newPort },
            }).catch(() => undefined);
          } else {
            await db.environment.update({
              where: { id: change.envId },
              data: { port: change.newPort },
            });
          }
          applied.push(change);
        } catch (e: unknown) {
          failures.push({ projectName: change.projectName, envName: change.envName, error: (e as Error).message || 'update failed' });
        }
      }

      if (group.changes.length > 0) {
        const deviceLabel = group.deviceName || 'local';
        logActivity({
          type: 'config_change',
          level: 'info',
          message: `端口整理（${deviceLabel}）：${group.changes.length} 项变更`,
          detail: group.changes
            .map((c) => `${c.projectName}/${c.envName}: ${c.oldPort} → ${c.newPort}`)
            .slice(0, 20)
            .join(', '),
        });
      }
    }

    return NextResponse.json({
      ok: failures.length === 0,
      applied: applied.length,
      failed: failures,
      plan,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message || 'Failed to organize ports' }, { status: 500 });
  }
}

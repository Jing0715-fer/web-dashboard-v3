/**
 * One-click port organization ("整理端口").
 *
 * Goal — a tidy, collision-free port table per device:
 *   • dev  environments: 3001, 3002, … (dashboard keeps 3000 for itself)
 *   • prod environments: dev + 1000 (4001, 4002, …)
 *   • custom environments (staging etc.): kept as-is unless they collide,
 *     then re-homed above the dev sequence
 *
 * Minimal-change principle — an assignment that already satisfies the rule
 * is LOCKED and never touched. Only genuinely broken rows move:
 * duplicates, prod≠dev+1000, ports sitting in the infra band (3000/31xx),
 * or ports occupied by a foreign (non-dashboard) process.
 *
 * The plan is computed deterministically (project order → name → env age),
 * so the dry-run preview the user confirms is EXACTLY what POST applies.
 */

import { db } from '@/lib/db';
import { listListeningPorts } from '@/lib/ports';

// ============================== types ==============================

export type PortChangeReason =
  | 'conflict'   // port duplicated in DB
  | 'mispair'    // prod != dev + 1000
  | 'reserved'   // sits in the infra band (3000 / 3100-3199 / RESERVED_PORTS)
  | 'occupied'   // a foreign process is listening on it (local machine)
  | 'sequence';  // freshly slotted into the dev/prod sequence

export interface PortChange {
  envId: string;
  envName: string;
  projectId: string;
  projectName: string;
  kind: 'dev' | 'prod' | 'custom';
  oldPort: number;
  newPort: number;
  reason: PortChangeReason;
  /** Env currently running — the new port takes effect after restart. */
  running: boolean;
}

export interface DevicePlan {
  /** null → this machine (local projects). */
  deviceId: string | null;
  deviceName: string | null;
  changes: PortChange[];
  /** Projects whose ports already follow the rule — untouched. */
  keptProjects: Array<{ projectId: string; projectName: string; devPort: number | null; prodPort: number | null }>;
  warnings: string[];
}

export interface OrganizePlan {
  groups: DevicePlan[];
  stats: { devices: number; changed: number; kept: number };
}

// ============================== classification ==============================

const DEV_NAMES = new Set(['dev', 'development']);
const PROD_NAMES = new Set(['prod', 'production']);

const envKind = (name: string): 'dev' | 'prod' | 'custom' => {
  const n = (name || '').trim().toLowerCase();
  if (DEV_NAMES.has(n)) return 'dev';
  if (PROD_NAMES.has(n)) return 'prod';
  return 'custom';
};

const isValidPort = (p: number) => Number.isInteger(p) && p >= 1024 && p <= 65535;

// ============================== infra bands ==============================

/** Ports that must never hold a project env: the dashboard itself, agent /
 *  mini-service band, and operator-declared reserved ports. */
function infraReservedSet(): Set<number> {
  const set = new Set<number>([3000]);
  const p = parseInt(process.env.PORT || '', 10);
  if (Number.isFinite(p) && p > 0) set.add(p);
  for (const extra of (process.env.RESERVED_PORTS || '').split(',')) {
    const n = parseInt(extra.trim(), 10);
    if (Number.isFinite(n) && n > 0) set.add(n);
  }
  // 3100-3199: device agents + internal mini-services (llm-gateway, auto-iter…)
  for (let port = 3100; port <= 3199; port++) set.add(port);
  return set;
}

// ============================== plan computation ==============================

interface EnvRow {
  envId: string;
  envName: string;
  kind: 'dev' | 'prod' | 'custom';
  port: number;
  running: boolean;
  projectId: string;
  projectName: string;
  projectOrder: number;
}

interface ProjectPair {
  projectId: string;
  projectName: string;
  projectOrder: number;
  dev: EnvRow | null;
  prod: EnvRow | null;
  customs: EnvRow[];
}

/** Ports that satisfy the rule are locked; broken ones get a deterministic
 *  re-assignment. Pure function over the pre-fetched rows. */
function organizeDeviceGroup(
  rows: EnvRow[],
  opts: { infra: Set<number>; foreignListening: Set<number> },
): { changes: PortChange[]; keptProjects: DevicePlan['keptProjects']; warnings: string[] } {
  const { infra, foreignListening } = opts;
  const changes: PortChange[] = [];
  const warnings: string[] = [];

  // ---- group envs by project, classify pairs -------------------------------
  const pairs = new Map<string, ProjectPair>();
  for (const r of rows) {
    if (!pairs.has(r.projectId)) {
      pairs.set(r.projectId, {
        projectId: r.projectId, projectName: r.projectName, projectOrder: r.projectOrder,
        dev: null, prod: null, customs: [],
      });
    }
    const pair = pairs.get(r.projectId)!;
    if (r.kind === 'dev' && !pair.dev) pair.dev = r;
    else if (r.kind === 'prod' && !pair.prod) pair.prod = r;
    else pair.customs.push(r); // extra dev-like/prod-like envs behave as custom
  }

  // Port → how many envs in this group reference it in the DB (dup detection).
  const dbCount = new Map<number, number>();
  for (const r of rows) dbCount.set(r.port, (dbCount.get(r.port) || 0) + 1);

  // New-plan claims (locked ∪ assigned as we go). Guard against collisions.
  const claimed = new Map<number, string>();
  const claim = (port: number, envId: string) => { claimed.set(port, envId); };
  const free = (port: number, envId: string) => {
    if (claimed.get(port) === envId) claimed.delete(port);
  };

  // Soft reservations: every env's CURRENT port is skipped when handing out
  // fresh slots — the owner may keep it later (minimal change), so a
  // reassigned env must not squat on it first.
  const softReserved = new Map<number, string>();
  for (const r of rows) softReserved.set(r.port, r.envId);

  const canKeep = (r: EnvRow): PortChangeReason | null => {
    if (!isValidPort(r.port)) return 'sequence';
    if (infra.has(r.port)) return 'reserved';
    if (foreignListening.has(r.port)) return 'occupied';
    if (claimed.has(r.port) && claimed.get(r.port) !== r.envId) return 'conflict';
    return null; // keepable
  };

  /** Lowest free port ≥ start, skipping infra / foreign listeners / claims /
   *  other envs' current ports. When pairOffset > 0, port+pairOffset must be
   *  free by the same criteria too (dev/prod pairing) — slots owned by this
   *  pair's own prod env (pairOwnerId) are allowed. */
  const lowestFree = (start: number, envId: string, pairOffset = 0, pairOwnerId = ''): number => {
    const slotOk = (port: number, owner: string): boolean =>
      !infra.has(port)
      && !foreignListening.has(port)
      && (!claimed.has(port) || claimed.get(port) === owner)
      && (!softReserved.has(port) || softReserved.get(port) === owner);
    let port = start;
    for (;;) {
      if (slotOk(port, envId) && (pairOffset === 0 || slotOk(port + pairOffset, pairOwnerId || envId))) {
        return port;
      }
      if (port >= 65535) return 0; // unreachable in practice
      port++;
    }
  };

  // ---- phase A: lock rule-compliant pairs ----------------------------------
  // Compliant = dev port valid, unique in the whole group (no other env's
  // row references it), and prod (if present) == dev + 1000.
  const projectList = [...pairs.values()].sort(
    (a, b) => a.projectOrder - b.projectOrder || a.projectName.localeCompare(b.projectName),
  );
  const locked = new Set<string>(); // projectIds fully compliant
  for (const p of projectList) {
    const dev = p.dev;
    if (!dev || !isValidPort(dev.port) || infra.has(dev.port) || foreignListening.has(dev.port)) continue;
    if ((dbCount.get(dev.port) || 0) > 1) continue; // duplicated in DB
    if (p.prod && p.prod.port !== dev.port + 1000) continue;
    claim(dev.port, dev.envId);
    if (p.prod) claim(p.prod.port, p.prod.envId);
    for (const c of p.customs) {
      // customs of a compliant project: lock too when they don't clash
      if (isValidPort(c.port) && !infra.has(c.port) && !foreignListening.has(c.port)
        && !claimed.has(c.port) && (dbCount.get(c.port) || 0) === 1) {
        claim(c.port, c.envId);
      }
    }
    locked.add(p.projectId);
  }

  // ---- phase B: fix the remaining pairs (keep-first, then lowest free) -----
  const broken = projectList.filter((p) => !locked.has(p.projectId));
  // Deterministic: keep the smaller current dev port first (stable for dupes).
  broken.sort((a, b) => (a.dev?.port ?? 65536) - (b.dev?.port ?? 65536)
    || a.projectOrder - b.projectOrder
    || a.projectName.localeCompare(b.projectName));

  for (const p of broken) {
    const reasons = new Set<PortChangeReason>();
    let newDev: number | null = null;

    if (p.dev) {
      const keepReason = canKeep(p.dev);
      if (keepReason) reasons.add(keepReason);
      // prod side problems also flag the pair as broken
      if (p.prod && p.prod.port !== p.dev.port + 1000) reasons.add('mispair');
      if ((dbCount.get(p.dev.port) || 0) > 1) reasons.add('conflict');

      if (keepReason === null) {
        // dev slot is clean — KEEP it (minimal change). Only the prod side
        // moves, unless the paired slot (dev+1000) is already taken.
        const prodBlocked = p.prod
          && (infra.has(p.dev.port + 1000)
            || foreignListening.has(p.dev.port + 1000)
            || (claimed.has(p.dev.port + 1000) && claimed.get(p.dev.port + 1000) !== p.prod.envId)
            || (softReserved.has(p.dev.port + 1000) && softReserved.get(p.dev.port + 1000) !== p.prod.envId));
        if (!prodBlocked) newDev = p.dev.port;
      }
    }

    if (newDev == null && p.dev) {
      newDev = lowestFree(3001, p.dev.envId, p.prod ? 1000 : 0, p.prod?.envId ?? '');
    }

    // Apply dev
    if (p.dev && newDev) {
      if (newDev !== p.dev.port) {
        changes.push({
          envId: p.dev.envId, envName: p.dev.envName, projectId: p.projectId, projectName: p.projectName,
          kind: 'dev', oldPort: p.dev.port, newPort: newDev,
          reason: canKeep(p.dev) ?? 'sequence',
          running: p.dev.running,
        });
      }
      claim(newDev, p.dev.envId);
    }

    // Apply prod = dev + 1000 (or, for prod-only projects, the 4xxx sequence)
    if (p.prod) {
      const base = p.dev ? newDev : null;
      let newProd: number | null = null;
      if (base != null) {
        newProd = base + 1000;
      } else {
        // prod-only project: keep current port if clean, else lowest 4xxx slot
        const keepReason = canKeep(p.prod);
        newProd = keepReason === null ? p.prod.port : lowestFree(4001, p.prod.envId);
      }
      if (newProd && newProd !== p.prod.port) {
        changes.push({
          envId: p.prod.envId, envName: p.prod.envName, projectId: p.projectId, projectName: p.projectName,
          kind: 'prod', oldPort: p.prod.port, newPort: newProd,
          reason: base != null ? 'mispair' : 'sequence',
          running: p.prod.running,
        });
      }
      if (newProd) claim(newProd, p.prod.envId);
    }

    // Customs: move ONLY when they collide with the final table
    for (const c of p.customs) {
      const keepReason = canKeep(c);
      const dbDup = (dbCount.get(c.port) || 0) > 1;
      if (keepReason === null && !dbDup) { claim(c.port, c.envId); continue; }
      // release any self-claim from a lower round, then relocate
      free(c.port, c.envId);
      const slot = lowestFree(3001, c.envId);
      if (slot) {
        changes.push({
          envId: c.envId, envName: c.envName, projectId: p.projectId, projectName: p.projectName,
          kind: 'custom', oldPort: c.port, newPort: slot,
          reason: keepReason ?? 'conflict',
          running: c.running,
        });
        claim(slot, c.envId);
      } else {
        warnings.push(`No free port found for '${c.envName}' (${p.projectName})`);
      }
    }
  }

  // ---- leftover sanity check ----------------------------------------------
  const seen = new Map<number, string>();
  for (const r of rows) {
    const finalPort = changes.find((c) => c.envId === r.envId)?.newPort ?? r.port;
    const holder = seen.get(finalPort);
    if (holder && holder !== r.envId) {
      warnings.push(`Port ${finalPort} still shared by two environments`);
    }
    seen.set(finalPort, r.envId);
  }

  // "Kept" for display = projects whose envs ALL keep their ports — whether
  // they were locked in phase A (unambiguously compliant) or kept their ports
  // through phase B's keep-first path (e.g. one side of an old duplicate).
  const changedProjectIds = new Set(changes.map((c) => c.projectId));
  const keptAll: DevicePlan['keptProjects'] = [];
  for (const p of projectList) {
    if (changedProjectIds.has(p.projectId)) continue;
    if (!p.dev && !p.prod && p.customs.length === 0) continue;
    keptAll.push({
      projectId: p.projectId,
      projectName: p.projectName,
      devPort: p.dev?.port ?? null,
      prodPort: p.prod?.port ?? null,
    });
  }

  return { changes, keptProjects: keptAll, warnings };
}

// ============================== public API ==============================

/** Compute the full reorganization plan (no DB writes). Deterministic. */
export async function computeOrganizePlan(): Promise<OrganizePlan> {
  const envs = await db.environment.findMany({
    include: { project: { select: { id: true, name: true, deviceId: true, order: true } } },
    orderBy: { createdAt: 'asc' },
  });

  // Local-machine live state: ports held by processes that are NOT one of our
  // running local envs are foreign (another app) — never hand those out.
  const listening = await listListeningPorts().catch(() => []);
  const runningLocalPids = new Set<number>(
    envs.filter((e) => e.project.deviceId == null && e.pid != null).map((e) => e.pid as number),
  );
  const foreignListening = new Set<number>(
    listening.filter((l) => l.pid == null || !runningLocalPids.has(l.pid)).map((l) => l.port),
  );

  const infra = infraReservedSet();

  // Group rows per device (null = this machine). Remote projects are grouped
  // per device because port collisions only matter on the same host.
  const groups = new Map<string, EnvRow[]>();
  const deviceNames = new Map<string, string>();
  for (const e of envs) {
    const key = e.project.deviceId ?? 'local';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({
      envId: e.id,
      envName: e.name,
      kind: envKind(e.name),
      port: e.port,
      running: e.status === 'running',
      projectId: e.project.id,
      projectName: e.project.name,
      projectOrder: e.project.order,
    });
    if (e.project.deviceId) deviceNames.set(e.project.deviceId, '');
  }

  // Resolve device names for remote groups.
  const devices = await db.device.findMany({ select: { id: true, name: true } });
  for (const d of devices) deviceNames.set(d.id, d.name);

  const out: DevicePlan[] = [];
  for (const [key, rows] of groups) {
    const isLocal = key === 'local';
    const result = organizeDeviceGroup(rows, {
      infra,
      foreignListening: isLocal ? foreignListening : new Set<number>(), // no live view on remote hosts
    });
    out.push({
      deviceId: isLocal ? null : key,
      deviceName: isLocal ? null : deviceNames.get(key) || key,
      ...result,
    });
  }

  // Stable order: local first, then devices by name.
  out.sort((a, b) => (a.deviceId == null ? -1 : b.deviceId == null ? 1 : (a.deviceName || '').localeCompare(b.deviceName || '')));

  const changed = out.reduce((n, g) => n + g.changes.length, 0);
  const kept = out.reduce((n, g) => n + g.keptProjects.length, 0);
  return { groups: out, stats: { devices: out.length, changed, kept } };
}

import { Prisma, type PrismaClient } from '@prisma/client';
import { invalidateAlgoConfig } from '../algo/algo-config';
import { pointInPolygon } from '../../utils/geo';
import { runWithTenant } from '../../plugins/tenant-context';
import { AppError } from '../../utils/errors';
import type { OnAudit } from '../../lib/audit-writer';

// ---------------------------------------------------------------------------
// [RIDER-SAFE 5 · COORD ruling 29 Oct 2026] SWIFT'S DELIVERY PAUSE SWITCH.
//
// When riders run short across a whole area, operations needs one switch that
// stops new DELIVERY orders while pickup stays open — platform-wide, or in the
// zones that exist (the Zone table). The switch is an AlgoConfig key,
// `delivery.pause`, because that table already is what a switch needs: rows
// are immutable versions, so the history IS the record of who paused and who
// lifted it, and a version collision between two admins fails one of them
// instead of letting the later write silently undo the earlier.
//
// The read is never cached: a pause takes effect on every instance at the
// next checkout, not 30 seconds later. Each write also leaves an AuditLog row
// carrying the reason, inside the same transaction: through the admin route
// it is the route's own inline row (ADM-002) naming the new version row as
// its subject; a direct caller gets a DELIVERY_PAUSE_SET row.
//
// Fail-open on a READ failure, deliberately: a database hiccup while reading
// the switch must not stop every delivery in the country. The switch is an
// operator's tool, not a safety interlock.
// ---------------------------------------------------------------------------

export const DELIVERY_PAUSE_KEY = 'delivery.pause';

export interface DeliveryPauseState {
  platform: boolean;
  zoneIds: string[];
  version: number;
  updatedBy: string | null;
  updatedAt: Date | null;
}

function normalise(value: unknown): { platform: boolean; zoneIds: string[] } {
  const v = (value && typeof value === 'object' ? value : {}) as { platform?: unknown; zoneIds?: unknown };
  return {
    platform: v.platform === true,
    zoneIds: Array.isArray(v.zoneIds) ? [...new Set(v.zoneIds.filter((z): z is string => typeof z === 'string' && z.length > 0))] : [],
  };
}

/** The switch as it stands for one tenant, read fresh (no cache). */
export async function readDeliveryPause(prisma: PrismaClient, tenantId: string): Promise<DeliveryPauseState> {
  const row = await runWithTenant(tenantId, () => prisma.algoConfig.findFirst({
    where: { tenantId, key: DELIVERY_PAUSE_KEY },
    orderBy: { version: 'desc' },
    select: { value: true, version: true, updatedBy: true, updatedAt: true },
  }));
  if (!row) return { platform: false, zoneIds: [], version: 0, updatedBy: null, updatedAt: null };
  return { ...normalise(row.value), version: row.version, updatedBy: row.updatedBy, updatedAt: row.updatedAt };
}

/**
 * Is delivery from this point paused? Platform-wide, or the point lies inside
 * a paused zone of this tenant. A read failure answers "not paused" (above).
 */
export async function deliveryPausedAt(
  prisma: PrismaClient,
  tenantId: string,
  point: { lat: number; lng: number },
): Promise<{ paused: boolean; scope: 'PLATFORM' | 'ZONE' | null; zoneName: string | null }> {
  try {
    const state = await readDeliveryPause(prisma, tenantId);
    if (state.platform) return { paused: true, scope: 'PLATFORM', zoneName: null };
    if (state.zoneIds.length === 0) return { paused: false, scope: null, zoneName: null };
    const zones = await runWithTenant(tenantId, () => prisma.zone.findMany({
      where: { id: { in: state.zoneIds }, tenantId },
      select: { id: true, name: true, boundary: true },
    }));
    const hit = zones.find((z) => pointInPolygon(point, z.boundary));
    return hit ? { paused: true, scope: 'ZONE', zoneName: hit.name } : { paused: false, scope: null, zoneName: null };
  } catch {
    return { paused: false, scope: null, zoneName: null };
  }
}

/**
 * Write the switch: a new version row + an audit row, in one transaction. A
 * zone id that is not this tenant's zone is refused. `expectedVersion` (when
 * given) must be the version the admin's screen showed: a stale screen cannot
 * overwrite a newer decision.
 */
export async function setDeliveryPause(
  prisma: PrismaClient,
  input: {
    tenantId: string; platform: boolean; zoneIds: string[]; actorUserId: string; reason: string; expectedVersion?: number;
    /** [ADM-004] The admin route's inline audit writer. Called inside the
     *  transaction, after the new version row; a refused audit row rolls the
     *  switch back. Absent: this helper writes its own DELIVERY_PAUSE_SET row. */
    onAudit?: OnAudit;
  },
): Promise<DeliveryPauseState> {
  const next = normalise({ platform: input.platform, zoneIds: input.zoneIds });
  if (next.zoneIds.length > 0) {
    const found = await prisma.zone.count({ where: { id: { in: next.zoneIds }, tenantId: input.tenantId } });
    if (found !== next.zoneIds.length) throw new AppError(400, 'UNKNOWN_ZONE', 'One of those zones does not exist.');
  }
  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.algoConfig.findFirst({
        where: { tenantId: input.tenantId, key: DELIVERY_PAUSE_KEY },
        orderBy: { version: 'desc' },
        select: { version: true, value: true },
      });
      const currentVersion = current?.version ?? 0;
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
        throw new AppError(409, 'PAUSE_CHANGED', 'Someone else changed the delivery pause. Refresh and try again.');
      }
      const created = await tx.algoConfig.create({
        data: { tenantId: input.tenantId, key: DELIVERY_PAUSE_KEY, value: next, version: currentVersion + 1, founderGated: false, updatedBy: input.actorUserId },
        select: { id: true },
      });
      const from = normalise(current?.value ?? null);
      if (input.onAudit) {
        // The subject is the version row this write created (versions are
        // never updated, so there is no "before" row to digest): its id, the
        // version, and both sides of the switch, as scalar facts.
        await input.onAudit(tx, {
          versionRowId: created.id,
          configKey: DELIVERY_PAUSE_KEY,
          version: currentVersion + 1,
          fromPlatform: from.platform,
          toPlatform: next.platform,
          fromZoneIds: from.zoneIds.join(','),
          toZoneIds: next.zoneIds.join(','),
        });
      } else {
        await tx.auditLog.create({
          data: {
            userId: input.actorUserId,
            action: 'DELIVERY_PAUSE_SET',
            entity: 'algo_config',
            entityId: `${input.tenantId}:${DELIVERY_PAUSE_KEY}`,
            changes: { from, to: next, version: currentVersion + 1, versionRowId: created.id, reason: input.reason },
          },
        });
      }
    });
  } catch (err) {
    // Two admins at the same instant: the unique (tenant, key, version) row decides.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(409, 'PAUSE_CHANGED', 'Someone else changed the delivery pause. Refresh and try again.');
    }
    throw err;
  }
  invalidateAlgoConfig(input.tenantId, DELIVERY_PAUSE_KEY);
  return readDeliveryPause(prisma, input.tenantId);
}

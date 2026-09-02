import type { PrismaClient } from '@prisma/client';
import { pointInPolygon, polygonArea, polygonsOverlap, type GeoPoint } from '../../utils/geo';
import { AppError } from '../../utils/errors';
import { fareZoneCounter, fareZoneGauge } from '../../plugins/observability';

/**
 * [M-34] Fare zones are one operator's, in one market — and precedence is
 * deterministic.
 *
 * Stop-ship register M-34: the fare service read EVERY active zone and took
 * the first polygon containing each end, so another market's overlapping
 * coordinates, or two local zones overlapping, could price a trip at the
 * wrong fixed fare — or the wrong currency — depending on row order. Now:
 *
 *   - candidates are the requester's tenant's active zones in the requester's
 *     country, and nothing else (the table is also inside the tenant wall);
 *   - among candidates the highest priority wins; among equals the smallest
 *     polygon, then the id — the same answer on every call;
 *   - equal-priority overlap is refused when a zone is written, and counted
 *     when it exists anyway (the scan pages it);
 *   - the legacy pick (first match in row order) is computed alongside as a
 *     shadow, and every disagreement is counted;
 *   - FARE_ZONE_TABLE_KILL=1 ignores the table: every ride prices by the
 *     country formula — the rollback.
 */
export const DEFAULT_TENANT_ID = 'swift-default';

export interface ZoneMarket {
  tenantId: string;
  countryCode: string;
}

export interface ZoneCandidate {
  id: string;
  name: string;
  boundary: unknown;
  priority: number;
  version: number;
}

export interface ZonePick {
  zone: ZoneCandidate | null;
  /** More than one candidate at the winning priority — the tie-break decided. */
  ambiguous: boolean;
  contenders: number;
}

/** The precedence law, pure: priority desc, then area asc, then id asc. */
export function pickZone(candidates: readonly ZoneCandidate[]): ZonePick {
  if (candidates.length === 0) return { zone: null, ambiguous: false, contenders: 0 };
  const top = Math.max(...candidates.map((c) => c.priority));
  const atTop = candidates.filter((c) => c.priority === top);
  const ranked = [...atTop].sort((a, b) => polygonArea(a.boundary) - polygonArea(b.boundary) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { zone: ranked[0] ?? null, ambiguous: atTop.length > 1, contenders: candidates.length };
}

export function fareZoneTableKilled(env: Record<string, string | undefined> = process.env): boolean {
  return env['FARE_ZONE_TABLE_KILL'] === '1';
}

export interface ResolvedZones {
  from: ZonePick;
  to: ZonePick;
  killed: boolean;
}

/** Both ends of a trip, resolved inside ONE market with the precedence law;
 *  the legacy first-match pick is shadowed and disagreements counted. */
export async function resolveFareZones(prisma: PrismaClient, market: ZoneMarket, pickup: GeoPoint, dropoff: GeoPoint): Promise<ResolvedZones> {
  if (fareZoneTableKilled()) {
    fareZoneCounter.labels('killed').inc();
    return { from: { zone: null, ambiguous: false, contenders: 0 }, to: { zone: null, ambiguous: false, contenders: 0 }, killed: true };
  }
  const rows = await prisma.zone.findMany({
    where: { isActive: true, tenantId: market.tenantId, countryCode: market.countryCode },
    select: { id: true, name: true, boundary: true, priority: true, version: true },
  });
  const resolve = (point: GeoPoint, end: 'from' | 'to'): ZonePick => {
    const containing = rows.filter((z) => pointInPolygon(point, z.boundary));
    const pick = pickZone(containing);
    if (pick.ambiguous) fareZoneCounter.labels('ambiguous').inc();
    // The shadow: what the old "first active match" would have chosen inside
    // this market. (Across markets it could choose a foreign zone — that pick
    // is no longer even a candidate.)
    const legacy = containing[0] ?? null;
    if ((legacy?.id ?? null) !== (pick.zone?.id ?? null)) fareZoneCounter.labels(`shadow_diff_${end}`).inc();
    return pick;
  };
  return { from: resolve(pickup, 'from'), to: resolve(dropoff, 'to'), killed: false };
}

/** [M-34] The write-time law: an ACTIVE zone may not overlap another active
 *  zone of the same market at the same priority. Throws 409 ZONE_OVERLAP
 *  naming the zone it collides with. */
export async function assertNoZoneOverlap(
  prisma: PrismaClient,
  zone: { tenantId: string; countryCode: string; priority: number; boundary: unknown; isActive: boolean },
  excludeId?: string,
): Promise<void> {
  if (!zone.isActive) return;
  const peers = await prisma.zone.findMany({
    where: { isActive: true, tenantId: zone.tenantId, countryCode: zone.countryCode, priority: zone.priority, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, name: true, boundary: true },
  });
  const hit = peers.find((p) => polygonsOverlap(p.boundary, zone.boundary));
  if (hit) {
    throw new AppError(409, 'ZONE_OVERLAP', `This zone overlaps "${hit.name}" at the same priority (${zone.priority}). Give one of them a different priority, or redraw it.`, { overlaps: hit.id, priority: zone.priority });
  }
}

export interface FareZoneScan {
  /** Pairs of active zones in one market that overlap at the same priority. */
  ambiguousPairs: Array<{ tenantId: string; countryCode: string; a: string; b: string; priority: number }>;
}

/** [M-34 · operations] Quarantine ambiguity: every equal-priority overlap
 *  inside a market, published and paged. Pricing already resolves them
 *  deterministically; a person decides which zone keeps the kerb. */
export async function scanFareZones(prisma: PrismaClient): Promise<FareZoneScan> {
  const zones = await prisma.zone.findMany({ where: { isActive: true }, select: { id: true, tenantId: true, countryCode: true, priority: true, boundary: true } });
  const ambiguousPairs: FareZoneScan['ambiguousPairs'] = [];
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const a = zones[i]!; const b = zones[j]!;
      if (a.tenantId !== b.tenantId || a.countryCode !== b.countryCode || a.priority !== b.priority) continue;
      if (polygonsOverlap(a.boundary, b.boundary)) ambiguousPairs.push({ tenantId: a.tenantId, countryCode: a.countryCode, a: a.id, b: b.id, priority: a.priority });
    }
  }
  fareZoneGauge.labels('ambiguous_pairs').set(ambiguousPairs.length);
  return { ambiguousPairs };
}

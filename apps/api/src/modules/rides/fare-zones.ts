import type { PrismaClient } from '@prisma/client';
import { pointInPolygon, polygonArea, polygonsOverlap, type GeoPoint } from '../../utils/geo';
import { AppError } from '../../utils/errors';
import { PRICE_OUTLIER_CEILING } from '../country/pricing-config';
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
  /** [ZONE-FARES] The zone's own taxi per-km rate (a Prisma Decimal from the
   *  database), or null/absent when it sets none. */
  taxiPerKm?: { toString(): string } | number | null;
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

export interface ResolvedZonePath {
  /** One pick per point, in the order the points were given. */
  picks: ZonePick[];
  killed: boolean;
}

/** Every point of a trip (the pickup, [TAXI multi-stop] each stop in order,
 *  the destination), resolved from ONE read of ONE market with the
 *  precedence law; the legacy first-match pick is shadowed and disagreements
 *  counted (the first point as from, the last as to, any between as stop). */
export async function resolveFareZonePath(prisma: PrismaClient, market: ZoneMarket, points: readonly GeoPoint[]): Promise<ResolvedZonePath> {
  if (fareZoneTableKilled()) {
    fareZoneCounter.labels('killed').inc();
    return { picks: points.map(() => ({ zone: null, ambiguous: false, contenders: 0 })), killed: true };
  }
  const rows = await prisma.zone.findMany({
    where: { isActive: true, tenantId: market.tenantId, countryCode: market.countryCode },
    select: { id: true, name: true, boundary: true, priority: true, version: true, taxiPerKm: true },
  });
  const resolve = (point: GeoPoint, end: 'from' | 'to' | 'stop'): ZonePick => {
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
  const last = points.length - 1;
  return { picks: points.map((point, i) => resolve(point, i === 0 ? 'from' : i === last ? 'to' : 'stop')), killed: false };
}

/** Both ends of a trip: the two-point path. */
export async function resolveFareZones(prisma: PrismaClient, market: ZoneMarket, pickup: GeoPoint, dropoff: GeoPoint): Promise<ResolvedZones> {
  const { picks, killed } = await resolveFareZonePath(prisma, market, [pickup, dropoff]);
  return { from: picks[0]!, to: picks[1]!, killed };
}

/** [ZONE-FARES] A zone's own taxi per-km rate as a number, or null when it
 *  sets none. The column is CHECKed whole and positive at the database, so
 *  anything else cannot be stored; it would read as no rate, never as a price. */
export function zonePerKmOf(zone: ZoneCandidate | null | undefined): number | null {
  const raw = zone?.taxiPerKm;
  if (raw === null || raw === undefined) return null;
  const rate = Number(raw.toString());
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * [ZONE-FARES] The per-km rate a trip's ENDS set: the pickup's zone rate or
 * the dropoff's, the HIGHER of the two when both set one, or null when neither
 * does (the market's own per-km applies). Only the ends count — the zones the
 * precedence law picked for the pickup and the destination — so a stop on the
 * way never sets it. With the table killed nothing resolves, so nothing is
 * overridden: every ride prices by the market's formula, exactly as today.
 */
export function zoneTaxiPerKm(from: ZonePick, to: ZonePick): number | null {
  const rates = [zonePerKmOf(from.zone), zonePerKmOf(to.zone)].filter((rate): rate is number => rate !== null);
  return rates.length === 0 ? null : Math.max(...rates);
}

/** [TAXI multi-stop] A pair of points of a route that the zone table prices:
 *  indexes into the points, and the two zones. */
export interface ZonePricedPair {
  from: number;
  to: number;
  fromZoneId: string;
  toZoneId: string;
}

/** [TAXI multi-stop] Every pair of a route the zone table would price: each
 *  leg in order (pickup to stop 1 through the last stop to the destination),
 *  then the direct pickup to destination pair. A route with stops is priced
 *  by the formula over the whole road, so v1 refuses one the table prices
 *  anywhere, rather than let a stop move a trip off (or onto) a fixed fare.
 *  One zone read and one fare read. With the table killed nothing resolves,
 *  so nothing is priced by it: the answer is empty, exactly as today.
 *  [ZONE-FARES] A caller that already resolved these points passes its path,
 *  so the zones are read once. */
export async function zonePricedPairs(prisma: PrismaClient, market: ZoneMarket, points: readonly GeoPoint[], path?: ResolvedZonePath): Promise<ZonePricedPair[]> {
  const { picks } = path ?? await resolveFareZonePath(prisma, market, points);
  const last = points.length - 1;
  const pairs: Array<[number, number]> = [];
  for (let i = 1; i <= last; i++) pairs.push([i - 1, i]);
  if (last > 1) pairs.push([0, last]);
  const zoned: ZonePricedPair[] = [];
  for (const [from, to] of pairs) {
    const fromZone = picks[from]?.zone;
    const toZone = picks[to]?.zone;
    if (fromZone && toZone) zoned.push({ from, to, fromZoneId: fromZone.id, toZoneId: toZone.id });
  }
  if (zoned.length === 0) return [];
  const fares = await prisma.zoneFare.findMany({
    where: { OR: zoned.map((p) => ({ fromZoneId: p.fromZoneId, toZoneId: p.toZoneId })) },
    select: { fromZoneId: true, toZoneId: true },
  });
  const priced = new Set(fares.map((f) => JSON.stringify([f.fromZoneId, f.toZoneId])));
  return zoned.filter((p) => priced.has(JSON.stringify([p.fromZoneId, p.toZoneId])));
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

// ---------------------------------------------------------------------------
// [ZONE-FARES] The write-time bounds of zone pricing, in whole units of the
// market's currency (GYD today). The admin routes refuse anything outside
// them; the fare engine reads only what they let through.
// ---------------------------------------------------------------------------

/** A fixed fare is at least the formula's own rounding unit (formulaFare
 *  rounds every fare to 100) and at most the line the fare engine already
 *  counts as an outlier: a single fare above it is never real. */
export const ZONE_FARE_MIN = 100;
export const ZONE_FARE_MAX = PRICE_OUTLIER_CEILING;

/** A zone's per-km rate: positive (null, not 0, is "no rate"), and at most
 *  10,000 a kilometre — more than fifty times the national rate. */
export const ZONE_TAXI_PER_KM_MIN = 1;
export const ZONE_TAXI_PER_KM_MAX = 10_000;

/** A zone id an admin may choose: a lowercase slug, the shape the seeded zones
 *  carry (`georgetown-central`, `cjia-airport`), so a zone drawn by hand on an
 *  existing install can be the very row a fresh install's seed creates. */
export const ZONE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const ZONE_ID_MIN = 3;
export const ZONE_ID_MAX = 48;

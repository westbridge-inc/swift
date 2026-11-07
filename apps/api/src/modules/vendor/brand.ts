import type { Prisma, PrismaClient } from '@prisma/client';
import { estimateDrivingDistance } from '../../utils/distance';

// ---------------------------------------------------------------------------
// [CHAINS PR3 · owner 29 Oct 2026] "One brand card ('Royal Castle') opening the nearest open branch that delivers to
// them; customer can pick another branch."
//
// A brand is an owner whose name Swift set (VendorOwner.brandName, by a person, with a reason). On every customer list
// that shows stores, a brand's branches collapse into ONE card: the branch that card opens is chosen by
//   1. open and taking orders, and delivers to where the customer is (its own delivery radius, the cart's own rule);
//   2. else open and taking orders (the nearest, when the customer's place is known);
//   3. else the nearest (or, without a place, the list's own first).
// The card says the brand's name and how many of its branches the list holds. A branch Swift lists on its own
// (Vendor.brandListedAlone, admin "split") keeps its own card. Nothing here widens what a list may show: grouping runs
// over the rows the list already chose (its visibility, prohibited-store and tenant rules); it only removes repeats.
// The storefront lists the brand's other branches the customer may switch to, under the same visibility rule.
// ---------------------------------------------------------------------------

type Db = PrismaClient | Prisma.TransactionClient;

/** The furthest a store delivers when it set no radius of its own: the cart's reach gate and the brand card share it. */
export const MAX_DELIVERY_RADIUS_KM = 25;

type Row = {
  id: string; isCurrentlyOpen: boolean; acceptingOrders: boolean; latitude: number; longitude: number;
  deliveryRadius?: number | null;
};
/** A branch of a brand: its brand (owner and name) and, read from the store row itself, what ranks it. */
export type BrandFact = { ownerId: string; name: string; row: Row };
export type BrandCard = { name: string; branches: number } | null;

/** The brand each of these stores belongs to (absent: no brand, or listed on its own). */
export async function brandFactsFor(db: Db, vendorIds: readonly string[]): Promise<Map<string, BrandFact>> {
  const out = new Map<string, BrandFact>();
  if (vendorIds.length === 0) return out;
  const rows = await db.vendor.findMany({
    where: { id: { in: [...new Set(vendorIds)] }, brandListedAlone: false, owner: { brandName: { not: null } } },
    select: {
      id: true, ownerId: true, owner: { select: { brandName: true } },
      isCurrentlyOpen: true, acceptingOrders: true, latitude: true, longitude: true, deliveryRadius: true,
    },
  });
  for (const r of rows) {
    if (!r.owner.brandName) continue;
    const { owner, ownerId, ...row } = r;
    out.set(r.id, { ownerId, name: owner.brandName!, row });
  }
  return out;
}

type Point = { lat?: number | null; lng?: number | null };

const exactKm = (row: Row, point: Point): number | null =>
  point.lat == null || point.lng == null ? null : estimateDrivingDistance(point.lat, point.lng, row.latitude, row.longitude);

/** Whether this branch delivers to the customer's place (the cart's own reach rule). Unknown place: null. */
export function deliversTo(row: Row, point: Point): boolean | null {
  const km = exactKm(row, point);
  if (km === null) return null;
  return km <= (row.deliveryRadius || MAX_DELIVERY_RADIUS_KM);
}

/** The order in which a brand's branches are offered: delivers + orderable, orderable, then nearest. */
export function branchRank(row: Row, point: Point): [number, number] {
  const orderable = row.isCurrentlyOpen && row.acceptingOrders;
  const delivers = deliversTo(row, point) === true;
  const tier = orderable && delivers ? 0 : orderable ? 1 : 2;
  return [tier, exactKm(row, point) ?? Number.POSITIVE_INFINITY];
}

const better = (a: [number, number], b: [number, number]) => a[0] - b[0] || a[1] - b[1];

/**
 * One card per brand, in the list's own order: each brand appears once, where its first branch appeared, as the
 * branch it should open (branchRank; ties keep the list's own order). Every row carries `brand` (null for a store
 * with no brand).
 */
export function collapseBrands<T extends { id: string }>(rows: readonly T[], facts: Map<string, BrandFact>, point: Point): Array<T & { brand: BrandCard }> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const fact = facts.get(row.id);
    if (!fact) continue;
    groups.set(fact.ownerId, [...(groups.get(fact.ownerId) ?? []), row]);
  }
  const chosen = new Map<string, T>();
  for (const [ownerId, members] of groups) {
    let best = members[0]!;
    const rank = (m: T) => branchRank(facts.get(m.id)!.row, point);
    for (const m of members.slice(1)) if (better(rank(m), rank(best)) < 0) best = m;
    chosen.set(ownerId, best);
  }
  const out: Array<T & { brand: BrandCard }> = [];
  const placed = new Set<string>();
  for (const row of rows) {
    const fact = facts.get(row.id);
    if (!fact) { out.push({ ...row, brand: null }); continue; }
    if (placed.has(fact.ownerId)) continue;
    placed.add(fact.ownerId);
    out.push({ ...chosen.get(fact.ownerId)!, brand: { name: fact.name, branches: groups.get(fact.ownerId)!.length } });
  }
  return out;
}

export type BrandBranch = {
  id: string; name: string; slug: string; addressLine1: string; city: string;
  isCurrentlyOpen: boolean; acceptingOrders: boolean; distanceKm: number | null; delivers: boolean | null; current: boolean;
};

/**
 * The storefront's branch switcher: when this store belongs to a brand (and is not listed on its own), the brand's
 * name and every branch the customer may see (`visible`: the caller's own list rule, tenant included), the best for
 * them first (branchRank). Null when the store has no brand.
 */
export async function brandBranchesFor(
  db: Db, vendorId: string, point: Point, visible: Prisma.VendorWhereInput,
): Promise<{ name: string; branches: BrandBranch[] } | null> {
  const store = await db.vendor.findUnique({ where: { id: vendorId }, select: { ownerId: true, brandListedAlone: true, owner: { select: { brandName: true } } } });
  const name = store?.owner.brandName;
  if (!store || !name || store.brandListedAlone) return null;
  const rows = await db.vendor.findMany({
    where: { AND: [visible, { ownerId: store.ownerId, brandListedAlone: false }] },
    select: { id: true, name: true, slug: true, addressLine1: true, city: true, isCurrentlyOpen: true, acceptingOrders: true, latitude: true, longitude: true, deliveryRadius: true },
    take: 60,
  });
  const ranked = rows
    .map((r, i) => ({ r, i, rank: branchRank(r, point) }))
    .sort((a, b) => better(a.rank, b.rank) || a.i - b.i)
    .map(({ r }) => {
      const km = exactKm(r, point);
      return {
        id: r.id, name: r.name, slug: r.slug, addressLine1: r.addressLine1, city: r.city,
        isCurrentlyOpen: r.isCurrentlyOpen, acceptingOrders: r.acceptingOrders,
        distanceKm: km === null ? null : Math.round(km * 10) / 10, delivers: deliversTo(r, point), current: r.id === vendorId,
      };
    });
  return { name, branches: ranked };
}

/** [CHAINS PR3] A chain sells the same dish at every branch: a list of dishes (the Home "popular" rail) shows each of a
 *  brand's dishes once, the first (most-ordered) one, matched by name. Dishes of stores with no brand are untouched. */
export function oneDishPerBrand<T extends { vendorId: string; name: string }>(items: readonly T[], facts: Map<string, BrandFact>): T[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    const fact = facts.get(it.vendorId);
    if (!fact) return true;
    const key = `${fact.ownerId}\u0000${it.name.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

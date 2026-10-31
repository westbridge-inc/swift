import { goodsSizeCarriableToday } from '../config/vehicle-classes';

/** Rough bag-size heuristic a mover can judge an offer by (spec §7):
 *  total units across all lines → small / medium / large. */
export function estimateLoad(totalUnits: number): 'small' | 'medium' | 'large' {
  if (totalUnits <= 3) return 'small';
  if (totalUnits <= 10) return 'medium';
  return 'large';
}

// ---------------------------------------------------------------------------
// [G1] The size of vehicle a NON-COURIER order actually needs.
//
// `estimateLoad` above is a DISPLAY badge and stays exactly as it is — the
// item-count half of the offer card's `estLoad` (see `offerEstLoad`, which also
// counts bulk), consumed by nothing in dispatch. It gates nothing and is not
// being made to.
//
// The defect it sits next to: vehicle capability is filtered on
// `courierPackageSize`, which is written in exactly ONE place
// (`courier.routes.ts:173`). Food and grocery orders never set it, and at
// `dispatch.service.ts:550` a null packageSize makes the vehicle clause
// `Prisma.empty` — the filter is not relaxed, it is NOT EMITTED. So the two
// highest-volume verticals have no capacity gate at all, and a 40-item
// supermarket run can be offered to and accepted by a bicycle.
//
// In a cash model that is the worst place to fail: the vendor has already
// packed the order and the rider has already paid for it out of their own
// float before anyone discovers it will not fit.
//
// THIS DERIVES A `PackageSize`. It deliberately mints no second taxonomy —
// `PackageSize` and `VEHICLE_CLASSES.maxPackageSize` already exist, already
// work, and already protect courier. Feeding a derived value into the filter
// that is already there is the whole design.
// ---------------------------------------------------------------------------

export type PackageSizeName = 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE';

/** How much room ONE unit of an item takes, relative to an ordinary one. A
 *  sachet is 1; a 20 kg bag of rice is nearer 8. Unset means ordinary — every
 *  item that predates the column keeps behaving exactly as it does today. */
export const DEFAULT_BULK_UNITS = 1;

export interface LoadBands {
  /** Highest bulk total still carryable as SMALL. */
  small: number;
  /** …as MEDIUM. */
  medium: number;
  /** …as LARGE. Above this is EXTRA_LARGE. */
  large: number;
}

/**
 * Founder-confirmable defaults. Deliberately GENEROUS at the bottom: the cost
 * of banding an order too small is a rider who cannot carry it, but the cost of
 * banding it too large is an order that finds no rider at all and nobody is
 * paged. The first failure is visible; the second is silent, so the defaults
 * lean toward the visible one until shadow evidence says otherwise.
 */
export const DEFAULT_LOAD_BANDS: LoadBands = { small: 4, medium: 12, large: 30 };

/**
 * Tolerant merge of a `CountryConfig.loadBands` JSON over the defaults, in the
 * same shape as `mergeDeliveryRates`: a partial or malformed config can only
 * override what it validly sets, and a missing one falls back rather than
 * throwing. Dispatch must never crash because a config row is absent.
 *
 * Non-ascending values are REJECTED as a set rather than partially applied — a
 * config saying `{small: 20, medium: 5}` describes no coherent banding, and
 * honouring half of it would produce a silently wrong gate.
 */
export function mergeLoadBands(raw: unknown): LoadBands {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Partial<LoadBands>;
  const merged: LoadBands = {
    small: typeof cfg.small === 'number' && cfg.small > 0 ? cfg.small : DEFAULT_LOAD_BANDS.small,
    medium: typeof cfg.medium === 'number' && cfg.medium > 0 ? cfg.medium : DEFAULT_LOAD_BANDS.medium,
    large: typeof cfg.large === 'number' && cfg.large > 0 ? cfg.large : DEFAULT_LOAD_BANDS.large,
  };
  if (!(merged.small < merged.medium && merged.medium < merged.large)) return { ...DEFAULT_LOAD_BANDS };
  return merged;
}

/** Total bulk of an order's lines. Exported so the shadow log can record the
 *  number the band was read off, not just the band. */
export function totalBulkUnits(
  items: { quantity: number; item?: { bulkUnits?: number | null } | null; bulkUnits?: number | null }[],
): number {
  let total = 0;
  for (const line of items) {
    // Accept the bulk on the line or on its joined item, so a caller that has
    // already flattened the relation does not have to reshape it.
    const per = line.item?.bulkUnits ?? line.bulkUnits ?? DEFAULT_BULK_UNITS;
    const qty = Number.isFinite(line.quantity) && line.quantity > 0 ? line.quantity : 0;
    const bulk = Number.isFinite(per) && (per as number) > 0 ? (per as number) : DEFAULT_BULK_UNITS;
    total += qty * bulk;
  }
  return total;
}

export function bandForBulk(total: number, bands: LoadBands = DEFAULT_LOAD_BANDS): PackageSizeName {
  if (total <= bands.small) return 'SMALL';
  if (total <= bands.medium) return 'MEDIUM';
  if (total <= bands.large) return 'LARGE';
  return 'EXTRA_LARGE';
}

export interface OrderForLoad {
  orderType: string;
  courierPackageSize: string | null;
  items: { quantity: number; item?: { bulkUnits?: number | null } | null; bulkUnits?: number | null }[];
}

const SIZES_SMALL_TO_LARGE: readonly PackageSizeName[] = ['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE'];
const sizeRank = (size: PackageSizeName): number => SIZES_SMALL_TO_LARGE.indexOf(size);

/**
 * [owner #20, 13 Oct 2026 · owner ruling 31 Oct 2026] A line whose ONE unit is
 * bulkier than an ordinary item (the item editor's "bulky" or "very bulky",
 * e.g. a 20 kg bag of rice) routes the order to the largest size class: cars
 * and vans while they deliver goods; while they do not, the cap below brings it
 * to a motorbike's — never a bicycle's. It decides only WHO may carry the
 * order; the order's real size (`trueBand`) is still its total bulk.
 */
export function hasBulkyLine(
  items: { quantity: number; item?: { bulkUnits?: number | null } | null; bulkUnits?: number | null }[],
): boolean {
  return items.some((line) => {
    const per = line.item?.bulkUnits ?? line.bulkUnits ?? DEFAULT_BULK_UNITS;
    return Number.isFinite(line.quantity) && line.quantity > 0 && Number.isFinite(per) && (per as number) > DEFAULT_BULK_UNITS;
  });
}

/**
 * [Owner, 31 Oct 2026] A store order is never refused for its size alone. When
 * no vehicle Swift takes on today may carry the size its basket bands to (the
 * largest class while car deliveries are off), it needs the largest size one
 * DOES carry (a motorbike's): it is placed and offered to those movers, whose
 * offer card shows the load (`estLoad`, `loadSize`), and who may decline it
 * without it counting against them. When cars deliver again, the largest class
 * goes to cars and vans as before.
 */
function capToCarriableToday(size: PackageSizeName, env: Record<string, string | undefined>): PackageSizeName {
  for (let i = SIZES_SMALL_TO_LARGE.indexOf(size); i >= 0; i -= 1) {
    if (goodsSizeCarriableToday(SIZES_SMALL_TO_LARGE[i], env)) return SIZES_SMALL_TO_LARGE[i]!;
  }
  return size;
}

/**
 * The ONE size reading of an order, both halves from the same derivation:
 *
 *  - `required`  — the `PackageSize` a vehicle must be able to carry. Every
 *                  door that decides WHO may carry the order reads it:
 *                  checkout, the cart's availability answer, dispatch, the
 *                  rider board and the grab.
 *  - `trueBand`  — the size the basket really bands to, never capped. What a
 *                  rider is shown on the offer (`loadSize`, `oversize`) and what
 *                  stacking weighs (R3: an XL order never batches) — a cap that
 *                  decides who may carry an order must not shrink the load
 *                  itself.
 *
 * `null` means "no capacity requirement" and is NOT a failure — it is the
 * honest answer for a taxi, and for a goods order with no lines to measure.
 * Returning SMALL there would invent a constraint out of an absence.
 *
 * Rules, in order:
 *  1. TAXI            → null. There are no goods.
 *  2. COURIER         → `courierPackageSize` UNCHANGED (both halves). The
 *                       customer declared it and paid against it; an estimate
 *                       must never overrule a declaration.
 *  3. FOOD / GROCERY  → sum `quantity × bulkUnits` and band it (`trueBand`).
 *                       `required` is that band — or the largest class when a
 *                       line is bulky (`hasBulkyLine`, owner #20) — capped at
 *                       the largest size a vehicle Swift takes on today may
 *                       carry, so a store order is never refused for size
 *                       alone (owner, 31 Oct 2026), and an order holding a
 *                       bulky item goes to a motorbike at least while cars
 *                       carry no goods, never to a bicycle (owner, 31 Oct).
 *  4. anything else   → null, so a new OrderType cannot silently acquire a
 *                       gate nobody designed for it.
 *
 * [owner #20] ENFORCED: dispatch offers the order only to a vehicle that can
 * carry `required`, the rider board shows and lets it be taken only by one, and
 * checkout tells the customer before placing when none is near.
 */
export interface OrderSizeReading {
  required: PackageSizeName | null;
  trueBand: PackageSizeName | null;
}

export function readOrderSize(
  order: OrderForLoad,
  bands: LoadBands = DEFAULT_LOAD_BANDS,
  env: Record<string, string | undefined> = process.env,
): OrderSizeReading {
  const none: OrderSizeReading = { required: null, trueBand: null };
  if (order.orderType === 'TAXI') return none;
  if (order.orderType === 'COURIER') {
    const declared = (order.courierPackageSize as PackageSizeName | null) ?? null;
    return { required: declared, trueBand: declared };
  }
  if (order.orderType !== 'FOOD_DELIVERY' && order.orderType !== 'GROCERY_DELIVERY') return none;
  if (!order.items || order.items.length === 0) return none;
  const total = totalBulkUnits(order.items);
  if (total <= 0) return none;
  const trueBand = bandForBulk(total, bands);
  const routed: PackageSizeName = hasBulkyLine(order.items) ? 'EXTRA_LARGE' : trueBand;
  return { required: capToCarriableToday(routed, env), trueBand };
}

/** The `PackageSize` a vehicle must be able to carry for this order: `readOrderSize(...).required`. */
export function requiredPackageSizeForOrder(
  order: OrderForLoad,
  bands: LoadBands = DEFAULT_LOAD_BANDS,
  env: Record<string, string | undefined> = process.env,
): PackageSizeName | null {
  return readOrderSize(order, bands, env).required;
}

/**
 * [Owner, 31 Oct 2026] What the offer card and the board row add beside
 * `estLoad` (whose contract stays exactly as shipped): the order's real size
 * class, and whether it is BIGGER than what Swift offers it by today (a load
 * past a motorbike's band while car deliveries are off). Never for a car or van
 * carrying the largest class with car deliveries on, and never for one bulky
 * item routed to a motorbike (its load is smaller than what carries it).
 * Additive fields, so an older rider build simply ignores them.
 */
export function offerLoadFields(order: OrderForLoad): { loadSize: PackageSizeName | null; oversize: boolean } {
  const size = readOrderSize(order, DEFAULT_LOAD_BANDS);
  return {
    loadSize: size.trueBand,
    oversize: size.trueBand != null && size.required != null && sizeRank(size.trueBand) > sizeRank(size.required),
  };
}

const LOAD_WORD_FOR_SIZE: Record<PackageSizeName, 'small' | 'medium' | 'large'> = {
  SMALL: 'small', MEDIUM: 'medium', LARGE: 'large', EXTRA_LARGE: 'large',
};

/**
 * [Owner, 31 Oct 2026 · REVIEW-G S3-1] The `estLoad` word every rider build
 * shows on the offer card and the board row: the larger of the item-count
 * reading (`estimateLoad`) and a store order's real size band, in the same
 * small / medium / large words — so one 20 kg bag of rice says "medium", not
 * "1 item · small", even on builds that do not know `loadSize`. A parcel or a
 * ride keeps the item-count reading.
 */
export function offerEstLoad(order: OrderForLoad): 'small' | 'medium' | 'large' {
  const byCount = estimateLoad(order.items.reduce((s, i) => s + i.quantity, 0));
  if (order.orderType !== 'FOOD_DELIVERY' && order.orderType !== 'GROCERY_DELIVERY') return byCount;
  const band = readOrderSize(order, DEFAULT_LOAD_BANDS).trueBand;
  if (band == null) return byCount;
  const byBulk = LOAD_WORD_FOR_SIZE[band];
  const words = ['small', 'medium', 'large'] as const;
  return words.indexOf(byBulk) > words.indexOf(byCount) ? byBulk : byCount;
}

// ---------------------------------------------------------------------------
// [G2] The words a shopkeeper picks, and the units they mean.
//
// The spec: "surface it in the vendor item editor as a three-way choice
// (normal / bulky / very bulky), never as a raw integer — a shopkeeper should
// not be asked to think in units." So the integer never crosses the wire in
// EITHER direction: the API accepts a word and stores units, and returns the
// word beside the row. This table is the only place the two are related; a
// client that invented its own mapping would make two shops' "bulky" mean two
// different loads.
// ---------------------------------------------------------------------------

export type BulkChoice = 'normal' | 'bulky' | 'very_bulky';
export const BULK_CHOICES: readonly BulkChoice[] = ['normal', 'bulky', 'very_bulky'];

/** normal = an ordinary item (stored as NULL, exactly what every existing row
 *  already is). bulky ≈ a crate of drinks. very_bulky ≈ a 20 kg bag of rice —
 *  the spec's own example, at 8. */
const UNITS_FOR_CHOICE: Record<BulkChoice, number | null> = { normal: null, bulky: 4, very_bulky: 8 };

export function bulkUnitsForChoice(choice: BulkChoice): number | null {
  return UNITS_FOR_CHOICE[choice];
}

/** The inverse, for reads. Any stored value that is not one of the three
 *  (a hand edit, an import) rounds to the nearest word rather than erroring —
 *  a menu must never fail to render over a load hint. */
export function bulkChoiceForUnits(units: number | null | undefined): BulkChoice {
  if (units == null || units <= DEFAULT_BULK_UNITS) return 'normal';
  return units < UNITS_FOR_CHOICE.very_bulky! ? 'bulky' : 'very_bulky';
}

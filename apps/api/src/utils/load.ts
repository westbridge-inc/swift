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
// `estimateLoad` above is a DISPLAY badge and stays exactly as it is — it is a
// shipped contract on the offer card (`estLoad`), read by three call sites and
// consumed by nothing in dispatch. It gates nothing and is not being made to.
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

/**
 * The `PackageSize` a vehicle must be able to carry for this order.
 *
 * `null` means "no capacity requirement" and is NOT a failure — it is the
 * honest answer for a taxi, and for a goods order with no lines to measure.
 * Returning SMALL there would invent a constraint out of an absence.
 *
 * Rules, in order:
 *  1. TAXI            → null. There are no goods.
 *  2. COURIER         → `courierPackageSize` UNCHANGED. The customer declared
 *                       it and paid against it; an estimate must never
 *                       overrule a declaration.
 *  3. FOOD / GROCERY  → sum `quantity × bulkUnits` and band it.
 *  4. anything else   → null, so a new OrderType cannot silently acquire a
 *                       gate nobody designed for it.
 */
export function requiredPackageSizeForOrder(
  order: OrderForLoad,
  bands: LoadBands = DEFAULT_LOAD_BANDS,
): PackageSizeName | null {
  if (order.orderType === 'TAXI') return null;
  if (order.orderType === 'COURIER') return (order.courierPackageSize as PackageSizeName | null) ?? null;
  if (order.orderType !== 'FOOD_DELIVERY' && order.orderType !== 'GROCERY_DELIVERY') return null;
  if (!order.items || order.items.length === 0) return null;
  const total = totalBulkUnits(order.items);
  if (total <= 0) return null;
  return bandForBulk(total, bands);
}

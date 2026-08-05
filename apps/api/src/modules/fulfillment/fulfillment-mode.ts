import type { FulfillmentMode } from '@prisma/client';

/**
 * FUL-004b: resolve WHO delivers a DELIVERY order, evaluated AT the dispatch
 * decision (vendor accept for ON_ACCEPT, mark-ready for ON_READY).
 *
 * The sequencing crux: with the ON_ACCEPT dispatch default, the platform rider
 * would be dispatched before a vendor could pick VENDOR_DELIVERY at Ready. So
 * self-delivery is driven by the vendor's standing preference, resolved right at
 * the dispatch point — a self-delivering vendor never has a platform rider
 * dispatched underneath it.
 *
 * Precedence: an EXPLICIT choice already on the order (a vendor one-tap override)
 * wins; otherwise the vendor's default — self-deliver first when it's capable,
 * else a platform rider.
 */
export function resolveDeliveryMode(
  orderMode: FulfillmentMode | null | undefined,
  vendorSelfDeliveryEnabled: boolean,
): 'PLATFORM_RIDER' | 'VENDOR_DELIVERY' {
  if (orderMode === 'VENDOR_DELIVERY') return 'VENDOR_DELIVERY';
  if (orderMode === 'PLATFORM_RIDER') return 'PLATFORM_RIDER';
  return vendorSelfDeliveryEnabled ? 'VENDOR_DELIVERY' : 'PLATFORM_RIDER';
}

/**
 * [F-0026] Prisma WHERE fragment: orders a PLATFORM RIDER may legitimately work.
 *
 * Excludes self-delivered orders from the rider board, the dispatch reconciler
 * and the struggling-delivery scan — a vendor delivering with its own courier
 * has no rider BY DESIGN, and treating that as "stranded" produced phantom
 * offers and a false "no rider found" push to the customer.
 *
 * Spell the NULL case out. `fulfillmentMode` is nullable and the mode is only
 * resolved at accept/ready, so a bare `{ not: 'VENDOR_DELIVERY' }` compiles to
 * SQL `!= 'VENDOR_DELIVERY'`, which is NULL — not true — for an unresolved
 * order, silently excluding exactly the orders the reconciler exists to rescue.
 * A regression test caught this; do not "simplify" it back.
 *
 * Use inside `AND: [...]` — several call sites already spread an `OR` of their
 * own (notHeldFilter), and a second bare `OR` key would overwrite it.
 */
export function notSelfDeliveredFilter() {
  return { OR: [{ fulfillmentMode: null }, { fulfillmentMode: { not: 'VENDOR_DELIVERY' as const } }] };
}

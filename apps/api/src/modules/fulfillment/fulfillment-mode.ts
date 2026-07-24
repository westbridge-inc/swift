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

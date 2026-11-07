import { apiFetch } from '@/lib/auth';

/**
 * [RIDER-SAFE 1] GET /customer/delivery-availability — whether delivery from
 * one store can be ordered now, for THIS customer's basket and address, in the
 * server's own words. Levels and minutes only, never rider counts.
 *   GOOD    nothing to say;
 *   BUSY    taken, "Riders are busy — about N min extra for delivery.";
 *   NONE    refused at checkout while the availability gate is on;
 *   PAUSED  refused at checkout whatever the gate (Swift's pause, or the
 *           store's own orders waiting for riders).
 */
export type DeliveryAvailability = {
  level: 'GOOD' | 'BUSY' | 'NONE' | 'PAUSED';
  reason: 'NO_RIDERS' | 'RIDERS_BUSY' | 'SWIFT_PAUSED' | 'STORE_BUSY' | null;
  extraMinutes: number | null;
  message: string | null;
  /** DISPATCH_AVAILABILITY: with it off, checkout does not refuse on riders. */
  gate: boolean;
};

/**
 * `at` is the drop-off the customer chose. [REVIEW-F #2214 S4-1] Without it the
 * server reads the CART's saved address, which lags a new pick while
 * PUT /cart/address is still on its way.
 */
export async function getDeliveryAvailability(
  vendorId: string,
  paymentMethod: 'CASH' | 'MOBILE_MONEY',
  at?: { lat: number; lng: number } | null,
): Promise<DeliveryAvailability> {
  const qs = new URLSearchParams({ vendorId, paymentMethod });
  if (at) { qs.set('lat', String(at.lat)); qs.set('lng', String(at.lng)); }
  return (await apiFetch(`/api/v1/customer/delivery-availability?${qs.toString()}`)).data as DeliveryAvailability;
}

/** Is there something true to tell the customer before they order? Only what checkout acts on. */
export function deliveryNoticeShown(a: DeliveryAvailability): boolean {
  if (!a.message) return false;
  if (a.level === 'PAUSED') return true;
  return (a.level === 'BUSY' || a.level === 'NONE') && a.gate;
}

/** A saved address's own point, or null (the server then reads the cart's saved address). */
export function addressPoint(a: { latitude?: unknown; longitude?: unknown } | null | undefined): { lat: number; lng: number } | null {
  return typeof a?.latitude === 'number' && typeof a.longitude === 'number' ? { lat: a.latitude, lng: a.longitude } : null;
}

/** [REVIEW-G N1] What is in the basket: its size and cash band are part of the reading. */
export function riderBasketKey(lines: ReadonlyArray<{ id?: string; quantity?: number }> | null | undefined): string {
  return (lines ?? []).map((l) => `${l.id}:${l.quantity}`).join();
}

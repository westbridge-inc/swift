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

export async function getDeliveryAvailability(vendorId: string, paymentMethod: 'CASH' | 'MOBILE_MONEY'): Promise<DeliveryAvailability> {
  const qs = new URLSearchParams({ vendorId, paymentMethod });
  return (await apiFetch(`/api/v1/customer/delivery-availability?${qs.toString()}`)).data as DeliveryAvailability;
}

/** Is there something true to tell the customer before they order? Only what checkout acts on. */
export function deliveryNoticeShown(a: DeliveryAvailability): boolean {
  if (!a.message) return false;
  if (a.level === 'PAUSED') return true;
  return (a.level === 'BUSY' || a.level === 'NONE') && a.gate;
}

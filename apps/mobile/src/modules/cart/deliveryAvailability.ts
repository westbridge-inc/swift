// [RIDER-SAFE 1 · COORD ruling 29 Oct 2026] What the cart says BEFORE the
// customer orders delivery from a store, in the server's own words
// (GET /customer/delivery-availability): riders busy ("about N min extra"),
// or delivery off for now (no riders near, Swift paused it, or the store has
// orders waiting for riders) — with pickup offered. Levels and minutes only,
// never rider counts. The website's checkout says the same (web
// lib/delivery-availability.ts).

export type DeliveryAvailability = {
  level: 'GOOD' | 'BUSY' | 'NONE' | 'PAUSED';
  reason: 'NO_RIDERS' | 'RIDERS_BUSY' | 'SWIFT_PAUSED' | 'STORE_BUSY' | null;
  extraMinutes: number | null;
  message: string | null;
  /** DISPATCH_AVAILABILITY: with it off, checkout does not refuse on riders. */
  gate: boolean;
};

export type DeliveryNotice = { text: string; offerPickup: boolean };

/** The note to show, or null: only what checkout acts on. A malformed answer says nothing. */
export function deliveryNoticeFor(a: unknown): DeliveryNotice | null {
  if (!a || typeof a !== 'object') return null;
  const v = a as Partial<DeliveryAvailability>;
  if (typeof v.message !== 'string' || v.message.length === 0) return null;
  if (v.level === 'PAUSED') return { text: v.message, offerPickup: true };
  if (v.gate !== true) return null;
  if (v.level === 'BUSY') return { text: v.message, offerPickup: false };
  if (v.level === 'NONE') return { text: v.message, offerPickup: true };
  return null;
}

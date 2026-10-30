// [RIDER-SAFE 4 · FUL-007] "How many orders at once" (the store's maxConcurrentOrders): the card's pure rules.

/** The most the card offers; the server takes up to 1000. */
export const KITCHEN_CAPACITY_MAX = 100;

/** The stored cap, or null = no limit (every store's default). */
export function storedKitchenCapacity(store: unknown): number | null {
  const v = store && typeof store === 'object' ? (store as { maxConcurrentOrders?: unknown }).maxConcurrentOrders : undefined;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null;
}

/** The card's steps: Fewer from 1 is "No limit"; More from "No limit" starts at 10. */
export function nextKitchenCapacity(current: number | null, step: 'fewer' | 'more'): number | null {
  if (step === 'fewer') return current == null || current <= 1 ? null : current - 1;
  return current == null ? 10 : Math.min(KITCHEN_CAPACITY_MAX, current + 1);
}

/**
 * [REVIEW-F #2214 S3-1] What the limit does, in the server's terms: at the cap
 * checkout REFUSES new orders (VENDOR_AT_CAPACITY, "try again in a few
 * minutes"); nothing queues. The website's card says the same.
 */
export function kitchenCapacityLine(count: number | null): string {
  if (count == null) return 'No limit. Set one if too many orders at once would make every order late: customers are asked to try again in a few minutes.';
  return `Up to ${count} ${count === 1 ? 'order' : 'orders'} at a time (new, cooking or ready). Once you have that many, customers cannot order from you until one is collected or cancelled: they are asked to try again in a few minutes.`;
}

/** [RIDER-SAFE 4/5] What the store is told, from GET /vendor/vendor/delivery-status; null while delivery is open or unknown. */
export function deliveryStatusNote(s: unknown): { title: string; body: string } | null {
  if (!s || typeof s !== 'object') return null;
  const v = s as { deliveryOpen?: unknown; reason?: unknown; message?: unknown };
  if (v.deliveryOpen !== false || typeof v.message !== 'string' || !v.message) return null;
  return { title: v.reason === 'SWIFT_PAUSED' ? 'Delivery is paused by Swift' : 'New delivery orders are paused', body: v.message };
}

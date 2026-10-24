'use client';

// [PERF · web shared bundle] Courier calls, moved verbatim from lib/customer.ts;
// only the courier page uses them.
import { apiFetch } from './auth';

export async function courierEstimate(body: { pickup: { lat: number; lng: number }; dropoff: { lat: number; lng: number }; packageSize: string }) {
  return (await apiFetch('/api/v1/courier/estimate', { method: 'POST', body: JSON.stringify(body) })).data;
}
/** POST /courier/order — the server's own fields: the recipient is required and what is inside is `packageDescription` (there is no `notes`).
 *  `declaresNoProhibitedItems` is the sender's tick "This parcel has no prohibited items" [owner #67]. */
export type CourierRequest = { pickup: { lat: number; lng: number }; dropoff: { lat: number; lng: number }; pickupAddress: string; dropoffAddress: string; packageSize: string; recipientName: string; recipientPhone: string; packageDescription?: string; expectedFee?: number; declaresNoProhibitedItems?: boolean };
/** [UI-SWEEP U65] `idempotencyKey`: one per parcel intent, kept across retries. A lost
 *  answer and a second press replay the first parcel (the server's receipt) instead of
 *  booking a second one. */
export async function requestCourier(body: CourierRequest, idempotencyKey: string) {
  return (await apiFetch('/api/v1/courier/order', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) })).data;
}

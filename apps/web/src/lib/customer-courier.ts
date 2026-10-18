'use client';

// [PERF · web shared bundle] Courier calls, moved verbatim from lib/customer.ts;
// only the courier page uses them.
import { apiFetch } from './auth';

export async function courierEstimate(body: { pickup: { lat: number; lng: number }; dropoff: { lat: number; lng: number }; packageSize: string }) {
  return (await apiFetch('/api/v1/courier/estimate', { method: 'POST', body: JSON.stringify(body) })).data;
}
/** POST /courier/order — the server's own fields: the recipient is required and what is inside is `packageDescription` (there is no `notes`).
 *  `declaresNoProhibitedItems` is the sender's tick "This parcel has no prohibited items" [owner #67]. */
export async function requestCourier(body: { pickup: { lat: number; lng: number }; dropoff: { lat: number; lng: number }; pickupAddress: string; dropoffAddress: string; packageSize: string; recipientName: string; recipientPhone: string; packageDescription?: string; expectedFee?: number; declaresNoProhibitedItems?: boolean }) {
  return (await apiFetch('/api/v1/courier/order', { method: 'POST', body: JSON.stringify(body) })).data;
}

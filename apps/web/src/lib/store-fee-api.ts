// [RETIER PR-A2 · owner 30 Oct 2026] The selected store's weekly fee before it goes live, apart from vendor-api.ts
// (every dashboard page loads that one): only the settings card uses these calls.
import { apiFetch } from './auth';

/** GET /vendor/onboarding/weekly-fee: the fee the selected store would be born on now (its own catalogue's step), why,
 *  and whether its owner must tick it before the store goes live. */
export interface StoreFeeView {
  vendorId: string;
  set: boolean;
  weeklyFee: { amount: number; currencyCode: string; tier: string; version: string } | null;
  why: string | null;
  required: boolean;
  ticked: boolean;
  terms: { version: string; items: Array<{ heading: string; text: string }>; tick: string } | null;
}
export const getStoreFee = (vendorId: string): Promise<StoreFeeView | null> =>
  apiFetch('/api/v1/vendor/onboarding/weekly-fee', { headers: { 'x-vendor-id': vendorId } }).then((r) => (r.data ?? null) as StoreFeeView | null);
/** The owner ticks exactly the fee shown, for ONE store, named in the header and the body (the server refuses a
 *  mismatch, and any amount, currency or version that is not its quote now). */
export const tickStoreFee = (tick: { vendorId: string; weeklyFeeAck: { version: string; amount: number; currencyCode: string } }) =>
  apiFetch('/api/v1/vendor/onboarding/weekly-fee', { method: 'POST', headers: { 'x-vendor-id': tick.vendorId }, body: JSON.stringify(tick) }).then((r) => r.data);

/** What a tick is given to: the store, the words' version, the amount and the currency on screen. */
export const storeFeeKey = (vendorId: string, fee: { version: string; amount: number; currencyCode: string }) =>
  `${vendorId}:${fee.version}:${fee.amount}:${fee.currencyCode}`;

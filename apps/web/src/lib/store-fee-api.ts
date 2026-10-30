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
export const getStoreFee = (): Promise<StoreFeeView | null> =>
  apiFetch('/api/v1/vendor/onboarding/weekly-fee').then((r) => (r.data ?? null) as StoreFeeView | null);
/** The owner ticks exactly the fee shown, for the selected store (the request carries its x-vendor-id). */
export const tickStoreFee = (weeklyFeeAck: { version: string; amount: number; currencyCode: string }) =>
  apiFetch('/api/v1/vendor/onboarding/weekly-fee', { method: 'POST', body: JSON.stringify({ weeklyFeeAck }) }).then((r) => r.data);

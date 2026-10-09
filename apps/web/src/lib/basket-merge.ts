import { apiFetch, ApiRequestError } from './auth';
import { prepareGuestMerge, settleGuestMerge } from './basket';
import { readCheckoutAttempt, type Cart } from './customer';
export interface GuestMergeResult {
  applied: boolean;
  verdicts: Array<{ clientLineId: string; status: string; unitPrice?: number }>;
  cart: Cart | null;
}
export async function uploadGuestBasket(scope: string): Promise<GuestMergeResult | null> {
  if (readCheckoutAttempt()) throw new Error('An earlier checkout still has an unresolved outcome. Check Orders or retry that order before uploading this basket.');
  const pending = prepareGuestMerge(scope);
  if (!pending) return null;
  try {
    const result = (await apiFetch('/api/v1/customer/cart/merge', {
      method: 'POST', headers: { 'Idempotency-Key': pending.key },
      body: JSON.stringify({ lines: pending.lines.map(l => ({ clientLineId: l.clientLineId, vendorId: l.vendorId, itemId: l.itemId,
        quantity: l.quantity, expectedUnitPrice: l.unitPrice, selectedOptions: l.selectedOptions })) }),
    }, { redirectOnExpired: false })).data as GuestMergeResult;
    if (typeof result?.applied !== 'boolean' || !Array.isArray(result.verdicts)
      || result.verdicts.length !== pending.lines.length
      || result.verdicts.some((v, i) => v.clientLineId !== pending.lines[i]?.clientLineId)
      || result.applied && result.verdicts.some(v => v.status !== 'ADDED')) throw new Error('Swift could not confirm this basket upload. Retry before changing it.');
    settleGuestMerge(pending.key, result.applied);
    if (result.applied) window.dispatchEvent(new Event('swift-guest-merged'));
    return result;
  } catch (e) {
    // A transport error has an unknown outcome. Keep the exact command frozen.
    if (e instanceof ApiRequestError && e.status >= 400 && e.status < 500) settleGuestMerge(pending.key, false);
    throw e;
  }
}

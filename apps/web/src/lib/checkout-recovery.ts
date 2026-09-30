import { apiFetch } from './auth';
import type { CheckoutAttempt } from './customer';

export type CheckoutResolution =
  | { status: 'placed'; orderIds: string[] }
  | { status: 'none' }
  | { status: 'unknown' };

/** A retained key is resolved independently of the current cart or options.
 * Only an explicit receipt verdict can release the pending attempt. */
export async function resolveCheckoutAttempt(attempt: CheckoutAttempt): Promise<CheckoutResolution> {
  try {
    const { data } = await apiFetch(`/api/v1/customer/checkout/receipts/${encodeURIComponent(attempt.key)}`);
    if (data?.status === 'none') return { status: 'none' };
    if (data?.status === 'placed' && Array.isArray(data.orderIds) && data.orderIds.length > 0
      && data.orderIds.every((id: unknown) => typeof id === 'string' && id.trim().length > 0)) {
      return { status: 'placed', orderIds: data.orderIds };
    }
  } catch {
    // A failed probe says nothing about whether the checkout committed.
  }
  return { status: 'unknown' };
}

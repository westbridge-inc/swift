import { describe, it, expect } from 'vitest';
import { assertMmgFulfilmentAllowed } from '../modules/order/order.service';

// [PAYMENT-SIMPLIFY follow-up · REVIEW-G S4-1 on #1848] The store may ACCEPT an unpaid MMG order (owner 17 Oct, Q1)
// only while that payment can still happen: PENDING or AUTHORIZED, with no store claim an operator rejected.
// A FAILED, REFUNDED, PARTIALLY_REFUNDED or UNKNOWN payment is never accepted unpaid — the full gate applies.

const unpaid = { paymentMethod: 'MOBILE_MONEY', orderType: 'FOOD', mmgClaimMismatchAt: null, mmgAttestedRef: null } as const;
const code = (fn: () => void): string | null => {
  try { fn(); return null; } catch (e) { return (e as { code?: string }).code ?? 'THREW'; }
};

describe('[#1848 follow-up] ACCEPTED-unpaid is literal: only an open payment', () => {
  it.each(['PENDING', 'AUTHORIZED'])('a %s MMG payment may be accepted unpaid', (paymentStatus) => {
    expect(code(() => assertMmgFulfilmentAllowed({ ...unpaid, paymentStatus }, 'ACCEPTED'))).toBeNull();
  });

  it.each(['FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'UNKNOWN'])('a %s MMG payment is never accepted unpaid', (paymentStatus) => {
    expect(code(() => assertMmgFulfilmentAllowed({ ...unpaid, paymentStatus }, 'ACCEPTED'))).toBe('MMG_PAYMENT_PENDING');
  });

  it('nothing after acceptance moves on an open payment (unchanged)', () => {
    expect(code(() => assertMmgFulfilmentAllowed({ ...unpaid, paymentStatus: 'PENDING' }, 'PREPARING'))).toBe('MMG_PAYMENT_PENDING');
    expect(code(() => assertMmgFulfilmentAllowed({ ...unpaid, paymentStatus: 'CLAIMED' }, 'PREPARING'))).toBeNull();
  });
});

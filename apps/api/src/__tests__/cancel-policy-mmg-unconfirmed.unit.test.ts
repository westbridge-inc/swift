import { describe, expect, it } from 'vitest';
import { MMG_UNCONFIRMED_CANCEL_MESSAGE, STORE_ACCEPTED_CANCEL_CODE, cancellationVerdict, customerCancelView, type CancellationSnapshot } from '../modules/order/cancel-policy';

// [owner 17 Oct 2026 · PAYMENT-SIMPLIFY · COORD ruling Q2] With MMG to the store's number the store accepts
// BEFORE the customer pays. The ONE cancellation predicate keeps the customer's in-app cancel open on an
// accepted MMG store order only while the store has NOT marked it "Paid by MMG" (paymentStatus PENDING).
// Once the store says the money arrived (CLAIMED or CAPTURED), it is the accepted-store rule again.
const NOW = new Date('2026-10-17T12:00:00Z');
const accepted = (over: Partial<CancellationSnapshot> = {}): CancellationSnapshot => ({
  status: 'ACCEPTED', orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
  placedAt: new Date('2026-10-17T11:50:00Z'), holdExpiresAt: null, riderId: null, driverId: null, scheduledFor: null,
  acceptedAt: new Date('2026-10-17T11:52:00Z'), promisedAt: new Date('2026-10-17T12:40:00Z'),
  paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING',
  ...over,
});

describe('[PAYMENT-SIMPLIFY · Q2] cancel an accepted MMG order until "Paid by MMG"', () => {
  it('unconfirmed (PENDING): allowed, with the plain reason', () => {
    expect(cancellationVerdict(accepted(), NOW)).toEqual({ allowed: true, free: true, reason: 'MMG_UNCONFIRMED' });
    expect(customerCancelView(accepted(), NOW)).toMatchObject({ canCancel: true, cancellationMessage: expect.stringContaining(MMG_UNCONFIRMED_CANCEL_MESSAGE) });
  });

  it.each(['CLAIMED', 'CAPTURED', 'UNKNOWN', 'FAILED'])('%s: the accepted-store rule (refused)', (paymentStatus) => {
    expect(cancellationVerdict(accepted({ paymentStatus }), NOW)).toMatchObject({ allowed: false, code: STORE_ACCEPTED_CANCEL_CODE });
  });

  it('cash, or a caller that did not say the payment state: the accepted-store rule (refused)', () => {
    expect(cancellationVerdict(accepted({ paymentMethod: 'CASH' }), NOW)).toMatchObject({ allowed: false, code: STORE_ACCEPTED_CANCEL_CODE });
    expect(cancellationVerdict(accepted({ paymentStatus: undefined }), NOW)).toMatchObject({ allowed: false, code: STORE_ACCEPTED_CANCEL_CODE });
  });
});

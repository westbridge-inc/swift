import { describe, it, expect } from 'vitest';
import {
  MMG_ACCEPT_EXPIRY_REASON,
  expiredUnpaidMmgAcceptanceWhere,
  isExpiredUnpaidMmgAcceptance,
  mmgAcceptExpiryNotice,
  mmgAcceptedPayBy,
  type UnpaidMmgAcceptanceFacts,
} from '../modules/order/mmg-accept-expiry';
import { MMG_MONEY_MOVED } from '../modules/order/order.service';

// [owner 18 Oct 2026 · PAYMENT-SIMPLIFY] The ONE rule: an ACCEPTED MMG store
// order never marked "Paid by MMG" cancels 30 minutes after acceptance.

const ACCEPTED_AT = new Date('2026-10-18T15:00:00.000Z');
const waiting: UnpaidMmgAcceptanceFacts = {
  status: 'ACCEPTED', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING', orderType: 'FOOD',
  vendorId: 'v1', acceptedAt: ACCEPTED_AT, mmgAttestedRef: null, mmgClaimMismatchAt: null,
};
const at = (ms: number) => new Date(ACCEPTED_AT.getTime() + ms);

describe('[PAYMENT-SIMPLIFY] the MMG acceptance pay window', () => {
  it('pays by 30 minutes after acceptance: 29:59 stays, 30:00 cancels', () => {
    expect(mmgAcceptedPayBy(waiting)?.toISOString()).toBe('2026-10-18T15:30:00.000Z');
    expect(isExpiredUnpaidMmgAcceptance(waiting, at(29 * 60_000))).toBe(false);
    expect(isExpiredUnpaidMmgAcceptance(waiting, at(30 * 60_000 - 1000))).toBe(false);
    expect(isExpiredUnpaidMmgAcceptance(waiting, at(30 * 60_000))).toBe(true);
  });

  it('never applies to an order that is paid, not accepted, not MMG, a taxi, a rejected claim, or disputed', () => {
    const never: Array<[string, Partial<UnpaidMmgAcceptanceFacts>]> = [
      ['store claimed', { paymentStatus: 'CLAIMED' }],
      ['provider captured', { paymentStatus: 'CAPTURED' }],
      ['still pending', { status: 'PENDING' }],
      ['preparing', { status: 'PREPARING' }],
      ['already cancelled', { status: 'CANCELLED' }],
      ['cash', { paymentMethod: 'CASH' }],
      ['taxi', { orderType: 'TAXI' }],
      ['no store', { vendorId: null }],
      ['no acceptance time', { acceptedAt: null }],
      ['rejected store claim (support holds it)', { mmgAttestedRef: 'MP123' }],
      ['open disagreement (support holds it)', { mmgClaimMismatchAt: new Date() }],
      ['claim field not read (fail closed)', { mmgAttestedRef: undefined }],
      ['dispute field not read (fail closed)', { mmgClaimMismatchAt: undefined }],
    ];
    for (const [why, change] of never) {
      expect(mmgAcceptedPayBy({ ...waiting, ...change }), why).toBeNull();
      expect(isExpiredUnpaidMmgAcceptance({ ...waiting, ...change }, at(24 * 60 * 60_000)), why).toBe(false);
    }
  });

  it("the sweep's filter is the same rule, and 'money moved' is order.service's own set", () => {
    const now = at(31 * 60_000);
    const where = expiredUnpaidMmgAcceptanceWhere(now);
    expect(where).toMatchObject({
      status: 'ACCEPTED', paymentMethod: 'MOBILE_MONEY', orderType: { not: 'TAXI' }, vendorId: { not: null },
      mmgAttestedRef: null, mmgClaimMismatchAt: null, acceptedAt: { lte: at(60_000) },
    });
    expect([...(where.paymentStatus as { notIn: string[] }).notIn].sort()).toEqual([...MMG_MONEY_MOVED].sort());
  });

  it('the customer card explains only this cancellation', () => {
    const closed = { status: 'CANCELLED', cancellationReason: MMG_ACCEPT_EXPIRY_REASON, cancelledBy: null, orderNumber: 'SW-1' };
    expect(mmgAcceptExpiryNotice(closed, 'Window Diner')).toContain('within 30 minutes of accepting');
    expect(mmgAcceptExpiryNotice({ ...closed, cancelledBy: 'u1' }, 'Window Diner')).toBeNull();
    expect(mmgAcceptExpiryNotice({ ...closed, cancellationReason: 'Customer cancelled' }, 'Window Diner')).toBeNull();
    expect(mmgAcceptExpiryNotice({ ...closed, status: 'ACCEPTED' }, 'Window Diner')).toBeNull();
  });
});

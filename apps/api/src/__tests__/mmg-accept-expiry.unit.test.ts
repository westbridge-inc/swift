import { describe, it, expect } from 'vitest';
import {
  MMG_ACCEPT_EXPIRY_REASON,
  MMG_STORE_SILENT_SUBJECT,
  expiredUnpaidMmgAcceptanceWhere,
  isExpiredUnpaidMmgAcceptance,
  isStoreSilentOnClaimedMmgPayment,
  mmgAcceptExpiryCustomerCopy,
  mmgAcceptExpiryNotice,
  mmgAcceptedPayBy,
  mmgAcceptedPushCopy,
  mmgOrderNoun,
  mmgPayByCustomerLine,
  storeSilentOnClaimedMmgWhere,
  type UnpaidMmgAcceptanceFacts,
} from '../modules/order/mmg-accept-expiry';
import { MMG_MONEY_MOVED } from '../modules/order/order.service';

// [owner 18 Oct 2026 · PAYMENT-SIMPLIFY] The ONE rule: an ACCEPTED MMG store
// order never marked "Paid by MMG" cancels 30 minutes after acceptance.

const ACCEPTED_AT = new Date('2026-10-18T15:00:00.000Z');
const waiting: UnpaidMmgAcceptanceFacts = {
  status: 'ACCEPTED', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING', orderType: 'FOOD',
  vendorId: 'v1', acceptedAt: ACCEPTED_AT, mmgAttestedRef: null, mmgClaimMismatchAt: null, customerMmgClaim: 'UNRECORDED',
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
      ['the customer says they paid (owner 18 Oct: ask the store, open a case)', { customerMmgClaim: 'PAID' }],
      ['customer claim not read (fail closed)', { customerMmgClaim: undefined }],
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

describe('[owner 18 Oct 2026] a customer who said "I paid" is never auto-cancelled', () => {
  const claimed = { ...waiting, customerMmgClaim: 'PAID' };
  it('at 30:00 the store-silent case is due (29:59 not yet); a "did not pay" claim still expires', () => {
    expect(isStoreSilentOnClaimedMmgPayment(claimed, at(30 * 60_000 - 1000))).toBe(false);
    expect(isStoreSilentOnClaimedMmgPayment(claimed, at(30 * 60_000))).toBe(true);
    expect(isStoreSilentOnClaimedMmgPayment({ ...claimed, paymentStatus: 'CLAIMED' }, at(60 * 60_000))).toBe(false);
    expect(isStoreSilentOnClaimedMmgPayment(waiting, at(60 * 60_000))).toBe(false);
    expect(isExpiredUnpaidMmgAcceptance({ ...waiting, customerMmgClaim: 'NOT_PAID' }, at(30 * 60_000))).toBe(true);
  });
  it("the two sweep filters split on the customer's claim, and the case filter skips an order that has one", () => {
    const now = at(31 * 60_000);
    expect(expiredUnpaidMmgAcceptanceWhere(now)).toMatchObject({ customerMmgClaim: { not: 'PAID' } });
    expect(storeSilentOnClaimedMmgWhere(now)).toMatchObject({
      status: 'ACCEPTED', customerMmgClaim: 'PAID', mmgClaimMismatchAt: null, acceptedAt: { lte: at(60_000) },
      supportTickets: { none: { category: 'PAYMENT', subject: MMG_STORE_SILENT_SUBJECT } },
    });
  });
});

describe('[REVIEW-F S3-1b] a booking reads as a booking', () => {
  it('push, deadline and cancellation say "booking"', () => {
    expect(mmgOrderNoun('APPOINTMENT')).toBe('booking');
    expect(mmgOrderNoun('DELIVERY')).toBe('order');
    const payBy = at(30 * 60_000);
    expect(mmgAcceptedPushCopy('SW-1', 'Glow Salon', 4000, 'GYD', payBy, 'booking')).toMatchObject({
      title: 'Pay by MMG to confirm your booking',
      body: expect.stringMatching(/^Glow Salon accepted booking SW-1\. Pay GY\$4,000 by MMG — open your booking for the number — by .+, or it cancels automatically\.$/),
    });
    expect(mmgPayByCustomerLine(payBy, 'Glow Salon', 'booking')).toMatch(/the booking is cancelled automatically\.$/);
    expect(mmgAcceptExpiryCustomerCopy('SW-1', 'Glow Salon', 'booking').title).toBe('Booking cancelled — MMG payment not confirmed');
  });
  it('the accept push checks the unpaid-MMG case BEFORE the booking branch (else a booking gets no pay-by)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', 'modules', 'order', 'order.service.ts'), 'utf8');
    const accepted = src.slice(src.indexOf("      case 'ACCEPTED':"), src.indexOf("      case 'PREPARING':"));
    expect(accepted).toContain("const mmgClaimedPaid = isUnpaidMmgAcceptance(order) && order.customerMmgClaim === 'PAID';");
    expect(accepted.indexOf('if (mmgPayBy || mmgClaimedPaid)')).toBeGreaterThan(-1);
    expect(accepted.indexOf('if (mmgPayBy || mmgClaimedPaid)')).toBeLessThan(accepted.indexOf("order.fulfillment === 'APPOINTMENT'"));
  });
});

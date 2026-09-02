import { describe, it, expect } from 'vitest';
import { handoverAuthorityFor, handoverVersionFor, handoverVersionMatches, paymentRailOf } from '../modules/order/handover-authority';

// [MOB-023] The door's authority as a pure table: every rail × every payment state.
const base = { id: 'o1', status: 'ARRIVED', totalAmount: '1250.00', currencyCode: 'GYD', updatedAt: new Date('2026-09-02T10:00:00.000Z') };
const STATES = ['PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'UNKNOWN', 'EXPIRED'];

describe('[MOB-023] handoverAuthorityFor', () => {
  it('only CAPTURED opens the no-cash door; cash collects; every other non-cash state is BLOCKED with its reason', () => {
    for (const paymentStatus of STATES) {
      const mmg = handoverAuthorityFor({ ...base, paymentMethod: 'MOBILE_MONEY', paymentStatus });
      const cash = handoverAuthorityFor({ ...base, paymentMethod: 'CASH', paymentStatus });
      if (paymentStatus === 'CAPTURED') {
        expect(mmg.permitted, paymentStatus).toBe('DELIVER_NO_CASH');
        expect(cash.permitted, paymentStatus).toBe('DELIVER_NO_CASH');
      } else {
        expect(mmg, paymentStatus).toMatchObject({ permitted: 'BLOCKED', blockReason: `MOBILE_MONEY_${paymentStatus}` });
        expect(cash, paymentStatus).toMatchObject({ permitted: 'COLLECT_CASH_THEN_DELIVER', blockReason: null });
      }
      expect(mmg).toMatchObject({ rail: 'MOBILE_MONEY', paymentState: paymentStatus, custodyState: 'ARRIVED', amount: 1250, currency: 'GYD' });
    }
    expect(paymentRailOf('CARD')).toBe('OTHER');
    expect(handoverAuthorityFor({ ...base, paymentMethod: 'CARD', paymentStatus: 'PENDING' })).toMatchObject({ permitted: 'BLOCKED', blockReason: 'OTHER_PENDING' });
  });

  it('the version changes with the custody state, the payment state and the last write, and never with anything else', () => {
    const a = handoverVersionFor({ ...base, paymentStatus: 'PENDING' });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(handoverVersionFor({ ...base, paymentStatus: 'PENDING' })).toBe(a);
    expect(handoverVersionFor({ ...base, paymentStatus: 'CAPTURED' })).not.toBe(a);
    expect(handoverVersionFor({ ...base, status: 'EN_ROUTE_DELIVERY', paymentStatus: 'PENDING' })).not.toBe(a);
    expect(handoverVersionFor({ ...base, paymentStatus: 'PENDING', updatedAt: new Date('2026-09-02T10:00:01.000Z') })).not.toBe(a);
    expect(handoverVersionFor({ ...base, id: 'o2', paymentStatus: 'PENDING' })).not.toBe(a);
  });

  it('a missing echo is tolerated (an older client); a wrong one is not', () => {
    const order = { ...base, paymentStatus: 'CAPTURED' };
    expect(handoverVersionMatches(order, undefined)).toBe(true);
    expect(handoverVersionMatches(order, null)).toBe(true);
    expect(handoverVersionMatches(order, handoverVersionFor(order))).toBe(true);
    expect(handoverVersionMatches(order, 'deadbeefdeadbeef')).toBe(false);
  });
});

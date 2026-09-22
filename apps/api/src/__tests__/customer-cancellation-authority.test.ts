import { describe, expect, it } from 'vitest';
import type { OrderStatus } from '@prisma/client';
import {
  customerCancellationDenial,
  type CustomerCancellationSnapshot,
} from '../modules/order/order.service';

const NOW = new Date('2026-09-21T12:00:00.000Z');

const MARKET_DENIAL_CASES: Array<[string, Partial<CustomerCancellationSnapshot>]> = [
  ['missing hold', { holdExpiresAt: null }],
  ['hold exactly at the server clock boundary', { holdExpiresAt: NOW }],
  ['expired hold', { holdExpiresAt: new Date(NOW.getTime() - 1) }],
  ['accepted', { status: 'ACCEPTED' as OrderStatus }],
  ['preparing', { status: 'PREPARING' as OrderStatus }],
  ['ready', { status: 'READY_FOR_PICKUP' as OrderStatus }],
  ['rider assigned', { riderId: 'rider-1' }],
  ['driver assigned', { driverId: 'driver-1' }],
];

const TAXI_CUSTODY_CASES: Array<[string, Partial<CustomerCancellationSnapshot>]> = [
  ['ride in progress', { status: 'RIDE_IN_PROGRESS' as OrderStatus }],
  ['PIN handoff before start', {
    status: 'DRIVER_ARRIVED' as OrderStatus,
    ridePinVerified: true,
    ridePinVerifiedAt: NOW,
  }],
];

function snapshot(
  overrides: Partial<CustomerCancellationSnapshot> = {},
): CustomerCancellationSnapshot {
  return {
    status: 'PENDING',
    orderType: 'FOOD_DELIVERY',
    placedAt: new Date(NOW.getTime() - 60_000),
    holdExpiresAt: new Date(NOW.getTime() + 4 * 60_000),
    riderId: null,
    driverId: null,
    scheduledFor: null,
    paymentMethod: 'CASH',
    paymentStatus: 'PENDING',
    ridePinVerified: false,
    ridePinVerifiedAt: null,
    ...overrides,
  };
}

describe('customerCancellationDenial — one projection/write authority', () => {
  it.each(['FOOD_DELIVERY', 'GROCERY_DELIVERY'])(
    'allows an unassigned %s order only inside its active vendor-silent hold',
    (orderType) => {
      expect(customerCancellationDenial(snapshot({ orderType }), NOW)).toBeNull();
    },
  );

  it.each(MARKET_DENIAL_CASES)('denies marketplace cancellation after %s', (_label, overrides) => {
    expect(customerCancellationDenial(snapshot(overrides), NOW)).toMatchObject({
      statusCode: 409,
      code: 'CANCELLATION_WINDOW_CLOSED',
    });
  });

  it('does not let a far-future scheduled slot extend an expired marketplace hold', () => {
    expect(customerCancellationDenial(snapshot({
      holdExpiresAt: new Date(NOW.getTime() - 1),
      scheduledFor: new Date(NOW.getTime() + 7 * 24 * 60 * 60_000),
    }), NOW)).toMatchObject({ code: 'CANCELLATION_WINDOW_CLOSED' });
  });

  it.each([
    ['CLAIMED', 'The store has recorded this MMG payment as received.'],
    ['CAPTURED', 'MMG has confirmed this payment to the store.'],
  ])(
    'returns a truthful MMG money-state denial for %s',
    (paymentStatus, expectedLead) => {
      const denial = customerCancellationDenial(snapshot({
        paymentMethod: 'MOBILE_MONEY',
        paymentStatus,
      }), NOW);
      expect(denial).toMatchObject({
        statusCode: 409,
        code: 'MMG_CANCEL_UNAVAILABLE',
      });
      expect(denial?.message).toContain(expectedLead);
    },
  );

  it('marks terminal FAILED as unavailable instead of projecting a dead action', () => {
    expect(customerCancellationDenial(snapshot({ status: 'FAILED' }), NOW)).toMatchObject({
      statusCode: 400,
      code: 'INVALID_STATUS',
    });
  });

  it.each(TAXI_CUSTODY_CASES)('denies taxi cancellation in passenger custody: %s', (_label, overrides) => {
    expect(customerCancellationDenial(snapshot({
      orderType: 'TAXI',
      holdExpiresAt: null,
      ...overrides,
    }), NOW)).toMatchObject({
      statusCode: 400,
      code: 'IN_TRANSIT',
    });
  });

  it('preserves the pre-custody taxi and courier cancellation contracts', () => {
    expect(customerCancellationDenial(snapshot({
      orderType: 'TAXI',
      status: 'DRIVER_ASSIGNED',
      holdExpiresAt: null,
      driverId: 'driver-1',
    }), NOW)).toBeNull();
    expect(customerCancellationDenial(snapshot({
      orderType: 'COURIER',
      status: 'READY_FOR_PICKUP',
      holdExpiresAt: null,
    }), NOW)).toBeNull();
  });
});

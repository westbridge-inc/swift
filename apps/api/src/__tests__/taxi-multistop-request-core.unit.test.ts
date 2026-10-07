import { describe, expect, it, vi } from 'vitest';
import type { FareService } from '../modules/rides/fare.service';
import type { DispatchService } from '../modules/dispatch/dispatch.service';

vi.mock('../modules/cash/cash-rules.service', () => ({
  orderingRestriction: vi.fn().mockResolvedValue(null),
}));

import {
  createRideRequest,
  RideRequestOutcomeUnknownError,
  type RideRequestApp,
  type RideRequestBody,
} from '../modules/rides/rides.service';

// ---------------------------------------------------------------------------
// [TAXI multi-stop 3/8] The request core (rides.service createRideRequest)
// with stops, driven with doubles so each of its own decisions can be seen:
// the quoted-fare belt for callers other than the route, the whole-route
// price, the stop rows and the receipt written in the ride's own
// transaction, and the commit whose outcome is unknown. The route-level
// proof (real database, real routes) is taxi-multistop-request.test.ts.
// ---------------------------------------------------------------------------

const STOPS = [
  { sequence: 1, lat: 6.412, lng: -58.618, address: 'Bartica Stelling' },
  { sequence: 2, lat: 6.4, lng: -58.61, address: 'Second Avenue' },
] as const;
const LEGS = [
  { from: 'PICKUP', to: 'STOP_1', meters: 866, seconds: 120 },
  { from: 'STOP_1', to: 'STOP_2', meters: 1600, seconds: 240 },
  { from: 'STOP_2', to: 'DESTINATION', meters: 2400, seconds: null },
];

function body(extra: Partial<RideRequestBody> = {}): RideRequestBody {
  return {
    pickup: { lat: 6.406, lng: -58.623 },
    dropoff: { lat: 6.418, lng: -58.63 },
    pickupAddress: 'Bartica Police Station',
    dropoffAddress: 'Bartica Airstrip',
    passengerCount: 1,
    rideClass: 'ECONOMY',
    stops: STOPS,
    expectedFare: 3500,
    ...extra,
  };
}

function doubles(opts: { commit?: 'ok' | 'fail-after-work'; receiptLanded?: boolean; insertError?: unknown } = {}) {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'customer-1', tenantId: 'tenant-1', status: 'ACTIVE' }]),
    order: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (_args: unknown) => {
        if (opts.insertError) throw opts.insertError;
        return { id: 'ride-1', orderNumber: 'SW-TEST-1', status: 'PENDING' };
      }),
    },
    checkoutReceipt: { create: vi.fn(async () => ({ id: 'receipt-1' })) },
  };
  const checkoutReceiptCount = vi.fn(async () => (opts.receiptLanded ? 1 : 0));
  const app = {
    prisma: {
      user: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: 'customer-1', tenantId: 'tenant-1', tenant: { kind: 'PRODUCTION' }, countryCode: 'GY', trustLevel: 'L2', selfieCapturedAt: new Date('2026-09-12T00:00:00Z'),
        })),
      },
      order: { findFirst: vi.fn(async () => null), count: vi.fn(async () => 3) },
      $transaction: vi.fn(async (callback: (t: typeof tx) => unknown) => {
        const result = await callback(tx);
        if (opts.commit === 'fail-after-work') throw new Error('connection reset during COMMIT');
        return result;
      }),
      supplyWatch: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      checkoutReceipt: { count: checkoutReceiptCount },
    },
  } as unknown as RideRequestApp;
  const fare = {
    estimateTiers: vi.fn(),
    estimateItineraryTiers: vi.fn(async () => ({
      tiers: [{ rideClass: 'ECONOMY', fare: 3500, multiplier: 1, capacity: 4, source: 'formula' }],
      currencyCode: 'GYD', distanceKm: 4.9, durationMin: 12, billableKm: 4.87, routeSource: 'osrm', legs: LEGS,
    })),
  } as unknown as FareService;
  const dispatch = { dispatchOrder: vi.fn(async () => ({})) } as unknown as DispatchService;
  return { app, tx, fare, dispatch, checkoutReceiptCount };
}

describe('the quoted fare', () => {
  it('a caller other than the route that sends none books nothing: 409 FARE_CHANGED naming the fare, before the transaction', async () => {
    const d = doubles();
    await expect(createRideRequest(d.app, d.fare, d.dispatch, 'customer-1', body({ expectedFare: undefined })))
      .rejects.toMatchObject({ statusCode: 409, code: 'FARE_CHANGED', details: { expectedFare: null, fare: 3500 } });
    expect(d.app.prisma.$transaction).not.toHaveBeenCalled();
    expect(d.dispatch.dispatchOrder).not.toHaveBeenCalled();
  });

  it('a fare that moved since the quote books nothing: 409 FARE_CHANGED with the fare now, before the transaction', async () => {
    const d = doubles();
    await expect(createRideRequest(d.app, d.fare, d.dispatch, 'customer-1', body({ expectedFare: 3400 })))
      .rejects.toMatchObject({ statusCode: 409, code: 'FARE_CHANGED', details: { expectedFare: 3400, fare: 3500, rideClass: 'ECONOMY', currencyCode: 'GYD' } });
    expect(d.app.prisma.$transaction).not.toHaveBeenCalled();
    expect(d.dispatch.dispatchOrder).not.toHaveBeenCalled();
  });
});

describe('a ride with stops', () => {
  it('is priced over its whole route (never the single leg), and its stops commit with it, each with the leg that ends at it', async () => {
    const d = doubles();
    const { answer } = await createRideRequest(d.app, d.fare, d.dispatch, 'customer-1', body());
    expect(d.fare.estimateTiers).not.toHaveBeenCalled();
    expect(d.fare.estimateItineraryTiers).toHaveBeenCalledWith(body().pickup, STOPS, body().dropoff, 'GY', 'tenant-1');
    const data = (d.tx.order.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      taxiFareTotal: 3500, totalAmount: 3500, taxiDistance: 4.9, billableKm: 4.87, billableKmSource: 'osrm', taxiDuration: 12,
      deliveryLat: 6.418, deliveryLng: -58.63, taxiDropoffAddress: 'Bartica Airstrip', taxiStopCount: 2,
    });
    expect(data['taxiStops']).toEqual({
      create: [
        { tenantId: 'tenant-1', sequence: 1, lat: 6.412, lng: -58.618, address: 'Bartica Stelling', legMeters: 866, legSeconds: 120 },
        { tenantId: 'tenant-1', sequence: 2, lat: 6.4, lng: -58.61, address: 'Second Avenue', legMeters: 1600, legSeconds: 240 },
      ],
    });
    expect(answer.ride).toMatchObject({ fare: 3500, stopCount: 2, stops: [{ sequence: 1 }, { sequence: 2 }] });
    // No key, no receipt.
    expect(d.tx.checkoutReceipt.create).not.toHaveBeenCalled();
    expect(d.dispatch.dispatchOrder).toHaveBeenCalledWith('ride-1', 'tenant-1');
  });

  it('with a key, the receipt is written in the SAME transaction as the ride, holding the answer but never the PIN', async () => {
    const d = doubles();
    const committed = vi.fn();
    const { answer, ridePin } = await createRideRequest(d.app, d.fare, d.dispatch, 'customer-1', body(), true, undefined, {
      idempotency: { key: 'taxi-request:key-0001', requestHash: 'hash-1' }, onCommitted: committed,
    });
    expect(d.tx.checkoutReceipt.create).toHaveBeenCalledTimes(1);
    const receipt = (d.tx.checkoutReceipt.create.mock.calls[0] as unknown as [{ data: { userId: string; idempotencyKey: string; requestHash: string; orderIds: string[]; result: unknown } }])[0].data;
    expect(receipt).toMatchObject({ userId: 'customer-1', idempotencyKey: 'taxi-request:key-0001', requestHash: 'hash-1', orderIds: ['ride-1'] });
    expect(JSON.stringify(receipt.result)).not.toContain(ridePin);
    expect(answer.ride.ridePin).toBe(ridePin);
    expect(committed).toHaveBeenCalledWith({ orderId: 'ride-1', receiptId: 'receipt-1' });
  });

  it('another request under the same key committed first (the receipt\'s unique key): 409 DUPLICATE_REQUEST, never a raw constraint error', async () => {
    const d = doubles({ insertError: Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['userId', 'idempotencyKey'] } }) });
    await expect(createRideRequest(d.app, d.fare, d.dispatch, 'customer-1', body(), true, undefined, {
      idempotency: { key: 'taxi-request:key-0002', requestHash: 'hash-2' },
    })).rejects.toMatchObject({ statusCode: 409, code: 'DUPLICATE_REQUEST' });
  });
});

describe('a commit whose outcome is unknown (the work was done, the COMMIT failed or lost its answer)', () => {
  it('with a key and no receipt to prove it: 503 RIDE_REQUEST_OUTCOME_UNKNOWN, not "nothing booked", and no dispatch', async () => {
    const d = doubles({ commit: 'fail-after-work', receiptLanded: false });
    const committed = vi.fn();
    const attempt = createRideRequest(d.app, d.fare, d.dispatch, 'customer-1', body(), true, undefined, {
      idempotency: { key: 'taxi-request:key-0003', requestHash: 'hash-3' }, onCommitted: committed,
    });
    await expect(attempt).rejects.toBeInstanceOf(RideRequestOutcomeUnknownError);
    await expect(attempt).rejects.toMatchObject({ statusCode: 503, code: 'RIDE_REQUEST_OUTCOME_UNKNOWN' });
    expect(d.checkoutReceiptCount).toHaveBeenCalledWith({ where: { id: 'receipt-1' } });
    expect(committed).not.toHaveBeenCalled();
    expect(d.dispatch.dispatchOrder).not.toHaveBeenCalled();
  });

  it('with a key and the receipt there: the ride committed, so it carries on as committed', async () => {
    const d = doubles({ commit: 'fail-after-work', receiptLanded: true });
    const committed = vi.fn();
    const { order } = await createRideRequest(d.app, d.fare, d.dispatch, 'customer-1', body(), true, undefined, {
      idempotency: { key: 'taxi-request:key-0004', requestHash: 'hash-4' }, onCommitted: committed,
    });
    expect(order.id).toBe('ride-1');
    expect(committed).toHaveBeenCalledWith({ orderId: 'ride-1', receiptId: 'receipt-1' });
    expect(d.dispatch.dispatchOrder).toHaveBeenCalledWith('ride-1', 'tenant-1');
  });

  it('without a key the error stands exactly as it always has', async () => {
    const d = doubles({ commit: 'fail-after-work' });
    await expect(createRideRequest(d.app, d.fare, d.dispatch, 'customer-1', body()))
      .rejects.toThrow('connection reset during COMMIT');
    expect(d.checkoutReceiptCount).not.toHaveBeenCalled();
  });
});

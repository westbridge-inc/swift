import { describe, expect, it, vi } from 'vitest';
import type { FareService } from '../modules/rides/fare.service';
import type { DispatchService } from '../modules/dispatch/dispatch.service';

vi.mock('../modules/cash/cash-rules.service', () => ({
  orderingRestriction: vi.fn().mockResolvedValue(null),
}));

import { createRideRequest, type RideRequestApp } from '../modules/rides/rides.service';

const body = {
  pickup: { lat: 6.8013, lng: -58.1553 },
  dropoff: { lat: 6.8143, lng: -58.1443 },
  pickupAddress: 'Stabroek Market',
  dropoffAddress: 'Camp Street',
  passengerCount: 1,
  rideClass: 'ECONOMY' as const,
};

describe('taxi request authority', () => {
  it('rechecks the tenant-scoped active ride after the customer lock and before insert', async () => {
    const events: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => {
        events.push('customer-lock');
        return [{ id: 'customer-1', tenantId: 'tenant-1', status: 'ACTIVE' }];
      }),
      order: {
        findFirst: vi.fn(async () => {
          events.push('active-taxi-read');
          return { id: 'winning-ride' };
        }),
        create: vi.fn(async () => {
          events.push('order-insert');
          return { id: 'losing-ride', orderNumber: 'SW-TEST', status: 'PENDING' };
        }),
      },
    };
    const dispatchAdd = vi.fn(async () => undefined);
    const app = {
      prisma: {
        user: {
          findUniqueOrThrow: vi.fn(async () => ({
            id: 'customer-1',
            tenantId: 'tenant-1',
            countryCode: 'GY',
            trustLevel: 'L2',
            selfieCapturedAt: new Date('2026-09-12T00:00:00Z'),
          })),
        },
        order: {
          // The historical pre-flight remains clear, then another request wins
          // before this request acquires the customer lock.
          findFirst: vi.fn(async () => null),
          count: vi.fn(async () => 10),
        },
        $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
        supplyWatch: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      },
      dispatchQueue: { add: dispatchAdd },
    } as unknown as RideRequestApp;
    const fare = {
      estimateTiers: vi.fn(async () => ({
        tiers: [{ rideClass: 'ECONOMY', fare: 2_000, capacity: 4, source: 'formula' }],
        currencyCode: 'GYD',
        distanceKm: 4,
        durationMin: 12,
        billableKm: 4,
        routeSource: 'haversine',
      })),
    } as unknown as FareService;
    const dispatch = { dispatchOrder: vi.fn() } as unknown as DispatchService;

    await expect(createRideRequest(
      app,
      fare,
      dispatch,
      'customer-1',
      body,
      false,
      'tenant-1',
    )).rejects.toMatchObject({ statusCode: 409, code: 'RIDE_IN_PROGRESS' });

    expect(events).toEqual(['customer-lock', 'active-taxi-read']);
    expect(tx.order.findFirst).toHaveBeenCalledWith({
      where: {
        customerId: 'customer-1',
        tenantId: 'tenant-1',
        orderType: 'TAXI',
        status: {
          in: ['PENDING', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'],
        },
      },
      select: { id: true },
    });
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(dispatchAdd).not.toHaveBeenCalled();
    expect(dispatch.dispatchOrder).not.toHaveBeenCalled();
  });
});

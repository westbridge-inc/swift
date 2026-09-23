/**
 * [ORDER-SPINE S1-6 · R4 · F-PR1262-SOL-02] The food-age cutoff runs before the
 * direct-MMG offer gate, and the gate still stands before anything offer-shaped.
 *
 * R3 put `mmgDispatchBlocked` ahead of the cutoff, so an unpaid (or disputed)
 * MMG order too old to deliver was neither offered nor retired by the dispatch
 * event: it waited, silently, for the five-minute food-age sweep. These drive
 * the real `DispatchService.dispatchOrder` over an in-memory order and config
 * (the shipped defaults: FOOD 45 min, rider capacity 1). Only the retirement
 * write itself is replaced — which order it cancels and which it holds for a
 * person is `settleTooOldOrder`'s CAS, proven against PostgreSQL in
 * rescue.test.ts; here the question is whether dispatch reaches it at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rescue = vi.hoisted(() => ({ retired: [] as Array<{ orderId: string; ageMinutes: number; limitMinutes: number }> }));
vi.mock('../modules/dispatch/rescue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modules/dispatch/rescue')>()),
  retireTooOldOrder: vi.fn(async (_deps: unknown, order: { id: string }, ageMinutes: number, limitMinutes: number) => {
    rescue.retired.push({ orderId: order.id, ageMinutes, limitMinutes });
    return true;
  }),
}));

import { DispatchService } from '../modules/dispatch/dispatch.service';

const MIN = 60_000;

function order(over: Record<string, unknown>) {
  return {
    id: 'order-mmg-1', status: 'READY_FOR_PICKUP', riderId: null, driverId: null, orderType: 'FOOD_DELIVERY',
    fulfillment: 'DELIVERY', orderNumber: 'SW-4001', rideClass: null, isExpress: false, courierPackageSize: null,
    customerId: 'customer-1', pickupLat: 6.8, pickupLng: -58.15, taxiPassengerCount: null, subtotalBase: 3000,
    paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING', tenantId: 'tenant-a', readyAt: null,
    foodAgeHeldAt: null, foodAgeWaivedAt: null, mmgClaimMismatchAt: null,
    totalAmount: 3500, subtotalCustomer: 3000, deliveryFee: 500, serviceFee: 0, taxAmount: 0, tipAmount: 0, discount: 0,
    vendor: { name: 'Cutoff Diner', owner: { userId: 'owner-user' } }, items: [],
    ...over,
  };
}

function harness(row: Record<string, unknown>, liveOffer: string | null = null) {
  const redisReads: string[] = [];
  const prisma = {
    order: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === row['id'] ? structuredClone(row) : null) },
    // No configured row: every tunable resolves to its shipped default.
    algoConfig: { findFirst: async () => null },
  };
  const redis = { get: async (key: string) => { redisReads.push(key); return key.startsWith('dispatch:offer:') ? liveOffer : null; } };
  const dispatch = new DispatchService(prisma as never, redis as never, {} as never, {} as never);
  return { dispatch, redisReads };
}

const ready = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MIN);
const DISPUTED = { paymentStatus: 'CLAIMED', mmgClaimMismatchAt: new Date() };

beforeEach(() => { rescue.retired.length = 0; });

describe('the food-age cutoff runs before the direct-MMG offer gate [R4 · F-PR1262-SOL-02]', () => {
  it('an unpaid MMG order too old to deliver is retired by the dispatch event itself — not left for the sweep', async () => {
    const { dispatch, redisReads } = harness(order({ readyAt: ready(60) }));
    expect(await dispatch.dispatchOrder('order-mmg-1')).toEqual({ exhausted: true });
    expect(rescue.retired).toEqual([{ orderId: 'order-mmg-1', ageMinutes: 60, limitMinutes: 45 }]);
    expect(redisReads, 'no offer step was reached').toEqual([]);
  });

  it('a disputed MMG order too old to deliver reaches the cutoff too — its CAS holds claimed money for a person', async () => {
    const { dispatch } = harness(order({ readyAt: ready(60), ...DISPUTED }));
    expect(await dispatch.dispatchOrder('order-mmg-1')).toEqual({ exhausted: true });
    expect(rescue.retired.map((r) => r.orderId)).toEqual(['order-mmg-1']);
  });

  it.each([
    ['unpaid', {}],
    ['disputed', DISPUTED],
  ])('a %s MMG order still in time is not offered: the gate stands before any offer step', async (_label, over) => {
    const { dispatch, redisReads } = harness(order({ readyAt: ready(20), ...over }), 'rider-9:attempt-1');
    expect(await dispatch.dispatchOrder('order-mmg-1')).toEqual({});
    expect(rescue.retired).toEqual([]);
    expect(redisReads, 'not even the live-offer read').toEqual([]);
  });

  it('an operator’s "deliver anyway" waives the cutoff, and the gate still refuses unpaid work', async () => {
    const { dispatch, redisReads } = harness(order({ readyAt: ready(60), foodAgeWaivedAt: new Date() }));
    expect(await dispatch.dispatchOrder('order-mmg-1')).toEqual({});
    expect(rescue.retired).toEqual([]);
    expect(redisReads).toEqual([]);
  });

  it('positive control: a paid, undisputed MMG order in time passes the gate and reaches the offer step', async () => {
    const { dispatch, redisReads } = harness(order({ readyAt: ready(20), paymentStatus: 'CLAIMED' }), 'rider-9:attempt-1');
    expect(await dispatch.dispatchOrder('order-mmg-1')).toEqual({ offered: 'rider-9' });
    expect(redisReads).toEqual(['dispatch:offer:order-mmg-1']);
    expect(rescue.retired).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OrderService } from '../modules/order/order.service';
import { NotificationService } from '../modules/notification/notification.service';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { computeDaySlots, fmtSlotTime } from '../modules/booking/availability';
import {
  LATE_CANCEL_FEE,
  freeCancellationExpiresAt,
  isFreeCancellation,
  type CancellationSnapshot,
} from '../modules/order/cancel-policy';
import { orderVertical } from '../modules/order/order-vertical';
import {
  MINUTE,
  foodDelivery,
  hostRoutes,
  orderStore,
  prismaDouble,
  recordingIo,
  recordingRedis,
  serviceBooking,
  type Row,
} from './helpers/service-vertical-doubles';

// ---------------------------------------------------------------------------
// R2 — THE FOUR API FINDINGS OF THE AUTHOR-SEPARATED REVIEW, RED FIRST.
//
//   F01  A booking's slot carries the LOCAL wall-clock on its UTC face (the
//        SCH-F convention in booking/availability.ts: the vendor types "10:00",
//        the picker shows 10:00, the row holds 10:00Z). The cancellation policy
//        read that face as a real instant, so in Guyana (UTC-4, no DST) the
//        free window closed at 05:55 for a 10:00 haircut and the locked cancel
//        recorded the GYD 500 marker four hours early. The slot is resolved
//        through the market zone before the cutoff is computed, in ONE place,
//        so the customer preview and the locked cancel agree.
//   F02  Every order at a SERVICE business was declared SERVICE, so shampoo
//        bought from a barbershop by delivery read "Booking confirmed" and lost
//        its delivery stages. Only an APPOINTMENT is a booking.
//   F03  A booking could be marked PREPARING and READY_FOR_PICKUP — "Food
//        Ready!" on a haircut — and then /complete-appointment refused it. The
//        route handlers refuse a booking, and the locked canonical transition
//        refuses it for every caller.
//   F04  A successful cancel answered "Order cancelled … the store refunds you
//        directly" for a booking, and the tracking screen shows the server's
//        result first. The noun and the party follow the committed row's
//        fulfillment; the fee and the MMG uncertainty are the server's, as
//        before.
//
// Every case drives the real seam: the real route handlers on the recording
// stand-in, the real OrderService with its real canonical transition against
// the projecting/grading doubles, the real slot producer, the real predicate.
// Nothing opens PostgreSQL, Redis, a socket, a queue or a provider.
// ---------------------------------------------------------------------------

type Push = { userId: string; type: string; title: string; body: string; data?: Record<string, unknown> };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const asCustomer = (extra: Record<string, unknown> = {}) => ({ user: { userId: 'user-customer', role: 'CUSTOMER' }, ...extra });
const asProvider = (extra: Record<string, unknown> = {}) => ({ user: { userId: 'user-provider', role: 'VENDOR_OWNER' }, body: {}, ...extra });

/** A prisma double that runs the REAL transaction bodies (cancellation, the
 *  canonical transition) against the order store, with every side model the
 *  seams reach modelled as the smallest honest answer. */
function harness(rows: Row[]) {
  const store = orderStore(rows);
  const extra: Record<string, unknown> = {
    $queryRaw: async () => [],
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    booking: { updateMany: async () => ({ count: 1 }) },
    dispatchSearch: { updateMany: async () => ({ count: 0 }) },
    orderItem: { findMany: async () => [] },
    orderStatusLog: { create: async (args: { data: Row }) => args.data },
    vendor: {
      findUnique: async (args: { where: { id: string } }) => ({
        id: args.where.id, ownerId: args.where.id === 'vendor-svc' ? 'owner-svc' : 'owner-food',
        owner: { userId: args.where.id === 'vendor-svc' ? 'user-provider' : 'user-cook' },
        vendorType: args.where.id === 'vendor-svc' ? 'SERVICE' : 'RESTAURANT',
        isVerified: true, status: 'ACTIVE', selfDeliveryEnabled: false, acceptingOrders: true,
      }),
      findMany: async () => [],
    },
    vendorOwner: {
      findUnique: async () => ({ id: 'owner-svc', userId: 'user-provider', vendors: [{ id: 'vendor-svc' }, { id: 'vendor-food' }] }),
    },
    subscription: { findFirst: async () => null },
    algoConfig: { findFirst: async () => null },
    platformConfig: { findUnique: async () => null },
    alertDelivery: { updateMany: async () => ({ count: 0 }) },
    notification: { updateMany: async () => ({ count: 0 }) },
    user: { findUnique: async () => ({ countryCode: 'GY' }) },
    customer: { findUnique: async () => ({ id: 'cust-1', userId: 'user-customer', referralCode: 'REF1' }) },
    item: { findMany: async () => [] },
    countryConfig: { findUnique: async () => null },
    rating: { findMany: async () => [] },
  };
  const prisma = prismaDouble(store, extra);
  const io = recordingIo();
  const pushes: Push[] = [];
  vi.spyOn(NotificationService.prototype, 'send').mockImplementation(async (payload) => {
    pushes.push(payload as unknown as Push);
    return 'notice-1';
  });
  return { store, prisma, io, pushes, svc: new OrderService(prisma, io) };
}

// ── F01 ─────────────────────────────────────────────────────────────────────

describe('F01 — a booking is cancelled by its LOCAL slot, resolved through the market zone', () => {
  const PLACED_AT = new Date('2026-09-23T14:00:00.000Z');
  /** The REAL producer: Thursday 24 September 2026, one 10:00–10:30 window. */
  const slot = computeDaySlots({
    itemId: 'item-haircut',
    config: { durationMinutes: 30, slots: [{ dayOfWeek: 4, start: '10:00', end: '10:30' }] },
    year: 2026, month: 9, day: 24, exceptions: [], takenStarts: [], now: PLACED_AT,
  })[0]!;
  /** 09:55 in America/Guyana on the 24th — five minutes before the 10:00 the picker shows. */
  const LOCAL_CUTOFF = new Date('2026-09-24T13:55:00.000Z');
  const JUST_BEFORE = new Date(LOCAL_CUTOFF.getTime() - 1);
  const JUST_AFTER = new Date(LOCAL_CUTOFF.getTime() + 1);
  /** The reviewer's reproduction: 09:55Z is 05:55 local, four hours before the slot. */
  const FOUR_HOURS_EARLY = new Date('2026-09-24T09:55:00.000Z');
  const guyanaClock = (d: Date) => d.toLocaleString('en-GB', { timeZone: 'America/Guyana', hour: '2-digit', minute: '2-digit', hour12: false });

  const pendingBooking = () => serviceBooking('bk-r2', { placedAt: PLACED_AT, updatedAt: PLACED_AT, holdExpiresAt: null, appointmentSlot: slot });

  it('the producer stores the local wall-clock on the UTC face, the picker shows it, and it happens at 14:00Z', () => {
    expect(slot.toISOString()).toBe('2026-09-24T10:00:00.000Z');
    expect(fmtSlotTime(slot)).toBe('Thu 24 Sept, 10:00');
    expect(guyanaClock(new Date('2026-09-24T14:00:00.000Z'))).toBe('10:00');
    expect(guyanaClock(FOUR_HOURS_EARLY)).toBe('05:55');
  });

  it('RED — the predicate is free until the LOCAL cutoff and the promised window ends there, not four hours early', () => {
    const row = pendingBooking() as unknown as CancellationSnapshot;
    expect(isFreeCancellation(row, FOUR_HOURS_EARLY)).toBe(true);
    expect(isFreeCancellation(row, JUST_BEFORE)).toBe(true);
    expect(isFreeCancellation(row, LOCAL_CUTOFF)).toBe(false);
    expect(isFreeCancellation(row, JUST_AFTER)).toBe(false);
    expect(freeCancellationExpiresAt(row, FOUR_HOURS_EARLY)?.toISOString()).toBe(LOCAL_CUTOFF.toISOString());
    expect(freeCancellationExpiresAt(row, JUST_BEFORE)?.toISOString()).toBe(LOCAL_CUTOFF.toISOString());
    expect(freeCancellationExpiresAt(row, LOCAL_CUTOFF)).toBeNull();
  });

  const moments: Array<[string, Date, boolean]> = [
    ['at 05:55 local — the four-hour-early moment the review reproduced', FOUR_HOURS_EARLY, true],
    ['just before the local cutoff', JUST_BEFORE, true],
    ['exactly at the local cutoff', LOCAL_CUTOFF, false],
    ['just after the local cutoff', JUST_AFTER, false],
  ];

  for (const [label, at, free] of moments) {
    it(`RED — the preview and the locked cancel agree ${label}: ${free ? 'free, no marker' : `not free, the ${LATE_CANCEL_FEE} marker`}`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(at);
      const h = harness([pendingBooking()]);
      const customer = await hostRoutes(customerRoutes, { prisma: h.prisma, redis: recordingRedis(), io: h.io });
      const preview = (await customer.call('get /orders/:id', asCustomer({ params: { id: 'bk-r2' } }))) as { data: Row };
      expect(preview.data).toMatchObject({
        vertical: 'SERVICE',
        canCancel: true,
        freeCancellationWindow: free,
        cancellationFee: free ? 0 : LATE_CANCEL_FEE,
        freeCancellationExpiresAt: free ? LOCAL_CUTOFF.toISOString() : null,
      });
      const result = await h.svc.cancelOrder('bk-r2', 'user-customer');
      expect(result.cancellationFee).toBe(free ? 0 : LATE_CANCEL_FEE);
      expect(h.store.rows[0]).toMatchObject({ status: 'CANCELLED', lateCancelFeeDue: free ? 0 : LATE_CANCEL_FEE });
    });
  }

  it('control — scheduledFor is a real instant and is read as one: no offset is applied to it', () => {
    const scheduled = { ...pendingBooking(), fulfillment: 'DELIVERY', appointmentSlot: null, scheduledFor: new Date('2026-09-24T18:00:00.000Z') } as unknown as CancellationSnapshot;
    expect(isFreeCancellation(scheduled, PLACED_AT)).toBe(true);
    expect(freeCancellationExpiresAt(scheduled, PLACED_AT)?.toISOString()).toBe('2026-09-24T17:55:00.000Z');
    expect(isFreeCancellation(scheduled, new Date('2026-09-24T17:55:00.000Z'))).toBe(false);
  });

  it('control — the checkout hold still wins while it runs, and an accepted booking is still committed', () => {
    const held = { ...pendingBooking(), holdExpiresAt: new Date(PLACED_AT.getTime() + 5 * MINUTE) } as unknown as CancellationSnapshot;
    expect(isFreeCancellation(held, new Date(PLACED_AT.getTime() + MINUTE))).toBe(true);
    expect(freeCancellationExpiresAt(held, new Date(PLACED_AT.getTime() + MINUTE))?.getTime()).toBe(held.holdExpiresAt!.getTime());
    const accepted = { ...pendingBooking(), status: 'ACCEPTED' } as unknown as CancellationSnapshot;
    expect(isFreeCancellation(accepted, FOUR_HOURS_EARLY)).toBe(false);
  });
});

// ── F02 ─────────────────────────────────────────────────────────────────────

describe('F02 — only an APPOINTMENT is a booking; a service business’s goods keep their delivery words', () => {
  const shampoo = [{ id: 'oi-9', itemId: 'item-shampoo', name: 'Shampoo', quantity: 1, basePrice: 1500, markedUpPrice: 1500, totalCustomer: 1500, totalBase: 1500, specialInstructions: null, bulkUnits: null, selectedOptions: [] }];
  const goods = (id: string, fulfillment: 'DELIVERY' | 'PICKUP') => serviceBooking(id, { fulfillment, appointmentSlot: null, items: shampoo });

  it('RED — the declared discriminator answers SERVICE for an appointment only, whoever takes it', () => {
    expect(orderVertical({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', vendor: { vendorType: 'SERVICE' } })).toBe('FOOD_DELIVERY');
    expect(orderVertical({ orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', vendor: { vendorType: 'SERVICE' } })).toBe('FOOD_DELIVERY');
    expect(orderVertical({ orderType: 'GROCERY_DELIVERY', fulfillment: 'DELIVERY', vendor: { vendorType: 'SERVICE' } })).toBe('GROCERY_DELIVERY');
    expect(orderVertical({ orderType: 'FOOD_DELIVERY', fulfillment: 'APPOINTMENT', vendor: { vendorType: 'SERVICE' } })).toBe('SERVICE');
    expect(orderVertical({ orderType: 'FOOD_DELIVERY', fulfillment: 'APPOINTMENT', vendor: { vendorType: 'RESTAURANT' } })).toBe('SERVICE');
    expect(orderVertical({ orderType: 'FOOD_DELIVERY', fulfillment: 'APPOINTMENT', vendor: null })).toBe('SERVICE');
  });

  it('RED — GET /orders projects the same barbershop’s delivery, pickup and appointment as FOOD_DELIVERY, FOOD_DELIVERY, SERVICE', async () => {
    const h = harness([goods('svc-delivery', 'DELIVERY'), goods('svc-pickup', 'PICKUP'), serviceBooking('svc-booking')]);
    const customer = await hostRoutes(customerRoutes, { prisma: h.prisma, redis: recordingRedis(), io: h.io });
    const res = (await customer.call('get /orders', asCustomer())) as { success: boolean; data: Row[] };
    expect(res.success).toBe(true);
    const byId = Object.fromEntries(res.data.map((o) => [o['id'] as string, o]));
    expect(byId['svc-delivery']).toMatchObject({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', vertical: 'FOOD_DELIVERY', vendor: { vendorType: 'SERVICE' } });
    expect(byId['svc-pickup']).toMatchObject({ orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', vertical: 'FOOD_DELIVERY', vendor: { vendorType: 'SERVICE' } });
    expect(byId['svc-booking']).toMatchObject({ orderType: 'FOOD_DELIVERY', fulfillment: 'APPOINTMENT', vertical: 'SERVICE', vendor: { vendorType: 'SERVICE' } });
  });

  it('RED — Home’s live card for a service business’s delivery is a delivery, with the business type still beside it', async () => {
    const h = harness([goods('svc-delivery', 'DELIVERY')]);
    const customer = await hostRoutes(customerRoutes, { prisma: h.prisma, redis: recordingRedis(), io: h.io });
    const res = (await customer.call('get /home', asCustomer())) as { data: { activeOrder: Row | null } };
    expect(res.data.activeOrder).toMatchObject({ id: 'svc-delivery', fulfillment: 'DELIVERY', vertical: 'FOOD_DELIVERY', vendor: { vendorType: 'SERVICE' } });
  });
});

// ── F03 ─────────────────────────────────────────────────────────────────────

describe('F03 — a booking never enters a kitchen state', () => {
  const accepted = () => serviceBooking('bk-r2', { status: 'ACCEPTED', acceptedAt: new Date() });

  it('RED — /preparing refuses an ACCEPTED booking: state unchanged, no order write, no kitchen push, no dispatch job, no socket event', async () => {
    const h = harness([accepted()]);
    const host = await hostRoutes(vendorRoutes, { prisma: h.prisma, redis: recordingRedis(), io: h.io });
    await expect(host.call('put /orders/:id/preparing', asProvider({ params: { id: 'bk-r2' } }))).rejects.toMatchObject({ code: 'NOT_A_KITCHEN_ORDER', statusCode: 400 });
    expect(h.store.rows[0]).toMatchObject({ status: 'ACCEPTED', preparingAt: null });
    // Exactly the route's ownership read; the locked seam never re-read the row.
    expect(h.store.queries.filter((q) => q.method === 'order.findUnique')).toHaveLength(1);
    expect(h.store.queries.filter((q) => q.method.startsWith('order.update'))).toEqual([]);
    expect(h.pushes).toEqual([]);
    expect(host.enqueued).toEqual([]);
    expect(h.io.emits).toEqual([]);
  });

  it('RED — /ready refuses a booking that already sits in PREPARING (an older client cannot reopen the kitchen path): no "Food Ready!"', async () => {
    const h = harness([serviceBooking('bk-r2', { status: 'PREPARING', acceptedAt: new Date(), preparingAt: new Date() })]);
    const host = await hostRoutes(vendorRoutes, { prisma: h.prisma, redis: recordingRedis(), io: h.io });
    await expect(host.call('put /orders/:id/ready', asProvider({ params: { id: 'bk-r2' } }))).rejects.toMatchObject({ code: 'NOT_A_KITCHEN_ORDER', statusCode: 400 });
    expect(h.store.rows[0]).toMatchObject({ status: 'PREPARING', readyAt: null });
    // Exactly the route's ownership read; the locked seam never re-read the row.
    expect(h.store.queries.filter((q) => q.method === 'order.findUnique')).toHaveLength(1);
    expect(h.store.queries.filter((q) => q.method.startsWith('order.update'))).toEqual([]);
    expect(h.pushes).toEqual([]);
    expect(host.enqueued).toEqual([]);
  });

  it('RED — the locked canonical transition refuses PREPARING, READY_FOR_PICKUP and RIDER_ASSIGNED for a booking, whoever calls it', async () => {
    for (const [status, target] of [['ACCEPTED', 'PREPARING'], ['ACCEPTED', 'RIDER_ASSIGNED'], ['PREPARING', 'READY_FOR_PICKUP']] as const) {
      const h = harness([serviceBooking('bk-r2', { status, acceptedAt: new Date() })]);
      await expect(h.svc.updateStatus('bk-r2', target, 'user-ops', 'ops console')).rejects.toMatchObject({ code: 'NOT_A_KITCHEN_ORDER', statusCode: 409 });
      expect(h.store.rows[0]).toMatchObject({ status });
      expect(h.store.queries.filter((q) => q.method.startsWith('order.update'))).toEqual([]);
      expect(h.pushes).toEqual([]);
      expect(h.io.emits).toEqual([]);
      vi.restoreAllMocks();
    }
  });

  it('control — a booking still completes from ACCEPTED through the same seam, and can still be cancelled', async () => {
    const done = harness([accepted()]);
    await done.svc.updateStatus('bk-r2', 'COMPLETED', 'user-provider', 'Appointment completed by vendor');
    expect(done.store.rows[0]).toMatchObject({ status: 'COMPLETED' });
    vi.restoreAllMocks();
    const declined = harness([accepted()]);
    await declined.svc.updateStatus('bk-r2', 'CANCELLED', 'user-provider', 'Rejected by vendor');
    expect(declined.store.rows[0]).toMatchObject({ status: 'CANCELLED' });
  });

  it('control — a restaurant delivery still moves ACCEPTED → PREPARING → READY_FOR_PICKUP with its kitchen pushes', async () => {
    const h = harness([foodDelivery('food-r2', { status: 'ACCEPTED', acceptedAt: new Date() })]);
    const host = await hostRoutes(vendorRoutes, { prisma: h.prisma, redis: recordingRedis(), io: h.io });
    await host.call('put /orders/:id/preparing', asProvider({ params: { id: 'food-r2' } }));
    expect(h.store.rows[0]).toMatchObject({ status: 'PREPARING' });
    await host.call('put /orders/:id/ready', asProvider({ params: { id: 'food-r2' } }));
    expect(h.store.rows[0]).toMatchObject({ status: 'READY_FOR_PICKUP' });
    expect(h.pushes.map((p) => p.title)).toEqual(['Being Prepared', 'Food Ready!']);
  });
});

// ── F04 ─────────────────────────────────────────────────────────────────────

describe('F04 — the cancel result names a booking and its provider; the fee and the MMG truth stay the server’s', () => {
  const PLACED_AT = new Date('2026-09-23T14:00:00.000Z');
  const slot = new Date('2026-09-24T10:00:00.000Z');
  const booking = (extra: Row = {}) => serviceBooking('bk-r2', { placedAt: PLACED_AT, updatedAt: PLACED_AT, holdExpiresAt: null, appointmentSlot: slot, ...extra });

  it('RED — a free cash cancel says "Booking cancelled — no charge" and records no marker', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(PLACED_AT.getTime() + MINUTE));
    const h = harness([booking()]);
    const result = await h.svc.cancelOrder('bk-r2', 'user-customer');
    expect(result).toEqual({ message: 'Booking cancelled — no charge', cancellationFee: 0 });
    expect(h.store.rows[0]).toMatchObject({ status: 'CANCELLED', lateCancelFeeDue: 0 });
  });

  it('RED — a late cash cancel says "Booking cancelled" and still records the marker the server decided', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T13:55:00.000Z'));
    const h = harness([booking()]);
    const result = await h.svc.cancelOrder('bk-r2', 'user-customer');
    expect(result).toEqual({ message: 'Booking cancelled', cancellationFee: LATE_CANCEL_FEE });
    expect(h.store.rows[0]).toMatchObject({ status: 'CANCELLED', lateCancelFeeDue: LATE_CANCEL_FEE });
  });

  it('RED — an unattested-MMG cancel keeps the uncertainty and points the refund at the provider; the provider is still told', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(PLACED_AT.getTime() + MINUTE));
    const h = harness([booking({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' })]);
    const result = await h.svc.cancelOrder('bk-r2', 'user-customer');
    expect(result).toEqual({
      message: 'Booking cancelled. If you already sent the MMG payment, the provider refunds you directly.',
      cancellationFee: 0,
    });
    expect(result.message).not.toMatch(/\border\b|store|no charge/i);
    const providerNotice = h.pushes.find((p) => p.userId === 'user-provider');
    expect(providerNotice?.body).toContain('ORD-BK-R2');
  });

  it('control — a restaurant delivery keeps its exact words on both rails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(PLACED_AT.getTime() + MINUTE));
    const cash = harness([foodDelivery('food-r2', { placedAt: PLACED_AT, holdExpiresAt: null })]);
    expect(await cash.svc.cancelOrder('food-r2', 'user-customer')).toEqual({ message: 'Order cancelled — no charge', cancellationFee: 0 });
    vi.restoreAllMocks();
    const mmg = harness([foodDelivery('food-r2', { placedAt: PLACED_AT, holdExpiresAt: null, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' })]);
    expect(await mmg.svc.cancelOrder('food-r2', 'user-customer')).toEqual({
      message: 'Order cancelled. If you already sent the MMG payment, the store refunds you directly.',
      cancellationFee: 0,
    });
  });

  it('the tracking screen shows the server’s result first and never discards its money outcome for copy', () => {
    const screen = readFileSync(resolve(__dirname, '../../../mobile/src/modules/orders/screens/DeliveryScreen.tsx'), 'utf8');
    expect(screen).toContain('setCancelMessage(payload.message)');
    expect(screen).toMatch(/setCancelFee\(typeof payload\.cancellationFee === 'number' \? payload\.cancellationFee : null\)/);
    expect(screen).toMatch(/: cancelMessage\s*\?\?/);
  });
});

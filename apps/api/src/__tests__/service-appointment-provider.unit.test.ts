import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapsProvider } from '../providers/maps/maps-provider';
import { OrderService } from '../modules/order/order.service';
import { NotificationService } from '../modules/notification/notification.service';
import { BookingService } from '../modules/booking/booking.service';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { invalidateAlgoConfig } from '../modules/algo/algo-config';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import {
  HOUR,
  MINUTE,
  courierParcel,
  foodDelivery,
  hostRoutes,
  orderStore,
  prismaDouble,
  recordingIo,
  recordingRedis,
  redisTripwire,
  serviceBooking,
  type Row,
} from './helpers/service-vertical-doubles';

// ---------------------------------------------------------------------------
// THE APPOINTMENT REACHES THE SELECTED PROVIDER — AND NEVER A KITCHEN OR A RIDER.
//
// The owner's question, in order of the journey: does a booking placed at a
// SERVICE business go to THAT business, and can it ever become a restaurant
// order or a food dispatch job on the way? These cases drive the real seams:
//
//   1. the hold-release tick tells the selected provider (socket room + the
//      persistent vendor alert) and starts no rider cascade;
//   2. the provider's board query is scoped to the provider and honours the
//      hold (a released booking is on it; a held one is not);
//   3. the provider's ACCEPT reserves the booked slot for the provider's own
//      listing inside the canonical transition and enqueues NO dispatch job,
//      under both dispatch triggers;
//   4. the dispatch worker refuses a booking outright even if a job for it
//      existed — it returns {} before any offer phase;
//   5. RED reproduction: the acceptance push told the customer the provider
//      "is preparing it" — food words on a booking;
//   6. RED reproduction: the decline push told the customer "your order was
//      declined by the store" — the same seam, the other decision.
//
// 1–4 are positive controls on behaviour that already held at the base; they
// are pinned so the separation cannot regress them. Nothing opens a service.
// ---------------------------------------------------------------------------

const ORIGINAL_TRIGGER = process.env['DISPATCH_TRIGGER'];

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_TRIGGER === undefined) delete process.env['DISPATCH_TRIGGER'];
  else process.env['DISPATCH_TRIGGER'] = ORIGINAL_TRIGGER;
  invalidateAlgoConfig();
});

// ── 1. The hold-release tick tells the provider, not the riders ─────────────

describe('OrderService.releaseDueHeldOrders — a released booking goes to its provider', () => {
  function releaseHarness(rows: Row[]) {
    const store = orderStore(rows);
    const prisma = prismaDouble(store, {
      vendorOwner: { findUnique: async (args: { where: { id: string } }) => (args.where.id === 'owner-svc' ? { id: 'owner-svc', userId: 'user-provider' } : null) },
    });
    const io = recordingIo();
    const svc = new OrderService(prisma, io);
    const vendorAlert = vi.spyOn(NotificationService.prototype, 'newOrderForVendor').mockResolvedValue('notification-1');
    const enqueueDispatch = vi.fn(async (_orderId: string) => {});
    return { store, io, svc, vendorAlert, enqueueDispatch };
  }

  it('the selected SERVICE business is told on its own room and by the persistent alert; no rider cascade starts', async () => {
    const h = releaseHarness([serviceBooking('bk-held', { holdExpiresAt: new Date(Date.now() - 1000) })]);
    const res = await h.svc.releaseDueHeldOrders(h.enqueueDispatch);
    expect(res.released).toEqual(['bk-held']);
    expect(h.store.rows[0]).toMatchObject({ holdExpiresAt: null });
    expect(h.store.rows[0]!['releasedToVendorAt']).toBeInstanceOf(Date);
    expect(h.io.emits).toEqual([{ room: 'vendor:vendor-svc', event: 'order:new', payload: { orderId: 'bk-held', vendorId: 'vendor-svc', orderNumber: 'ORD-BK-HELD' } }]);
    expect(h.vendorAlert).toHaveBeenCalledTimes(1);
    expect(h.vendorAlert).toHaveBeenCalledWith('user-provider', 'ORD-BK-HELD', 1, 2000, 'bk-held', expect.any(Date));
    // [Q10] ...carrying the booking's own response deadline, which its alert
    // push rings until: the auto-cancel cut-off, slot-relative for a booking
    // (the earlier of placement + 24 h and slot - 60 min; here the 24 h cap).
    const placedAt = (h.store.rows[0]!['placedAt'] as Date).getTime();
    expect((h.vendorAlert.mock.calls[0]![5] as Date).getTime()).toBe(placedAt + 24 * HOUR);
    expect(h.enqueueDispatch).not.toHaveBeenCalled();
  });

  it('a booking still inside its hold is not released and nobody is told', async () => {
    const h = releaseHarness([serviceBooking('bk-held', { holdExpiresAt: new Date(Date.now() + 2 * MINUTE) })]);
    const res = await h.svc.releaseDueHeldOrders(h.enqueueDispatch);
    expect(res.released).toEqual([]);
    expect(h.io.emits).toEqual([]);
    expect(h.vendorAlert).not.toHaveBeenCalled();
    expect(h.enqueueDispatch).not.toHaveBeenCalled();
  });

  it('control — a courier parcel is the one thing release dispatches, and it has no provider to tell', async () => {
    const h = releaseHarness([courierParcel('parcel-1', { holdExpiresAt: new Date(Date.now() - 1000) })]);
    const res = await h.svc.releaseDueHeldOrders(h.enqueueDispatch);
    expect(res.released).toEqual(['parcel-1']);
    expect(h.enqueueDispatch).toHaveBeenCalledWith('parcel-1');
    expect(h.io.emits).toEqual([]);
    expect(h.vendorAlert).not.toHaveBeenCalled();
  });
});

// ── 2 & 3. The provider's board and the provider's accept ──────────────────

async function providerHost(rows: Row[]) {
  const store = orderStore(rows);
  const prisma = prismaDouble(store, {
    vendorOwner: {
      findUnique: async (args: { where: { userId?: string; id?: string } }) =>
        (args.where.userId === 'user-provider' ? { id: 'owner-svc', userId: 'user-provider', vendors: [{ id: 'vendor-svc' }, { id: 'vendor-food' }] } : null),
    },
    vendor: {
      findUnique: async (args: { where: { id: string } }) => ({
        id: args.where.id, isVerified: true, status: 'ACTIVE',
        vendorType: args.where.id === 'vendor-svc' ? 'SERVICE' : 'RESTAURANT', selfDeliveryEnabled: false,
      }),
    },
    subscription: { findFirst: async () => null },
    alertDelivery: { updateMany: async () => ({ count: 0 }) },
    notification: { updateMany: async () => ({ count: 0 }) },
    platformConfig: { findUnique: async () => null },
  });
  const host = await hostRoutes(vendorRoutes, { prisma, redis: recordingRedis(), io: recordingIo() });
  return { ...host, store, prisma };
}

const asProvider = (extra: Record<string, unknown> = {}) => ({ user: { userId: 'user-provider', role: 'VENDOR_OWNER' }, ...extra });

describe('GET /vendor/orders — the provider’s board is scoped to the provider and honours the hold', () => {
  it('a released booking is on the provider’s board with its appointment identity; a held one is not; another business’s order never is', async () => {
    const h = await providerHost([
      serviceBooking('bk-released', { holdExpiresAt: null }),
      serviceBooking('bk-held', { holdExpiresAt: new Date(Date.now() + 3 * MINUTE) }),
      foodDelivery('food-elsewhere', { vendorId: 'vendor-other' }),
    ]);
    const res = (await h.call('get /orders', asProvider())) as { success: boolean; data: Row[] };
    expect(res.success).toBe(true);
    expect(res.data.map((o) => o['id'])).toEqual(['bk-released']);
    expect(res.data[0]).toMatchObject({ vendorId: 'vendor-svc', fulfillment: 'APPOINTMENT', orderType: 'FOOD_DELIVERY' });
    expect(res.data[0]!['appointmentSlot']).toBeInstanceOf(Date);
    const board = h.store.queries.find((q) => q.method === 'order.findMany');
    expect(board!.args['where']).toMatchObject({ vendorId: { in: ['vendor-svc', 'vendor-food'] } });
    expect(JSON.stringify(board!.args['where'])).toContain('holdExpiresAt');
  });
});

describe('PUT /vendor/orders/:id/accept — acceptance reserves the provider’s slot and dispatches nothing', () => {
  // The transaction handed to the route's callback is the same graded double
  // as the host's client, so writes made inside it (the delivery-mode bind
  // since #1266) are recorded and asserted like any other query.
  function acceptSpies(store: ReturnType<typeof orderStore>, tx: unknown) {
    const transition = vi.spyOn(OrderService.prototype, 'updateStatus').mockImplementation(async (orderId, status, _by, _note, opts) => {
      const live = store.rows.find((r) => r['id'] === orderId);
      if (!live) throw new Error(`modelled transition: no row ${orderId}`);
      // Production (OrderService.updateStatus) hands the callback the row it
      // locked BEFORE the transition, after writing the new status.
      const lockedSource = { ...live };
      Object.assign(live, { status, acceptedAt: new Date() });
      await opts?.withinTransaction?.(tx as never, lockedSource as never);
      return { ...live } as never;
    });
    const reserve = vi.spyOn(BookingService.prototype, 'reserveSlot').mockImplementation(async (itemId, customerId, slotStart, orderId) =>
      ({ id: 'booking-1', itemId, customerId, orderId: orderId ?? null, slotStart, slotEnd: slotStart, status: 'CONFIRMED', createdAt: new Date() }) as never);
    const nudge = vi.spyOn(BookingService.prototype, 'nudgeForItem').mockResolvedValue(undefined);
    return { tx, transition, reserve, nudge };
  }

  for (const trigger of ['ON_ACCEPT', 'ON_READY'] as const) {
    it(`${trigger} — the booking moves to ACCEPTED, the slot is reserved for the provider’s listing inside the transition, and no dispatch job exists`, async () => {
      process.env['DISPATCH_TRIGGER'] = trigger;
      const slot = new Date(Date.now() + 26 * 60 * MINUTE);
      const h = await providerHost([serviceBooking('bk-1', { appointmentSlot: slot })]);
      const spies = acceptSpies(h.store, h.prisma);
      const res = (await h.call('put /orders/:id/accept', asProvider({ params: { id: 'bk-1' }, body: {} }))) as { success: boolean; data: Row };
      expect(res.success).toBe(true);
      expect(res.data).toMatchObject({ id: 'bk-1', status: 'ACCEPTED', fulfillment: 'APPOINTMENT', vendorId: 'vendor-svc' });
      expect(spies.transition).toHaveBeenCalledWith('bk-1', 'ACCEPTED', 'user-provider', 'Accepted by vendor', expect.objectContaining({ withinTransaction: expect.any(Function) }));
      expect(spies.reserve).toHaveBeenCalledTimes(1);
      expect(spies.reserve).toHaveBeenCalledWith('item-haircut', 'user-customer', slot, 'bk-1', spies.tx);
      expect(spies.nudge).toHaveBeenCalledWith('item-haircut');
      expect(h.enqueued).toEqual([]);
      expect(h.store.queries.filter((q) => q.method === 'order.update')).toEqual([]);
    });
  }

  it('control — a restaurant delivery accepted under ON_ACCEPT resolves its delivery mode and enqueues exactly one dispatch job; no slot is reserved', async () => {
    process.env['DISPATCH_TRIGGER'] = 'ON_ACCEPT';
    const h = await providerHost([foodDelivery('food-1')]);
    const spies = acceptSpies(h.store, h.prisma);
    // Since #1266 the platform hand-off is armed through the delivery-authority
    // generation (Redis) before the job is enqueued; that seam has its own
    // suites. Here it is the boundary: it must receive the version the accept
    // just bound, and the route must then enqueue exactly one job.
    const prepare = vi.spyOn(DispatchService.prototype, 'prepareForPlatformDelivery').mockResolvedValue(true);
    const res = (await h.call('put /orders/:id/accept', asProvider({ params: { id: 'food-1' }, body: {} }))) as { success: boolean; data: Row };
    expect(res.data).toMatchObject({ id: 'food-1', status: 'ACCEPTED', fulfillmentMode: 'PLATFORM_RIDER', fulfillmentModeVersion: 1 });
    expect(spies.reserve).not.toHaveBeenCalled();
    expect(h.store.queries.filter((q) => q.method === 'order.update').map((q) => q.args['data'])).toEqual([{ fulfillmentMode: 'PLATFORM_RIDER', fulfillmentModeVersion: { increment: 1 } }]);
    expect(prepare.mock.calls).toEqual([['food-1', 1]]);
    expect(h.enqueued.map((j) => ({ name: j.name, data: j.data }))).toEqual([{ name: 'dispatch-order', data: { orderId: 'food-1' } }]);
  });
});

// ── 4. The dispatch worker refuses a booking before any offer phase ─────────

describe('DispatchService.dispatchOrder — a booking is never a food dispatch job', () => {
  function workerHarness(row: Row) {
    const store = orderStore([row]);
    const prisma = prismaDouble(store, {
      algoConfig: { findFirst: async () => null },
      $queryRaw: async () => { throw new Error('TRIPWIRE[prisma]: the candidate geo query was reached'); },
    });
    const svc = new DispatchService(prisma, redisTripwire(), recordingIo(), {} as MapsProvider);
    return { store, svc };
  }

  it('an ACCEPTED booking at a SERVICE business answers {} and touches neither Redis nor the rider pool', async () => {
    const h = workerHarness(serviceBooking('bk-acc', { status: 'ACCEPTED', acceptedAt: new Date() }));
    await expect(h.svc.dispatchOrder('bk-acc')).resolves.toEqual({});
    expect(h.store.rows[0]).toMatchObject({ status: 'ACCEPTED', riderId: null });
  });

  it('control — the same row as a DELIVERY proceeds into the offer phase (the fulfillment gate is what stops the booking)', async () => {
    const h = workerHarness(serviceBooking('bk-acc', { status: 'ACCEPTED', acceptedAt: new Date(), fulfillment: 'DELIVERY' }));
    await expect(h.svc.dispatchOrder('bk-acc')).rejects.toThrow(/TRIPWIRE/);
  });
});

// ── 5. RED reproduction: the acceptance push used kitchen words on a booking ─

describe('OrderService.updateStatus → ACCEPTED — the customer is told a booking was confirmed, not that food is being prepared', () => {
  function acceptedHarness(row: Row) {
    const store = orderStore([row]);
    const prisma = prismaDouble(store, {
      algoConfig: { findFirst: async () => null },
      user: { findUnique: async () => ({ countryCode: 'GY' }) },
    });
    const io = recordingIo();
    const svc = new OrderService(prisma, io);
    vi.spyOn(OrderService.prototype, 'transitionOrderAtomically').mockResolvedValue({ order: row as never, sourceStatus: 'PENDING', cancelledSearches: 0, earningNotices: [] });
    const accepted = vi.spyOn(NotificationService.prototype, 'orderAccepted').mockResolvedValue(undefined);
    return { store, io, svc, accepted };
  }

  it('RED reproduction — a SERVICE booking: NotificationService.bookingConfirmed is called, orderAccepted is not', async () => {
    const proto = NotificationService.prototype as unknown as Record<string, unknown>;
    expect(typeof proto['bookingConfirmed'], 'NotificationService must have a booking confirmation').toBe('function');
    const confirmed = vi.spyOn(NotificationService.prototype, 'bookingConfirmed').mockResolvedValue(undefined);
    const h = acceptedHarness(serviceBooking('bk-1', { status: 'ACCEPTED', acceptedAt: new Date() }));
    await h.svc.updateStatus('bk-1', 'ACCEPTED', 'user-provider', 'Accepted by vendor');
    expect(confirmed).toHaveBeenCalledWith('user-customer', 'ORD-BK-1', 'Kim’s Barbershop', 'bk-1');
    expect(h.accepted).not.toHaveBeenCalled();
    expect(h.io.emits.map((e) => e.room)).toEqual(['order:bk-1', 'vendor:vendor-svc']);
  });

  it('the booking confirmation copy carries no kitchen words and keeps the order-screen routing data', async () => {
    const svc = new NotificationService(prismaDouble(orderStore([])), recordingIo());
    const send = vi.spyOn(NotificationService.prototype, 'send').mockResolvedValue('notification-1');
    await svc.bookingConfirmed('user-customer', 'ORD-BK-1', 'Kim’s Barbershop', 'bk-1');
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]![0] as { userId: string; type: string; title: string; body: string; data: Record<string, unknown> };
    expect(payload.userId).toBe('user-customer');
    expect(payload.type).toBe('ORDER_UPDATE');
    expect(payload.title).toMatch(/booking/i);
    expect(payload.body).toContain('Kim’s Barbershop');
    expect(payload.body).toContain('ORD-BK-1');
    expect(payload.body).not.toMatch(/prepar|kitchen|food|meal|order/i);
    expect(payload.data).toEqual({ orderId: 'bk-1', orderNumber: 'ORD-BK-1', status: 'ACCEPTED' });
  });

  it('control — a restaurant delivery keeps the existing acceptance push', async () => {
    const h = acceptedHarness(foodDelivery('food-1', { status: 'ACCEPTED', acceptedAt: new Date() }));
    await h.svc.updateStatus('food-1', 'ACCEPTED', 'user-cook', 'Accepted by vendor');
    expect(h.accepted).toHaveBeenCalledWith('user-customer', 'ORD-FOOD-1', 'Trigger Diner', 'food-1');
  });
});

// ── 6. RED reproduction: the decline push used store words on a booking ─────

describe('PUT /vendor/orders/:id/reject — the customer is told a booking was declined by the provider, not an order by the store', () => {
  function rejectSpies(store: ReturnType<typeof orderStore>) {
    const transition = vi.spyOn(OrderService.prototype, 'transitionOrderAtomically').mockImplementation(async (input) => {
      const live = store.rows.find((r) => r['id'] === input.orderId);
      if (!live) throw new Error(`modelled transition: no row ${input.orderId}`);
      Object.assign(live, { status: input.target, cancelledAt: new Date(), cancelledBy: input.changedBy, cancellationReason: input.note });
      return { order: live as never, sourceStatus: 'PENDING', cancelledSearches: 0, earningNotices: [] } as never;
    });
    const send = vi.spyOn(NotificationService.prototype, 'send').mockResolvedValue('notification-1');
    return { transition, send };
  }
  type Push = { userId: string; type: string; title: string; body: string; data: Record<string, unknown> };

  it('RED reproduction — a SERVICE booking declined by the provider: the push says booking and provider, never order or store', async () => {
    const h = await providerHost([serviceBooking('bk-1')]);
    const spies = rejectSpies(h.store);
    const res = (await h.call('put /orders/:id/reject', asProvider({ params: { id: 'bk-1' }, body: { reason: 'Fully booked that day' } }))) as { success: boolean; data: Row };
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ id: 'bk-1', status: 'CANCELLED', fulfillment: 'APPOINTMENT' });
    expect(spies.transition).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'bk-1', target: 'CANCELLED', note: 'Fully booked that day', changedBy: 'user-provider' }));
    expect(h.enqueued).toEqual([]);
    expect(spies.send).toHaveBeenCalledTimes(1);
    const payload = spies.send.mock.calls[0]![0] as Push;
    expect(payload.userId).toBe('user-customer');
    expect(payload.type).toBe('ORDER_UPDATE');
    expect(payload.title).toBe('Booking declined');
    expect(payload.body).toContain('ORD-BK-1');
    expect(payload.body).toContain('Fully booked that day');
    expect(payload.body).toMatch(/booking/);
    expect(payload.body).toMatch(/the provider/);
    expect(payload.body).not.toMatch(/\border\b|store|prepar/i);
    expect(payload.data).toEqual({ orderId: 'bk-1', status: 'CANCELLED' });
  });

  it('RED reproduction — an unattested-MMG booking decline points the refund at the provider', async () => {
    const h = await providerHost([serviceBooking('bk-1', { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' })]);
    const spies = rejectSpies(h.store);
    await h.call('put /orders/:id/reject', asProvider({ params: { id: 'bk-1' }, body: { reason: 'Fully booked that day' } }));
    const payload = spies.send.mock.calls[0]![0] as Push;
    expect(payload.body).toContain('If you already sent the MMG payment, the provider refunds you directly.');
    expect(payload.body).not.toMatch(/store/i);
  });

  it('control — a restaurant delivery keeps the existing decline push, word for word', async () => {
    const h = await providerHost([foodDelivery('food-1', { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' })]);
    const spies = rejectSpies(h.store);
    const res = (await h.call('put /orders/:id/reject', asProvider({ params: { id: 'food-1' }, body: { reason: 'Out of roti' } }))) as { success: boolean; data: Row };
    expect(res.data).toMatchObject({ id: 'food-1', status: 'CANCELLED' });
    expect(spies.send.mock.calls[0]![0]).toEqual({
      userId: 'user-customer',
      type: 'ORDER_UPDATE',
      title: 'Order declined',
      body: 'Your order ORD-FOOD-1 was declined by the store. Out of roti If you already sent the MMG payment, the store refunds you directly.',
      data: { orderId: 'food-1', status: 'CANCELLED' },
    });
  });

  it('[E10] a decline without a reason is refused before anything changes — the customer is always told why', async () => {
    // It used to go through with the generic "Rejected by vendor", which told
    // the customer nothing. Every vendor client now sends a preset.
    const h = await providerHost([foodDelivery('food-1')]);
    const spies = rejectSpies(h.store);
    await expect(h.call('put /orders/:id/reject', asProvider({ params: { id: 'food-1' }, body: {} }))).rejects.toThrow();
    await expect(h.call('put /orders/:id/reject', asProvider({ params: { id: 'food-1' }, body: { reason: '   ' } }))).rejects.toThrow();
    expect(spies.transition).not.toHaveBeenCalled();
    expect(spies.send).not.toHaveBeenCalled();
  });

  it('control — a cash food order declined with a reason carries it and no MMG sentence', async () => {
    const h = await providerHost([foodDelivery('food-1')]);
    const spies = rejectSpies(h.store);
    await h.call('put /orders/:id/reject', asProvider({ params: { id: 'food-1' }, body: { reason: 'Kitchen is too busy' } }));
    const payload = spies.send.mock.calls[0]![0] as Push;
    expect(payload.title).toBe('Order declined');
    expect(payload.body).toBe('Your order ORD-FOOD-1 was declined by the store. Kitchen is too busy');
  });
});

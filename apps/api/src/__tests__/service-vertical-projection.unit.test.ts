import { describe, expect, it, vi } from 'vitest';
import { customerRoutes } from '../modules/user/customer.routes';
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
// [GUARDRAILS §8 · #54] The store-level ban's reads are proven against a real database (prohibited-items.test.ts);
// this seam models none of the category tables, and no fixture store is filed under a banned category.
vi.mock('../modules/compliance/prohibited-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modules/compliance/prohibited-gate')>()),
  prohibitedStoreIds: async () => [],
  prohibitedStoreCategory: async () => null,
}));


// ---------------------------------------------------------------------------
// THE CUSTOMER PROJECTIONS OF A SERVICE BOOKING.
//
// Reproduced from the owner's phone: a barbershop booking was presented as a
// FOOD order — Home's live card said "Waiting for the store" and "The store
// hasn't been told yet", and the order screen previewed the marketplace
// late-cancellation marker on a booking no provider had seen. The trace ends
// at three projections in customer.routes.ts:
//
//   GET /home       the live card's `activeOrder` select sent orderType only —
//                   neither the fulfillment nor the business type, so the card
//                   could not know it was a booking at all;
//   GET /orders     the activity list sent the persisted enum as the vertical;
//   GET /orders/:id the order screen previewed cancellation by the kitchen
//                   clock, ignoring the booked slot.
//
// These drive the REAL route handlers on a recording stand-in. The order store
// projects by the exact `select` each route sends, so a field that stops at the
// select stops here too. Nothing opens PostgreSQL or Redis.
// ---------------------------------------------------------------------------

async function customerHost(rows: Row[]) {
  const store = orderStore(rows);
  const prisma = prismaDouble(store, {
    platformConfig: { findUnique: async () => null, findMany: async () => [] },
    customer: { findUnique: async () => ({ id: 'cust-1', userId: 'user-customer', referralCode: 'REF1' }) },
    // [owner #46/#50, 13–14 Oct] The business's PUBLISHED number, read only
    // for a refused cancel's "contact the provider".
    vendor: { findMany: async () => [], findUnique: async () => ({ status: 'ACTIVE', publicPhone: '+5926001111' }) },
    item: { findMany: async () => [] },
    user: { findUnique: async () => ({ countryCode: 'GY' }) },
    countryConfig: { findUnique: async () => null },
    rating: { findMany: async () => [] },
    // [Item 64] The dispatch journal holds no exhausted search for these fixtures.
    dispatchSearch: { findFirst: async () => null },
  });
  const redis = recordingRedis();
  const host = await hostRoutes(customerRoutes, { prisma, redis, io: recordingIo() });
  return { ...host, store, redis };
}

const asCustomer = (extra: Record<string, unknown> = {}) => ({ user: { userId: 'user-customer', role: 'CUSTOMER' }, ...extra });

type Feed = { success: boolean; data: { activeOrder: Row | null } };
type List = { success: boolean; data: Row[] };
type Detail = { success: boolean; data: Row };

describe('GET /home — the live-order card is told the vertical', () => {
  it('RED reproduction — a barbershop booking on the legacy spine is projected as SERVICE, with its fulfillment and business type', async () => {
    const booking = serviceBooking('bk-1', { appointmentSlot: new Date('2026-09-24T13:00:00.000Z') });
    const h = await customerHost([booking]);
    const res = (await h.call('get /home', asCustomer())) as Feed;
    expect(res.success).toBe(true);
    expect(res.data.activeOrder).toMatchObject({
      id: 'bk-1',
      orderNumber: 'ORD-BK-1',
      orderType: 'FOOD_DELIVERY',
      fulfillment: 'APPOINTMENT',
      appointmentSlot: booking['appointmentSlot'],
      vertical: 'SERVICE',
      vendor: { id: 'vendor-svc', name: 'Kim’s Barbershop', vendorType: 'SERVICE' },
    });
  });

  it('RED reproduction — the select itself asks the database for the fulfillment and the business type', async () => {
    const h = await customerHost([serviceBooking('bk-1')]);
    await h.call('get /home', asCustomer());
    const active = h.store.queries.find((q) => q.method === 'order.findFirst');
    expect(active, 'Home must read the active order with findFirst').toBeTruthy();
    const select = active!.args['select'] as Record<string, unknown>;
    expect(select['fulfillment']).toBe(true);
    expect(select['appointmentSlot']).toBe(true);
    expect((select['vendor'] as { select: Record<string, unknown> }).select['vendorType']).toBe(true);
  });

  it('control — a restaurant delivery keeps FOOD_DELIVERY and every field the card already read', async () => {
    const hold = new Date(Date.now() + 4 * MINUTE);
    const h = await customerHost([foodDelivery('food-1', { holdExpiresAt: hold })]);
    const res = (await h.call('get /home', asCustomer())) as Feed;
    expect(res.data.activeOrder).toMatchObject({
      id: 'food-1',
      orderType: 'FOOD_DELIVERY',
      fulfillment: 'DELIVERY',
      vertical: 'FOOD_DELIVERY',
      holdExpiresAt: hold,
      vendor: { id: 'vendor-food', name: 'Trigger Diner', logoUrl: null, vendorType: 'RESTAURANT' },
    });
    expect(res.data.activeOrder!['placedAt']).toBeInstanceOf(Date);
    expect(res.data.activeOrder).toHaveProperty('promise');
  });

  it('control — a signed-in customer with nothing live still gets a null card', async () => {
    const h = await customerHost([]);
    const res = (await h.call('get /home', asCustomer())) as Feed;
    expect(res.data.activeOrder).toBeNull();
  });
});

describe('GET /orders — the activity list carries the vertical per row', () => {
  it('RED reproduction — a booking row is SERVICE and a food row is FOOD_DELIVERY; the persisted type is untouched on both', async () => {
    const booking = serviceBooking('bk-1', { appointmentSlot: new Date('2026-09-24T13:00:00.000Z') });
    const h = await customerHost([booking, foodDelivery('food-1')]);
    const res = (await h.call('get /orders', asCustomer())) as List;
    expect(res.success).toBe(true);
    const byId = Object.fromEntries(res.data.map((o) => [o['id'] as string, o]));
    expect(byId['bk-1']).toMatchObject({ orderType: 'FOOD_DELIVERY', fulfillment: 'APPOINTMENT', vertical: 'SERVICE', appointmentSlot: booking['appointmentSlot'], vendor: { vendorType: 'SERVICE' } });
    expect(byId['food-1']).toMatchObject({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', vertical: 'FOOD_DELIVERY', vendor: { vendorType: 'RESTAURANT' } });
  });
});

describe('GET /orders/:id — the order screen’s contract', () => {
  it('RED reproduction — a PENDING booking with its slot tomorrow is SERVICE and previews a FREE cancellation, not the marketplace marker', async () => {
    const slot = new Date(Date.now() + 26 * 60 * MINUTE);
    const h = await customerHost([serviceBooking('bk-1', { appointmentSlot: slot })]);
    const res = (await h.call('get /orders/:id', asCustomer({ params: { id: 'bk-1' } }))) as Detail;
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({
      id: 'bk-1',
      orderType: 'FOOD_DELIVERY',
      fulfillment: 'APPOINTMENT',
      appointmentSlot: slot,
      vertical: 'SERVICE',
      canCancel: true,
      freeCancellationWindow: true,
      cancellationFee: 0,
      // [owner #50, 14 Oct] Free until the provider accepts it — no countdown.
      freeCancellationExpiresAt: null,
    });
  });

  // [owner #50, 14 Oct] No marker any more: an accepted booking past the
  // five-minute window is not cancelled in the app — the provider's published
  // number instead.
  it('control — an accepted booking past the window is committed: no Cancel, no fee, contact the provider', async () => {
    // [owner ruling 14 Oct] The window counts from the provider's acceptance: accepted ten minutes ago is past it.
    const h = await customerHost([serviceBooking('bk-1', { status: 'ACCEPTED', acceptedAt: new Date(Date.now() - 10 * MINUTE) })]);
    const res = (await h.call('get /orders/:id', asCustomer({ params: { id: 'bk-1' } }))) as Detail;
    expect(res.data).toMatchObject({
      vertical: 'SERVICE', canCancel: false, freeCancellationWindow: false, cancellationFee: 0, freeCancellationExpiresAt: null,
      cancelUnavailable: { code: 'CANCEL_WINDOW_CLOSED', contactPhone: '+5926001111' },
    });
  });

  // [owner #46, 13 Oct] A food order used to keep the five-minute clock and a
  // G$500 fee preview here. It is free while it waits for the store — no fee
  // and no countdown — and the booking above keeps the clock.
  it('control — a PENDING food order ten minutes after placing is free while it waits for the store, with no fee preview', async () => {
    const h = await customerHost([foodDelivery('food-1')]);
    const res = (await h.call('get /orders/:id', asCustomer({ params: { id: 'food-1' } }))) as Detail;
    expect(res.data).toMatchObject({ vertical: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', canCancel: true, freeCancellationWindow: true, cancellationFee: 0, freeCancellationExpiresAt: null });
  });

  it('control — a held food order is free while the hold runs, and stays free after it (no countdown)', async () => {
    const hold = new Date(Date.now() + 3 * MINUTE);
    const h = await customerHost([foodDelivery('food-1', { holdExpiresAt: hold, placedAt: new Date(Date.now() - MINUTE) })]);
    const res = (await h.call('get /orders/:id', asCustomer({ params: { id: 'food-1' } }))) as Detail;
    expect(res.data).toMatchObject({ freeCancellationWindow: true, cancellationFee: 0, freeCancellationExpiresAt: null, holdExpiresAt: hold });
  });
});

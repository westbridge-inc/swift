import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { nanoid } from 'nanoid';
import type { Order, UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerTenantHeaderScope } from '../plugins/tenant-header-scope';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { registerErrorHandler } from '../middleware/error-handler';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { OrderService, preparationMayStart } from '../modules/order/order.service';
import { ORDER_TRANSITIONS, STORE_ACCEPT_PATH } from '../modules/order/order-status';
import { hashVelocityId } from '../modules/integrity/velocity';
import { purgeAuditLogs } from '../lib/audit-immutability';

// ---------------------------------------------------------------------------
// [O-3 · owner 22 Oct 2026] "After Accept they should not have to tap again for
// started preparing" — every store type (restaurants, groceries, retail).
//
// One store tap walks PENDING -> ACCEPTED -> PREPARING in one commit
// (STORE_ACCEPT_PATH, order-status.ts): both milestones stamped with the same
// instant, both rows in the status log, ONE push to the customer, and the live
// events say PREPARING. Two declared forward edges, no new one, so the
// database's transition guard is unchanged.
//
// It stops at ACCEPTED where preparation may not start yet: a booking is never
// prepared, and an MMG order waits for "Paid by MMG" (payment-first), which
// then starts it. Store builds 9/11/12 and a stale web tab still show "Start
// preparing" after an accept: that tap is a 200 no-op, never an error, never a
// second row or push. Real customer + vendor routes, the production request
// composition (tenant context + header scope).
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+5920343';
const FIXTURE = 'store-flow-accept-preparing-fixture';
const CLIENT_IP = '10.20.34.3';
const DAY = 24 * 60 * 60 * 1000;
const HOME = { lat: 6.8045, lng: -58.1553 };
const STORE = { lat: 6.8013, lng: -58.1551 };

let app: FastifyInstance;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string };
type Store = { owner: Actor; vendorId: string; itemId: string };
let customer: Actor;
let diner: Store;
let grocer: Store;

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName, lastName: `Prep${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `sap-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token };
}

async function makeStore(name: string, vendorType: 'RESTAURANT' | 'SUPERMARKET'): Promise<Store> {
  const owner = await makeUser('Owner', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ownerRow = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const vendorId = (await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name, slug: `sap-${nanoid(8).toLowerCase()}`, vendorType,
      phone: `${PHONE_PREFIX}9${String(seq).padStart(2, '0')}`, addressLine1: 'Accept Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 50,
      mmgNumber: '+5926001234',
    },
  }))).id;
  const category = await sys(() => app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } }));
  const itemId = (await sys(() => app.prisma.item.create({
    data: { vendorId, categoryId: category.id, name: vendorType === 'SUPERMARKET' ? 'Rice 5kg' : 'Cook-up', basePrice: 2500, isAvailable: true },
  }))).id;
  return { owner, vendorId, itemId };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method, url, remoteAddress: CLIENT_IP,
    headers: { ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  } as InjectOptions);
}
const as = (store: Store) => ({ 'x-vendor-id': store.vendorId });
const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const statusLogs = (orderId: string) => sys(() => app.prisma.orderStatusLog.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }));
const notices = (userId: string, orderId: string) => sys(async () => (await app.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }))
  .filter((n) => JSON.stringify(n.data ?? {}).includes(orderId)));
const kitchenPushes = async (orderId: string) => (await notices(customer.userId, orderId))
  .filter((n) => ['Order Accepted!', 'Being Prepared'].includes(n.title));

async function placeOrder(store: Store, paymentMethod: 'MOBILE_MONEY' | 'CASH') {
  expect((await call('DELETE', '/api/v1/customer/cart', customer.token)).statusCode).toBe(200);
  const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: store.vendorId, itemId: store.itemId, quantity: 1 });
  expect(added.statusCode, added.body).toBe(201);
  const body = paymentMethod === 'MOBILE_MONEY' ? { paymentMethod, mmgPayTo: 'STORE_NUMBER' } : { paymentMethod };
  const res = await call('POST', '/api/v1/customer/checkout', customer.token, body, { 'idempotency-key': `sap-${nanoid(10)}` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().data as { order: { id: string } }).order.id;
}
const accept = (store: Store, orderId: string) => call('PUT', `/api/v1/vendor/orders/${orderId}/accept`, store.owner.token, undefined, as(store));
const startPreparing = (store: Store, orderId: string) => call('PUT', `/api/v1/vendor/orders/${orderId}/preparing`, store.owner.token, undefined, as(store));
const reference = () => `MP${nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, '7')}`;
const paidByMmg = (store: Store, orderId: string) => call('POST', `/api/v1/vendor/orders/${orderId}/confirm-payment`, store.owner.token, { reference: reference() }, as(store));

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const vendorIds = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: ids } } }, select: { id: true } })).map((v) => v.id);
    const orderIds = (await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendorIds } }] }, select: { id: true } })).map((o) => o.id);
    const sessionIds = (await app.prisma.session.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((s) => s.id);
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...vendorIds] } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: [...orderIds, ...vendorIds] } }, { userId: { in: ids } }] }, 'STORE-FLOW accept-preparing fixture cleanup');
    await app.prisma.supportTicket.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { userId: { in: ids } }] } });
    await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    const wanted = new Set([...ids, ...sessionIds, ...vendorIds, ...orderIds, ...[...ids, CLIENT_IP].map((a) => hashVelocityId(a))]);
    let cursor = '0';
    do {
      const [next, keys] = await app.redis.scan(cursor, 'COUNT', 1000);
      cursor = next;
      const mine = keys.filter((k) => k.split(':').some((part) => wanted.has(part)));
      if (mine.length > 0) await app.redis.del(...mine);
    } while (cursor !== '0');
  });
}

beforeAll(async () => {
  vi.stubEnv('STORE_MMG_PAY_LINK', '');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  registerTenantHeaderScope(app);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  await purgeFixtures();

  customer = await makeUser('Asha', ['CUSTOMER'], 'CUSTOMER');
  await sys(() => app.prisma.address.create({
    data: { userId: customer.userId, label: 'Home', addressLine1: '3 Prep Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: HOME.lat, longitude: HOME.lng, isDefault: true },
  }));
  diner = await makeStore('One Tap Diner', 'RESTAURANT');
  grocer = await makeStore('One Tap Grocery', 'SUPERMARKET');
});

afterAll(async () => {
  try { await purgeFixtures(); } finally { await app.close(); vi.unstubAllEnvs(); }
});

describe('[O-3] the walk is declared in order-status.ts over edges that already exist', () => {
  it('every hop of STORE_ACCEPT_PATH, from PENDING, is a declared FORWARD edge (so the database guard needs no new edge)', () => {
    expect(STORE_ACCEPT_PATH).toEqual(['ACCEPTED', 'PREPARING']);
    let from: keyof typeof ORDER_TRANSITIONS = 'PENDING';
    for (const to of STORE_ACCEPT_PATH) {
      expect(ORDER_TRANSITIONS[to], `${from} -> ${to}`).toContain(from);
      from = to;
    }
    // Skipping acceptance is still refused everywhere else.
    expect(ORDER_TRANSITIONS.PREPARING).not.toContain('PENDING');
  });

  it('preparation may start on a paid or cash store order of any kind; never on a booking, a parcel, a ride, or MMG money not yet confirmed', () => {
    const base = { fulfillment: 'DELIVERY', orderType: 'FOOD_DELIVERY', paymentMethod: 'CASH', paymentStatus: 'PENDING', mmgClaimMismatchAt: null } as const;
    expect(preparationMayStart(base as never)).toBe(true);
    expect(preparationMayStart({ ...base, fulfillment: 'PICKUP' } as never)).toBe(true);
    expect(preparationMayStart({ ...base, orderType: 'GROCERY_DELIVERY' } as never)).toBe(true);
    expect(preparationMayStart({ ...base, fulfillment: 'APPOINTMENT' } as never)).toBe(false);
    expect(preparationMayStart({ ...base, orderType: 'COURIER' } as never)).toBe(false);
    expect(preparationMayStart({ ...base, orderType: 'TAXI' } as never)).toBe(false);
    const mmg = { ...base, paymentMethod: 'MOBILE_MONEY' } as const;
    expect(preparationMayStart({ ...mmg, paymentStatus: 'PENDING' } as never)).toBe(false);
    expect(preparationMayStart({ ...mmg, paymentStatus: 'CLAIMED' } as never)).toBe(true);
    expect(preparationMayStart({ ...mmg, paymentStatus: 'CAPTURED' } as never)).toBe(true);
    expect(preparationMayStart({ ...mmg, paymentStatus: 'CLAIMED', mmgClaimMismatchAt: new Date() } as never)).toBe(false);
  });
});

describe('[O-3 · owner 22 Oct] one store tap: Accept = Preparing, every store type', () => {
  it('a cash restaurant order: Accept answers PREPARING; accepted and preparing at the same instant; both in the log; ONE push', async () => {
    const orderId = await placeOrder(diner, 'CASH');
    const res = await accept(diner, orderId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('PREPARING');

    const row = await orderRow(orderId);
    expect(row.status).toBe('PREPARING');
    expect(row.acceptedAt).toBeInstanceOf(Date);
    expect(row.preparingAt).toBeInstanceOf(Date);
    expect(row.preparingAt!.getTime()).toBe(row.acceptedAt!.getTime());

    const logs = await statusLogs(orderId);
    const accepted = logs.filter((l) => l.status === 'ACCEPTED');
    const preparing = logs.filter((l) => l.status === 'PREPARING');
    expect(accepted).toHaveLength(1);
    expect(preparing).toHaveLength(1);
    expect(accepted[0]!.changedBy).toBe(diner.owner.userId);
    expect(preparing[0]!.changedBy).toBe(diner.owner.userId);
    expect(preparing[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(accepted[0]!.createdAt.getTime());

    // One push, not two: the accept's words already say it is being prepared.
    const pushes = await kitchenPushes(orderId);
    expect(pushes.map((n) => n.title)).toEqual(['Order Accepted!']);
    expect(pushes[0]!.body).toMatch(/has accepted your order \S+ and is preparing it\.$/);

    // The customer's own screen shows Preparing right after the accept.
    const view = await call('GET', `/api/v1/customer/orders/${orderId}`, customer.token);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().data.status).toBe('PREPARING');
    expect((view.json().data.timeline as Array<{ status: string }>).map((t) => t.status)).toEqual(expect.arrayContaining(['ACCEPTED', 'PREPARING']));
  });

  it('a grocery order too (the pick list lives inside PREPARING)', async () => {
    const orderId = await placeOrder(grocer, 'CASH');
    const res = await accept(grocer, orderId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('PREPARING');
    const row = await orderRow(orderId);
    expect(row.preparingAt?.getTime()).toBe(row.acceptedAt?.getTime());
  });

  it('builds 9/11/12: a "Start preparing" tap after the accept is a 200 no-op — no second row, no second push', async () => {
    const orderId = await placeOrder(diner, 'CASH');
    expect((await accept(diner, orderId)).statusCode).toBe(200);
    const logsBefore = await statusLogs(orderId);
    const pushesBefore = await kitchenPushes(orderId);
    const rowBefore = await orderRow(orderId);

    for (let tap = 0; tap < 2; tap += 1) {
      const res = await startPreparing(diner, orderId);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().data.status).toBe('PREPARING');
    }
    expect(await statusLogs(orderId)).toHaveLength(logsBefore.length);
    expect(await kitchenPushes(orderId)).toHaveLength(pushesBefore.length);
    expect((await orderRow(orderId)).preparingAt?.getTime()).toBe(rowBefore.preparingAt?.getTime());
  });

  it('the no-op never hides a close: "Start preparing" on a rejected order still refuses', async () => {
    const orderId = await placeOrder(diner, 'CASH');
    expect((await accept(diner, orderId)).statusCode).toBe(200);
    const rejected = await call('PUT', `/api/v1/vendor/orders/${orderId}/reject`, diner.owner.token, { reason: 'Kitchen closed early' }, as(diner));
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect((await orderRow(orderId)).status).toBe('CANCELLED');
    const res = await startPreparing(diner, orderId);
    expect(res.statusCode, res.body).toBe(400);
  });
});

describe('[O-3] payment-first is kept: an MMG order is prepared only once the store confirms the money', () => {
  it('unpaid MMG: Accept stops at ACCEPTED (nothing is prepared); "Paid by MMG" starts preparing — no separate tap', async () => {
    const orderId = await placeOrder(diner, 'MOBILE_MONEY');
    const res = await accept(diner, orderId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('ACCEPTED');
    expect((await orderRow(orderId)).preparingAt).toBeNull();
    expect((await statusLogs(orderId)).some((l) => l.status === 'PREPARING')).toBe(false);

    const paid = await paidByMmg(diner, orderId);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().data.status).toBe('PREPARING');
    const row = await orderRow(orderId);
    expect(row.status).toBe('PREPARING');
    expect(row.paymentStatus).toBe('CLAIMED');
    expect(row.preparingAt).toBeInstanceOf(Date);
    expect((await statusLogs(orderId)).filter((l) => l.status === 'PREPARING')).toHaveLength(1);

    // The old "Start preparing" tap is the same harmless no-op.
    const tap = await startPreparing(diner, orderId);
    expect(tap.statusCode, tap.body).toBe(200);
    expect((await statusLogs(orderId)).filter((l) => l.status === 'PREPARING')).toHaveLength(1);
    // A repeated "Paid by MMG" changes nothing more.
    const again = await paidByMmg(diner, orderId);
    expect(again.statusCode, again.body).toBe(200);
    expect((await statusLogs(orderId)).filter((l) => l.status === 'PREPARING')).toHaveLength(1);
  });

  it('MMG confirmed before the accept: Accept goes straight to PREPARING', async () => {
    const orderId = await placeOrder(diner, 'MOBILE_MONEY');
    const paid = await paidByMmg(diner, orderId);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().data.status).toBe('PENDING'); // never accepted for the store
    const res = await accept(diner, orderId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('PREPARING');
    const row = await orderRow(orderId);
    expect(row.preparingAt?.getTime()).toBe(row.acceptedAt?.getTime());
  });
});

describe('[O-3] the seam: the walk shares one commit, every gate of its next hop, and a booking is never prepared', () => {
  /** A socket stand-in that records what each room is told. */
  function recordingIo(tenantId: string | null, userIds: string[]) {
    const events: Array<{ event: string; payload: { status?: string } }> = [];
    const sockets = userIds.map((userId, i) => ({
      id: `sap-socket-${i}`,
      data: { tenantId, userId, authorizationExpiresAtMs: Date.now() + DAY },
      leave: async () => undefined,
    }));
    const io = {
      in: () => ({ fetchSockets: async () => sockets }),
      to: () => ({ emit: (event: string, payload: { status?: string }) => { events.push({ event, payload }); } }),
    };
    return { io, events };
  }

  it('the live events of an Accept say where the order IS (PREPARING), for the store board and the order room', async () => {
    const orderId = await placeOrder(diner, 'CASH');
    const placed = await orderRow(orderId);
    const { io, events } = recordingIo(placed.tenantId, [diner.owner.userId, customer.userId]);
    const service = new OrderService(app.prisma, io as never);
    const [acceptedStatus, preparingStatus] = STORE_ACCEPT_PATH;
    const done = await sys(() => service.updateStatus(orderId, acceptedStatus, diner.owner.userId, 'Accepted by vendor', {
      continueTo: { target: preparingStatus, when: preparationMayStart },
    }));
    expect(done.status).toBe('PREPARING');
    const changes = events.filter((e) => e.event === 'order:status_changed');
    expect(changes.length).toBeGreaterThanOrEqual(2); // order room + store room
    expect(changes.every((e) => e.payload.status === 'PREPARING')).toBe(true);
  });

  it('a walk over an undeclared edge is a programming error and writes nothing (the whole commit rolls back)', async () => {
    const orderId = await placeOrder(diner, 'CASH');
    const service = new OrderService(app.prisma, app.io);
    await expect(sys(() => service.updateStatus(orderId, 'ACCEPTED', diner.owner.userId, 'Accepted by vendor', {
      continueTo: { target: 'READY_FOR_PICKUP', when: () => true },
    }))).rejects.toThrow(/not a declared forward edge/);
    const row = await orderRow(orderId);
    expect(row.status).toBe('PENDING');
    expect(row.acceptedAt).toBeNull();
    expect((await statusLogs(orderId)).some((l) => l.status === 'ACCEPTED')).toBe(false);
  });

  it('a booking is confirmed, never prepared: Accept on an appointment stays at ACCEPTED', async () => {
    const template = await orderRow(await placeOrder(diner, 'CASH'));
    const booking = await sys(() => app.prisma.order.create({
      data: {
        orderNumber: `SAP-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'APPOINTMENT', status: 'PENDING',
        customerId: customer.userId, vendorId: diner.vendorId, tenantId: template.tenantId,
        placedAt: new Date(), subtotalBase: 2500, subtotalMarkup: 0, subtotalCustomer: 2500, deliveryFee: 0, totalAmount: 2500,
        paymentMethod: 'CASH',
      } as never,
    })) as Order;
    const res = await accept(diner, booking.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('ACCEPTED');
    const row = await orderRow(booking.id);
    expect(row.preparingAt).toBeNull();
    expect((await statusLogs(booking.id)).some((l) => l.status === 'PREPARING')).toBe(false);
  });
});

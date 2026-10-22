import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerTenantHeaderScope } from '../plugins/tenant-header-scope';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { registerErrorHandler } from '../middleware/error-handler';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { sweepSubstitutionDeadlines } from '../modules/order/picking.service';
import { vendorResponseSlaMinutes } from '../modules/order/response-sla';
import { autoCancelUnresponsiveOrder, type JobContext } from '../jobs/queue';
import { hashVelocityId } from '../modules/integrity/velocity';
import { purgeAuditLogs } from '../lib/audit-immutability';

// ---------------------------------------------------------------------------
// [O-4 · owner 22 Oct 2026] "Accept the whole order without ticking each item;
// before accepting, each item has Out of stock" — every store type.
//
// - A tick is a tool, never a gate: a grocery order is accepted and marked
//   ready with no line ticked. Only a question the customer has not answered
//   holds the bag (and the accept).
// - Before accepting, "Out of stock" uses the EXISTING substitution flow: with
//   a substitute it is the swap question; with nothing to swap it is a removal
//   question ("Continue without it" or "Cancel order"). The server recalculates
//   the total; the customer agrees to the changed order before paying, and is
//   never charged for an item not supplied. No answer by the deadline = the
//   item comes off (the total only goes down).
// - MMG: the total may change only BEFORE acceptance and before any payment
//   can exist; after that, today's doctrine (fixed in-app).
// - The store is never auto-cancelled for the customer's time: its response
//   clock restarts from the answer.
// Real customer + vendor routes, the production request composition.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+5920344';
const FIXTURE = 'store-flow-whole-order-fixture';
const CLIENT_IP = '10.20.34.4';
const DAY = 24 * 60 * 60 * 1000;
const HOME = { lat: 6.8045, lng: -58.1553 };
const STORE = { lat: 6.8013, lng: -58.1551 };

let app: FastifyInstance;
let ctx: JobContext;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string };
type Store = { owner: Actor; vendorId: string; rice: string; beans: string; riceB: string };
let customer: Actor;
let grocer: Store;

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName, lastName: `Whole${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `swo-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token };
}

async function makeGrocer(name: string): Promise<Store> {
  const owner = await makeUser('Owner', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ownerRow = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const vendorId = (await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name, slug: `swo-${nanoid(8).toLowerCase()}`, vendorType: 'SUPERMARKET',
      phone: `${PHONE_PREFIX}9${String(seq).padStart(2, '0')}`, addressLine1: 'Whole Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 50,
      mmgNumber: '+5926001234',
    },
  }))).id;
  const category = await sys(() => app.prisma.category.create({ data: { vendorId, name: 'Aisles', sortOrder: 0 } }));
  const item = (itemName: string, basePrice: number, group: string | null, stockQuantity: number | null) => sys(() => app.prisma.item.create({
    data: { vendorId, categoryId: category.id, name: itemName, basePrice, isAvailable: true, substitutionGroup: group, stockQuantity },
  }));
  const rice = (await item('Rice 5kg', 2500, 'rice', 20)).id;
  const beans = (await item('Red beans', 1200, null, null)).id;
  const riceB = (await item('Rice 5kg (other brand)', 2700, 'rice', 20)).id;
  return { owner, vendorId, rice, beans, riceB };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method, url, remoteAddress: CLIENT_IP,
    headers: { ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  } as InjectOptions);
}
const as = (store: Store) => ({ 'x-vendor-id': store.vendorId });
const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id }, include: { items: true } }));
const lineOf = async (orderId: string, itemId: string) => (await orderRow(orderId)).items.find((l) => l.itemId === itemId)!;
const pushes = (orderId: string) => sys(async () => (await app.prisma.notification.findMany({ where: { userId: customer.userId }, orderBy: { createdAt: 'asc' } }))
  .filter((n) => JSON.stringify(n.data ?? {}).includes(orderId)));

/** A real checkout: rice ×1 and beans ×2 from the grocer. */
async function placeOrder(paymentMethod: 'MOBILE_MONEY' | 'CASH' = 'CASH') {
  expect((await call('DELETE', '/api/v1/customer/cart', customer.token)).statusCode).toBe(200);
  for (const [itemId, quantity] of [[grocer.rice, 1], [grocer.beans, 2]] as const) {
    const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: grocer.vendorId, itemId, quantity });
    expect(added.statusCode, added.body).toBe(201);
  }
  const body = paymentMethod === 'MOBILE_MONEY' ? { paymentMethod, mmgPayTo: 'STORE_NUMBER' } : { paymentMethod };
  const res = await call('POST', '/api/v1/customer/checkout', customer.token, body, { 'idempotency-key': `swo-${nanoid(10)}` });
  expect(res.statusCode, res.body).toBe(200);
  const orderId = (res.json().data as { order: { id: string } }).order.id;
  // LIFECYCLE_V2's checkout hold is its own journey: the store sees the order now.
  await sys(() => app.prisma.order.update({ where: { id: orderId }, data: { holdExpiresAt: null } }));
  return orderId;
}
const accept = (orderId: string) => call('PUT', `/api/v1/vendor/orders/${orderId}/accept`, grocer.owner.token, undefined, as(grocer));
const ready = (orderId: string) => call('PUT', `/api/v1/vendor/orders/${orderId}/ready`, grocer.owner.token, undefined, as(grocer));
const outOfStock = (orderId: string, lineId: string) => call('POST', `/api/v1/vendor/orders/${orderId}/items/${lineId}/refund-line`, grocer.owner.token, {}, as(grocer));
const offerSwap = (orderId: string, lineId: string, substituteItemId: string) =>
  call('POST', `/api/v1/vendor/orders/${orderId}/items/${lineId}/substitute`, grocer.owner.token, { substituteItemId }, as(grocer));
const answer = (orderId: string, lineId: string, approve: boolean) =>
  call('POST', `/api/v1/customer/orders/${orderId}/items/${lineId}/substitution`, customer.token, { approve });
const customerView = async (orderId: string, capability = true) => {
  const res = await call('GET', `/api/v1/customer/orders/${orderId}${capability ? '?swapDecisions=v1' : ''}`, customer.token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as { totalAmount: number | string; items: Array<Record<string, unknown> & { id: string; name: string }> };
};

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
    await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: [...orderIds, ...vendorIds] } }, { userId: { in: ids } }] }, 'STORE-FLOW whole-order fixture cleanup');
    await app.prisma.supportTicket.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { userId: { in: ids } }] } });
    await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.stockAdjustment.deleteMany({ where: { item: { vendorId: { in: vendorIds } } } });
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
  ctx = { prisma: app.prisma, io: app.io, redis: app.redis, log: app.log } as JobContext;
  await purgeFixtures();

  customer = await makeUser('Asha', ['CUSTOMER'], 'CUSTOMER');
  await sys(() => app.prisma.address.create({
    data: { userId: customer.userId, label: 'Home', addressLine1: '4 Whole Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: HOME.lat, longitude: HOME.lng, isDefault: true },
  }));
  grocer = await makeGrocer('Whole Order Grocery');
});

afterAll(async () => {
  try { await purgeFixtures(); } finally { await app.close(); vi.unstubAllEnvs(); }
});

describe('[O-4] a tick is a tool, never a gate', () => {
  it('a grocery order is accepted and marked ready with no line ticked', async () => {
    const orderId = await placeOrder();
    const accepted = await accept(orderId);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await orderRow(orderId)).items.every((l) => !l.picked)).toBe(true);
    const done = await ready(orderId);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().data.status).toBe('READY_FOR_PICKUP');
  });

  it('before accepting, a tick waits for the accept (only "Out of stock" is offered)', async () => {
    const orderId = await placeOrder();
    const rice = await lineOf(orderId, grocer.rice);
    const tick = await call('PUT', `/api/v1/vendor/orders/${orderId}/items/${rice.id}/picked`, grocer.owner.token, { picked: true }, as(grocer));
    expect(tick.statusCode, tick.body).toBe(409);
    expect(tick.json().error.code).toBe('ACCEPT_FIRST');
    expect((await lineOf(orderId, grocer.rice)).picked).toBe(false);
  });
});

describe('[O-4] "Out of stock" before accepting asks the customer', () => {
  it('nothing to swap: the customer is asked to continue without it or cancel; the total waits for the answer; the accept waits too', async () => {
    const orderId = await placeOrder();
    const before = await orderRow(orderId);
    const rice = before.items.find((l) => l.itemId === grocer.rice)!;

    const asked = await outOfStock(orderId, rice.id);
    expect(asked.statusCode, asked.body).toBe(200);
    const line = await lineOf(orderId, grocer.rice);
    expect({ sub: line.subStatus, swap: line.substituteItemId, name: line.substituteName }).toEqual({ sub: 'PENDING', swap: null, name: null });
    expect(line.substituteDecideBy!.getTime()).toBeGreaterThan(Date.now());
    const after = await orderRow(orderId);
    expect({ status: after.status, total: Number(after.totalAmount) }).toEqual({ status: 'PENDING', total: Number(before.totalAmount) });

    const told = (await pushes(orderId)).filter((n) => n.title === `${rice.name} is out of stock`);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain('continue without it');
    expect(told[0]!.body).toContain('cancel the order');

    const view = (await customerView(orderId)).items.find((i) => i.id === rice.id)!;
    expect(view['substitution']).toMatchObject({
      state: 'PENDING', kind: 'REMOVAL', proposed: null, priceDelta: -Number(rice.totalCustomer),
      decisions: { approve: true, reject: false }, ifNoAnswer: 'REMOVE',
    });

    const refused = await accept(orderId);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('CUSTOMER_DECIDING');
    expect(refused.json().error.message).toContain(rice.name);
    expect((await orderRow(orderId)).status).toBe('PENDING');
  });

  it('"Continue without it": the line comes off, the total goes down by exactly that line, and the store accepts the rest', async () => {
    const orderId = await placeOrder();
    const before = await orderRow(orderId);
    const rice = before.items.find((l) => l.itemId === grocer.rice)!;
    expect((await outOfStock(orderId, rice.id)).statusCode).toBe(200);
    const stockBefore = (await sys(() => app.prisma.item.findUniqueOrThrow({ where: { id: grocer.rice } }))).stockQuantity!;

    const yes = await answer(orderId, rice.id, true);
    expect(yes.statusCode, yes.body).toBe(200);
    const after = await orderRow(orderId);
    expect(after.items.find((l) => l.id === rice.id)!.subStatus).toBe('REFUNDED');
    expect(Number(after.totalAmount)).toBe(Number(before.totalAmount) - Number(rice.totalCustomer));
    expect(Number(after.subtotalCustomer)).toBe(Number(before.subtotalCustomer) - Number(rice.totalCustomer));
    expect((await sys(() => app.prisma.item.findUniqueOrThrow({ where: { id: grocer.rice } }))).stockQuantity).toBe(stockBefore + rice.quantity);

    const accepted = await accept(orderId);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(Number(accepted.json().data.totalAmount)).toBe(Number(after.totalAmount));
    expect((await ready(orderId)).statusCode).toBe(200);
  });

  it('"Cancel order" is the free cancel a waiting order already has; a decline on a removal question is refused', async () => {
    const orderId = await placeOrder();
    const rice = await lineOf(orderId, grocer.rice);
    expect((await outOfStock(orderId, rice.id)).statusCode).toBe(200);
    const no = await answer(orderId, rice.id, false);
    expect(no.statusCode, no.body).toBe(409);
    expect(no.json().error.code).toBe('CANCEL_INSTEAD');
    expect((await lineOf(orderId, grocer.rice)).subStatus).toBe('PENDING');

    const cancelled = await call('POST', `/api/v1/customer/orders/${orderId}/cancel`, customer.token, { reason: 'Needed the rice' });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await orderRow(orderId)).status).toBe('CANCELLED');
  });

  it('a swap before accepting: the customer approves, the total moves by the price difference, then the store accepts', async () => {
    const orderId = await placeOrder();
    const before = await orderRow(orderId);
    const rice = before.items.find((l) => l.itemId === grocer.rice)!;
    const offered = await offerSwap(orderId, rice.id, grocer.riceB);
    expect(offered.statusCode, offered.body).toBe(200);
    expect((await accept(orderId)).json().error.code).toBe('CUSTOMER_DECIDING');

    const view = (await customerView(orderId)).items.find((i) => i.id === rice.id)!;
    expect(view['substitution']).toMatchObject({ kind: 'SWAP', priceDelta: 200, decisions: { approve: true, reject: true } });
    expect((await answer(orderId, rice.id, true)).statusCode).toBe(200);
    expect(Number((await orderRow(orderId)).totalAmount)).toBe(Number(before.totalAmount) + 200);
    expect((await accept(orderId)).statusCode).toBe(200);
  });

  it('no answer by the deadline: the item comes off (the total only goes down) and the customer is told', async () => {
    const orderId = await placeOrder();
    const before = await orderRow(orderId);
    const rice = before.items.find((l) => l.itemId === grocer.rice)!;
    expect((await outOfStock(orderId, rice.id)).statusCode).toBe(200);
    const due = (await lineOf(orderId, grocer.rice)).substituteDecideBy!;
    const swept = await sys(() => sweepSubstitutionDeadlines(app.prisma, app.io, { now: new Date(due.getTime() + 1_000) }));
    expect(swept.removed).toBeGreaterThanOrEqual(1);
    const after = await orderRow(orderId);
    expect(after.items.find((l) => l.id === rice.id)!.subStatus).toBe('REFUNDED');
    expect(Number(after.totalAmount)).toBe(Number(before.totalAmount) - Number(rice.totalCustomer));
    expect((await pushes(orderId)).map((n) => n.title)).toContain(`${rice.name} removed from your order`);
    expect((await accept(orderId)).statusCode).toBe(200);
  });

  it('every item removed: there is nothing to accept — the store rejects instead', async () => {
    const orderId = await placeOrder();
    for (const line of (await orderRow(orderId)).items) {
      expect((await outOfStock(orderId, line.id)).statusCode).toBe(200);
      expect((await answer(orderId, line.id, true)).statusCode).toBe(200);
    }
    const refused = await accept(orderId);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('NOTHING_TO_ACCEPT');
    expect((await orderRow(orderId)).status).toBe('PENDING');
  });

  it('an older customer build (no swap decisions) reads a true line and gets no swap card for a removal', async () => {
    const orderId = await placeOrder();
    const rice = await lineOf(orderId, grocer.rice);
    expect((await outOfStock(orderId, rice.id)).statusCode).toBe(200);
    const legacy = (await customerView(orderId, false)).items.find((i) => i.id === rice.id)!;
    expect(legacy.name).toBe(`${rice.name} (out of stock: it is being removed and your total will go down)`);
    expect(legacy['subStatus']).not.toBe('PENDING');
  });
});

describe('[O-4] MMG: the total may change only before acceptance and before any payment can exist', () => {
  it('a waiting MMG order: "Continue without it" lowers the total the customer will pay; the accept then waits for "Paid by MMG"', async () => {
    const orderId = await placeOrder('MOBILE_MONEY');
    const before = await orderRow(orderId);
    const rice = before.items.find((l) => l.itemId === grocer.rice)!;
    const asked = await outOfStock(orderId, rice.id);
    expect(asked.statusCode, asked.body).toBe(200);
    expect((await answer(orderId, rice.id, true)).statusCode).toBe(200);
    expect(Number((await orderRow(orderId)).totalAmount)).toBe(Number(before.totalAmount) - Number(rice.totalCustomer));
    const accepted = await accept(orderId);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().data.status).toBe('ACCEPTED');
  });

  it('after acceptance an MMG total stays fixed in-app (unchanged doctrine)', async () => {
    const orderId = await placeOrder('MOBILE_MONEY');
    expect((await accept(orderId)).statusCode).toBe(200);
    const rice = await lineOf(orderId, grocer.rice);
    const refused = await outOfStock(orderId, rice.id);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('MMG_ADJUSTMENT_UNAVAILABLE');
  });

  it('a waiting MMG order on which money may already have moved (a customer "I paid") keeps its total fixed', async () => {
    const orderId = await placeOrder('MOBILE_MONEY');
    await sys(() => app.prisma.order.update({ where: { id: orderId }, data: { customerMmgClaim: 'PAID' } }));
    const rice = await lineOf(orderId, grocer.rice);
    const refused = await outOfStock(orderId, rice.id);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('MMG_ADJUSTMENT_UNAVAILABLE');
    expect((await lineOf(orderId, grocer.rice)).subStatus).toBe('NONE');
  });
});

describe('[O-4] the store is never auto-cancelled for the customer\'s time', () => {
  it('an open question holds the no-response cancel, which is armed again for the answer deadline + the response time', async () => {
    const orderId = await placeOrder();
    const rice = await lineOf(orderId, grocer.rice);
    expect((await outOfStock(orderId, rice.id)).statusCode).toBe(200);
    const due = (await lineOf(orderId, grocer.rice)).substituteDecideBy!;
    const sla = await vendorResponseSlaMinutes(app.prisma);

    expect(await sys(() => autoCancelUnresponsiveOrder(ctx, orderId))).toBe(false);
    expect((await orderRow(orderId)).status).toBe('PENDING');
    const rearmed = await sys(() => app.prisma.orderOutbox.findMany({ where: { orderId, kind: 'auto-cancel', dedupeKey: { contains: 'after-question' } } }));
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]!.dedupeKey).toContain(String(due.getTime() + sla * 60_000));

    const detail = await call('GET', `/api/v1/vendor/orders/${orderId}`, grocer.owner.token, undefined, as(grocer));
    expect(new Date(detail.json().data.respondBy).getTime()).toBe(due.getTime() + sla * 60_000);
  });

  it('after the answer the store has its full response time from the answer; past it, the cancel runs', async () => {
    const orderId = await placeOrder();
    const rice = await lineOf(orderId, grocer.rice);
    expect((await outOfStock(orderId, rice.id)).statusCode).toBe(200);
    const answeredAt = Date.now();
    expect((await answer(orderId, rice.id, true)).statusCode).toBe(200);
    const sla = await vendorResponseSlaMinutes(app.prisma);
    const stamp = (await lineOf(orderId, grocer.rice)).substituteDecideBy!;
    expect(stamp.getTime()).toBeGreaterThanOrEqual(answeredAt - 1_000);
    expect(await sys(() => autoCancelUnresponsiveOrder(ctx, orderId))).toBe(false);
    expect((await orderRow(orderId)).status).toBe('PENDING');

    // The store's time from the answer runs out.
    await sys(() => app.prisma.orderItem.update({ where: { id: rice.id }, data: { substituteDecideBy: new Date(Date.now() - (sla + 1) * 60_000) } }));
    expect(await sys(() => autoCancelUnresponsiveOrder(ctx, orderId))).toBe(true);
    expect((await orderRow(orderId)).status).toBe('CANCELLED');
  });
});

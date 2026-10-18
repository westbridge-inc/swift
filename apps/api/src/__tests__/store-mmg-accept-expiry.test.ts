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
import { expireUnpaidMmgAcceptance, expireUnpaidMmgAcceptancesJob, type JobContext } from '../jobs/queue';
import { MMG_ACCEPT_EXPIRY_REASON } from '../modules/order/mmg-accept-expiry';
import { hashVelocityId } from '../modules/integrity/velocity';
import { purgeAuditLogs } from '../lib/audit-immutability';

// ---------------------------------------------------------------------------
// [owner 18 Oct 2026 · PAYMENT-SIMPLIFY] An MMG order the store ACCEPTED but
// never marked "Paid by MMG" cancels automatically 30 minutes after it was
// accepted, and the customer and the store are both told why (push + order
// card). At 29 minutes it stays; at 30 it cancels; a "Paid by MMG" tap at 29:59
// wins. One canonical locked transition ACCEPTED -> CANCELLED (order-status.ts
// edge), re-decided on the locked row, so the tap and the cancel can never both
// win; the sweep is idempotent. Real customer + vendor routes, the production
// request composition.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+5920334';
const FIXTURE = 'paysimp-mmg-accept-expiry-fixture';
const CLIENT_IP = '10.20.33.4';
const NUMBER = '+5926001234';
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60_000;
const HOME = { lat: 6.8045, lng: -58.1553 };
const STORE = { lat: 6.8013, lng: -58.1551 };

let app: FastifyInstance;
let ctx: JobContext;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };
let customer: Actor;
let owner: Actor;
let vendorId: string;
let itemId: string;

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName, lastName: `Exp${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `pse-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method, url, remoteAddress: CLIENT_IP,
    headers: { ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  } as InjectOptions);
}
const store = () => ({ 'x-vendor-id': vendorId });
const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const statusLogs = (orderId: string) => sys(() => app.prisma.orderStatusLog.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }));
const notices = (userId: string, orderId: string) => sys(async () => (await app.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }))
  .filter((n) => JSON.stringify(n.data ?? {}).includes(orderId)));

async function placeOrder(paymentMethod: 'MOBILE_MONEY' | 'CASH') {
  expect((await call('DELETE', '/api/v1/customer/cart', customer.token)).statusCode).toBe(200);
  const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId, quantity: 1 });
  expect(added.statusCode, added.body).toBe(201);
  const body = paymentMethod === 'MOBILE_MONEY' ? { paymentMethod, mmgPayTo: 'STORE_NUMBER' } : { paymentMethod };
  const res = await call('POST', '/api/v1/customer/checkout', customer.token, body, { 'idempotency-key': `pse-${nanoid(10)}` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().data as { order: { id: string } }).order.id;
}
const accept = (orderId: string) => call('PUT', `/api/v1/vendor/orders/${orderId}/accept`, owner.token, undefined, store());
const paidByMmg = (orderId: string) => call('POST', `/api/v1/vendor/orders/${orderId}/confirm-payment`, owner.token, { reference: `MP${nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, '7')}` }, store());
const customerView = async (orderId: string) => {
  const res = await call('GET', `/api/v1/customer/orders/${orderId}`, customer.token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as Record<string, unknown> & { mmgPayment: null | Record<string, unknown>; cancellationNotice: string | null };
};
const storeView = async (orderId: string) => {
  const res = await call('GET', `/api/v1/vendor/orders/${orderId}`, owner.token, undefined, store());
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as Record<string, unknown>;
};
/** Accept, then put the acceptance `ago` ms in the past (time's one input). */
async function acceptedAgo(orderId: string, ago: number): Promise<Date> {
  const res = await accept(orderId);
  expect(res.statusCode, res.body).toBe(200);
  return backdate(orderId, ago);
}
async function backdate(orderId: string, ago: number): Promise<Date> {
  const acceptedAt = new Date(Date.now() - ago);
  await sys(() => app.prisma.order.update({ where: { id: orderId }, data: { acceptedAt } }));
  return acceptedAt;
}
const sweep = () => sys(() => expireUnpaidMmgAcceptancesJob(ctx));
const expireOne = (orderId: string) => sys(() => expireUnpaidMmgAcceptance(ctx, orderId));

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
    await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: [...orderIds, ...vendorIds] } }, { userId: { in: ids } }] }, 'PAYMENT-SIMPLIFY accept-expiry fixture cleanup');
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
  ctx = { prisma: app.prisma, io: app.io, redis: app.redis, log: app.log };
  await purgeFixtures();

  customer = await makeUser('Rani', ['CUSTOMER'], 'CUSTOMER');
  await sys(() => app.prisma.address.create({
    data: { userId: customer.userId, label: 'Home', addressLine1: '9 Expiry Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: HOME.lat, longitude: HOME.lng, isDefault: true },
  }));
  owner = await makeUser('Ravi', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ownerRow = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  vendorId = (await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name: 'Window Diner', slug: `pse-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}900`, addressLine1: 'Diner Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 50,
      mmgNumber: NUMBER,
    },
  }))).id;
  const category = await sys(() => app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } }));
  itemId = (await sys(() => app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Cook-up', basePrice: 2500, isAvailable: true } }))).id;
});

afterAll(async () => {
  try { await purgeFixtures(); } finally { await app.close(); vi.unstubAllEnvs(); }
});

describe('[owner 18 Oct · PAYMENT-SIMPLIFY] an accepted MMG order not marked "Paid by MMG" cancels 30 minutes after acceptance', () => {
  it('[REVIEW-F S2-1] accepting an unpaid MMG order tells the customer to pay, how much and by when — never "preparing", never the number', async () => {
    const orderId = await placeOrder('MOBILE_MONEY');
    const res = await accept(orderId);
    expect(res.statusCode, res.body).toBe(200);
    await vi.waitFor(async () => expect((await notices(customer.userId, orderId)).length).toBeGreaterThan(0));
    const pushes = await notices(customer.userId, orderId);
    const pay = pushes.find((n) => n.title === 'Pay by MMG to confirm your order');
    expect(pay, JSON.stringify(pushes.map((n) => n.title))).toBeTruthy();
    expect(pay!.body).toMatch(/^Window Diner accepted order \S+\. Pay GY\$[\d,]+ by MMG — open your order for the number — by \d{1,2}:\d{2} [AP]M, or it cancels automatically\.$/);
    expect(pay!.body).not.toContain('6001234'); // a push shows on the lock screen: never the number
    expect(pushes.some((n) => /is preparing it/.test(n.body))).toBe(false);
  });

  it('at 29 minutes it stays (and both sides see when it will cancel); at 30 it cancels once, and both are told why', async () => {
    const orderId = await placeOrder('MOBILE_MONEY');
    const acceptedAt = await acceptedAgo(orderId, 29 * MIN);
    const payBy = new Date(acceptedAt.getTime() + 30 * MIN).toISOString();

    // 29 minutes: nothing happens — not by the sweep, not even by a direct call.
    expect(await sweep()).not.toContain(orderId);
    expect(await expireOne(orderId)).toBe(false);
    expect((await orderRow(orderId)).status).toBe('ACCEPTED');
    // The customer's pay instruction and the store's card both carry the server's deadline.
    const waiting = await customerView(orderId);
    expect(waiting.mmgPayment).toMatchObject({ payBy });
    expect(String(waiting.mmgPayment?.['deadline'])).toMatch(/^If Window Diner hasn't marked it paid by \d{1,2}:\d{2} [AP]M, the order is cancelled automatically\.$/);
    expect(waiting.cancellationNotice).toBeNull();
    const storeWaiting = await storeView(orderId);
    expect(storeWaiting['mmgPayBy']).toBe(payBy);
    expect(String(storeWaiting['mmgPayByLine'])).toMatch(/^Cancels automatically at \d{1,2}:\d{2} [AP]M unless you mark it "Paid by MMG"\.$/);
    const logsBefore = (await statusLogs(orderId)).length;

    // 30 minutes: it cancels — a system cancellation through the ACCEPTED -> CANCELLED edge.
    await backdate(orderId, 30 * MIN);
    expect(await sweep()).toContain(orderId);
    const row = await orderRow(orderId);
    expect(row.status).toBe('CANCELLED');
    expect(row.paymentStatus).toBe('PENDING');
    expect(row.cancelledBy).toBeNull(); // never counted against the customer
    expect(row.cancellationReason).toBe(MMG_ACCEPT_EXPIRY_REASON);
    const logs = await statusLogs(orderId);
    expect(logs).toHaveLength(logsBefore + 1);
    expect(logs.at(-1)).toMatchObject({ status: 'CANCELLED', changedBy: null });
    // The seam's own unattested-MMG line follows the reason (the store refunds directly).
    expect(logs.at(-1)?.note?.startsWith(`${MMG_ACCEPT_EXPIRY_REASON} — MMG payment UNATTESTED`)).toBe(true);

    // Both told why: a push each, and the order cards.
    const toCustomer = await notices(customer.userId, orderId);
    expect(toCustomer.map((n) => n.title)).toContain('Order cancelled — MMG payment not confirmed');
    const customerPush = toCustomer.find((n) => n.title === 'Order cancelled — MMG payment not confirmed')!;
    expect(customerPush.body).toContain('within 30 minutes of accepting');
    expect(customerPush.body).toContain('Window Diner refunds you directly');
    const toStore = await notices(owner.userId, orderId);
    expect(toStore.some((n) => n.body.includes('not marked "Paid by MMG" within 30 minutes'))).toBe(true);
    const closed = await customerView(orderId);
    expect(closed.mmgPayment).toBeNull(); // the number is never shown on a closed order
    expect(closed.cancellationNotice).toBe("Window Diner didn't mark your MMG payment as received within 30 minutes of accepting, so this order was cancelled automatically. If you already sent the MMG payment, Window Diner refunds you directly.");
    const storeClosed = await storeView(orderId);
    expect(storeClosed['cancellationReason']).toBe(MMG_ACCEPT_EXPIRY_REASON);
    expect(storeClosed['mmgPayBy']).toBeNull();

    // Idempotent: the next sweep and a direct replay change nothing and tell no one again.
    expect(await sweep()).not.toContain(orderId);
    expect(await expireOne(orderId)).toBe(false);
    expect(await statusLogs(orderId)).toHaveLength(logsBefore + 1);
    expect(await notices(customer.userId, orderId)).toHaveLength(toCustomer.length);
    expect(await notices(owner.userId, orderId)).toHaveLength(toStore.length);
    // A late "Paid by MMG" on the cancelled order is refused; nothing is written.
    const late = await paidByMmg(orderId);
    expect(late.statusCode, late.body).toBe(409);
    expect(late.json().error.code).toBe('ORDER_CLOSED');
    expect((await orderRow(orderId)).paymentStatus).toBe('PENDING');
  });

  it('a "Paid by MMG" tap at 29:59 wins: the order is never cancelled afterwards', async () => {
    const orderId = await placeOrder('MOBILE_MONEY');
    await acceptedAgo(orderId, 30 * MIN - 1000);
    const tap = await paidByMmg(orderId);
    expect(tap.statusCode, tap.body).toBe(200);
    // The sweep runs late; the order is paid, so it is not touched.
    await backdate(orderId, 45 * MIN);
    expect(await sweep()).not.toContain(orderId);
    expect(await expireOne(orderId)).toBe(false);
    const row = await orderRow(orderId);
    expect(row.status).not.toBe('CANCELLED');
    expect(row.paymentStatus).toBe('CLAIMED');
    expect((await storeView(orderId))['mmgPayBy']).toBeNull();
    expect((await customerView(orderId)).cancellationNotice).toBeNull();
  });

  it('the tap and the cancel at the same moment: exactly one wins, never both', async () => {
    for (let round = 0; round < 3; round += 1) {
      const orderId = await placeOrder('MOBILE_MONEY');
      await acceptedAgo(orderId, 31 * MIN);
      const [tap, cancelled] = await Promise.all([paidByMmg(orderId), expireOne(orderId)]);
      const row = await orderRow(orderId);
      if (cancelled) {
        expect(tap.statusCode, tap.body).toBe(409);
        expect(row.status).toBe('CANCELLED');
        expect(row.paymentStatus).toBe('PENDING');
        expect(row.mmgAttestedRef).toBeNull();
      } else {
        expect(tap.statusCode, tap.body).toBe(200);
        expect(row.status).toBe('ACCEPTED');
        expect(row.paymentStatus).toBe('CLAIMED');
      }
      expect((await statusLogs(orderId)).filter((l) => l.status === 'CANCELLED').length).toBe(cancelled ? 1 : 0);
    }
  });

  it('only accepted, unpaid MMG orders expire: a waiting (not yet accepted) MMG order and an accepted CASH order are left alone', async () => {
    const pending = await placeOrder('MOBILE_MONEY');
    await sys(() => app.prisma.order.update({ where: { id: pending }, data: { createdAt: new Date(Date.now() - 2 * 60 * MIN) } }));
    const cash = await placeOrder('CASH');
    await acceptedAgo(cash, 2 * 60 * MIN);
    const swept = await sweep();
    expect(swept).not.toContain(pending);
    expect(swept).not.toContain(cash);
    expect(await expireOne(cash)).toBe(false);
    expect(await expireOne(pending)).toBe(false);
    expect((await orderRow(cash)).status).toBe('ACCEPTED');
    expect((await orderRow(pending)).status).not.toBe('CANCELLED');
    expect((await storeView(cash))['mmgPayBy']).toBeNull();
  });
});

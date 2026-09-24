import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { registerTenantHeaderScope } from '../../plugins/tenant-header-scope';
import { registerEmptyJsonBodyParser } from '../../plugins/empty-json';
import { registerErrorHandler } from '../../middleware/error-handler';
import { customerRoutes } from '../../modules/user/customer.routes';
import { vendorRoutes } from '../../modules/vendor/vendor.routes';
import { riderRoutes } from '../../modules/rider/rider.routes';
import { adminRoutes } from '../../modules/admin/admin.routes';
import { applyDueMmgLinkChanges } from '../../modules/integrity/money-surface';
import { hashVelocityId } from '../../modules/integrity/velocity';
import { autoCancelUnresponsiveOrder } from '../../jobs/queue';
import { purgeAuditLogs } from '../../lib/audit-immutability';
import { grantStepUp } from '../helpers/step-up';

// ---------------------------------------------------------------------------
// GOLD-2 · VEND-03 + MONEY-02 — the vendor's own MMG pay-link rail, where
// Swift holds nothing (and the MMG half of CUST-02).
//
// The production composition (app.ts: tenant context per request, the empty-
// JSON parser, the vendor-header scope) with the real customer, vendor, rider
// and admin route modules, real sessions and a real database. The cool-off
// executor is the worker's own `mmg-link-apply` function and the no-response
// expiry is the order worker's own `autoCancelUnresponsiveOrder`. Asserted on
// durable rows:
//   · the pay link: owner-only, step-up first, staged behind the cool-off;
//     nothing is payable until the cool-off job applies it
//   · an MMG order end to end: the external link, the customer's claim, the
//     store's attestation (a CLAIM, never a capture), fulfilment, a fresh
//     screen at the door, and the delivery pay closed in cash by both sides
//   · one wallet reference settles one order; two different references for
//     one order are a disagreement that holds it
//   · a denial after the store's claim holds fulfilment — at the store, the
//     rider board and the door — until a person decides, and the decision
//     releases or reopens it
//   · expiry and recovery: an unpaid order the store never answers expires
//     with honest notices; an attested one does not; the next order goes
//   · a same-price grocery substitution proceeds; [E02 · it.fails] a stock-out
//     on an MMG order is resolved in the app
// ---------------------------------------------------------------------------

// This file's own fixture block (+5920322nnn, 11 characters); phones and the
// crash-recovery purge share this ONE constant.
const PHONE_PREFIX = '+5920322';
const FIXTURE = 'gold2-mmg-fixture';
// The money-surface velocity budget counts per IP too; this file's requests
// arrive from their own address so no other suite shares its bucket.
const CLIENT_IP = '10.20.32.2';
const PAY_HOST = 'pay.example.com';
const DAY = 24 * 60 * 60 * 1000;
const HOME = { lat: 6.8045, lng: -58.1553 };
const STORE = { lat: 6.8013, lng: -58.1551 };
const REASON = { 'x-swift-reason': 'GOLD-2 golden journey: deciding a disputed MMG payment claim' };

let app: FastifyInstance;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };
type Rider = Actor & { riderId: string };
let customer: Actor;
let stranger: Actor;
let dinerOwner: Actor;
let marketOwner: Actor;
let admin: Actor;
let dinerId: string;
let dinerItemId: string;
let marketId: string;
const market: Record<'rice' | 'riceOther' | 'riceLarge' | 'oil', string> = { rice: '', riceOther: '', riceLarge: '', oil: '' };
const DINER_LINK = `https://${PAY_HOST}/pay/gold2-diner`;
const MARKET_LINK = `https://${PAY_HOST}/pay/gold2-market`;
const CAFE_LINK = `https://${PAY_HOST}/pay/gold2-cafe`;

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole, opts: { admin?: boolean } = {}): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName,
      lastName: `Mmg${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(opts.admin && { admin: { create: { permissions: ['*'] } } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `g2m-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

async function makeRider(firstName: string): Promise<Rider> {
  const actor = await makeUser(firstName, ['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await sys(() => app.prisma.rider.create({
    data: {
      userId: actor.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE', documentsVerified: true,
      isOnline: true, isAvailable: true, currentLat: STORE.lat, currentLng: STORE.lng, lastLocationUpdate: new Date(),
      locationSessionId: actor.sessionId, floatLimit: 100_000,
    },
  }));
  return { ...actor, riderId: rider.id };
}

async function makeStore(owner: Actor, name: string, vendorType: 'RESTAURANT' | 'SUPERMARKET') {
  const ownerRow = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const vendor = await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name, slug: `gold2-mmg-${nanoid(8).toLowerCase()}`, vendorType,
      phone: `${PHONE_PREFIX}9${String(seq).padStart(2, '0')}`, addressLine1: `${name} Street`, city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 50,
    },
  }));
  const category = await sys(() => app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Shelf', sortOrder: 0 } }));
  return { vendorId: vendor.id, categoryId: category.id };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    remoteAddress: CLIENT_IP,
    headers: {
      ...headers,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  } as InjectOptions);
}
const asStore = (vendorId: string) => ({ 'x-vendor-id': vendorId });

/** The owner sets a pay link through the real route: step-up, stage. */
async function stageLink(owner: Actor, vendorId: string, url: string) {
  await grantStepUp(app, owner.token);
  const staged = await call('PUT', '/api/v1/vendor/profile', owner.token, { mmgPayUrl: url }, asStore(vendorId));
  expect(staged.statusCode, staged.body).toBe(200);
  return staged;
}
/** Time passes the cool-off (its single aging input), then the worker's own
 *  `mmg-link-apply` executor runs. */
async function coolOffPasses(vendorId: string) {
  await sys(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgPayUrlApplyAt: new Date(Date.now() - 1000) } }));
  return applyDueMmgLinkChanges({ prisma: app.prisma, io: app.io });
}

async function checkoutMmg(lines: Array<{ vendorId: string; itemId: string; quantity: number }>, who: Actor = customer) {
  expect((await call('DELETE', '/api/v1/customer/cart', who.token)).statusCode).toBe(200);
  for (const line of lines) {
    const added = await call('POST', '/api/v1/customer/cart/items', who.token, line);
    expect(added.statusCode, added.body).toBe(201);
  }
  return call('POST', '/api/v1/customer/checkout', who.token, { paymentMethod: 'MOBILE_MONEY' }, { 'idempotency-key': `gold2-mmg-${nanoid(10)}` });
}
/** [MKT-F057] The customer holds the door PIN: it is on their own order screen while the
 *  goods are between the store and the door. The rider enters what they are told. */
async function doorPin(orderId: string, holder: Actor = customer): Promise<string> {
  const res = await call('GET', `/api/v1/customer/orders/${orderId}`, holder.token);
  expect(res.statusCode, res.body).toBe(200);
  const pin: string = res.json().data.ridePin;
  expect(pin).toMatch(/^\d{6}$/);
  return pin;
}

async function dinerOrder(quantity = 1) {
  const res = await checkoutMmg([{ vendorId: dinerId, itemId: dinerItemId, quantity }]);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as { order: { id: string; total: number; deliveryFee: number }; paymentAction: Record<string, unknown> };
}
const newRef = () => `MP${nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, '7')}`;

function attest(orderId: string, reference: string, owner: Actor = dinerOwner, vendorId: string = dinerId) {
  return call('POST', `/api/v1/vendor/orders/${orderId}/confirm-payment`, owner.token, { reference }, asStore(vendorId));
}
async function storeStep(orderId: string, step: 'accept' | 'preparing' | 'ready', owner: Actor = dinerOwner, vendorId: string = dinerId) {
  return call('PUT', `/api/v1/vendor/orders/${orderId}/${step}`, owner.token, undefined, asStore(vendorId));
}
async function riderStep(rider: Rider, orderId: string, step: string) {
  return call('PUT', `/api/v1/rider/orders/${orderId}/${step}`, rider.token, {});
}
async function activeHandover(rider: Rider) {
  const res = await call('GET', '/api/v1/rider/orders/active', rider.token);
  expect(res.statusCode).toBe(200);
  return res.json().data.handover as { rail: string; paymentState: string; custodyState: string; version: string; permitted: string; blockReason: string | null };
}
const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const claimFacts = async (id: string) => {
  const o = await orderRow(id);
  return { status: o.status, paymentStatus: o.paymentStatus, mismatch: o.mmgClaimMismatchAt != null, revision: o.mmgClaimRevision, resolution: o.mmgClaimResolution };
};

function resolveClaim(orderId: string, token: string, body: Record<string, unknown>) {
  return call('POST', `/api/v1/admin/orders/${orderId}/payment-claim/resolve`, token, body, REASON);
}

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const vendorIds = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: ids } } }, select: { id: true } })).map((v) => v.id);
    const riderIds = (await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((r) => r.id);
    const orderIds = (await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendorIds } }, { riderId: { in: riderIds } }] },
      select: { id: true },
    })).map((o) => o.id);
    const sessionIds = (await app.prisma.session.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((s) => s.id);
    if (orderIds.length > 0) {
      // A disagreement pages every platform admin (the seeded one included);
      // each page is tracked by an alert row whose id is derived from this
      // order's notice key and the admin — so exactly these rows are removed.
      const pages = await app.prisma.$queryRaw<Array<{ userId: string; orderId: string; revision: string }>>`
        SELECT "userId", "data"->>'orderId' AS "orderId", "data"->>'claimRevision' AS "revision"
        FROM "notifications"
        WHERE "data"->>'kind' = 'mmg_claim_mismatch' AND "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
      const pageIds = pages.map((p) => `ops_alert_${createHash('sha256').update(`mmg-claim:${p.orderId}:r${p.revision}:admin:${p.userId}`).digest('hex').slice(0, 24)}`);
      await app.prisma.alertDelivery.deleteMany({ where: { id: { in: pageIds } } });
      await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    }
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...riderIds, ...vendorIds] } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    await app.prisma.moneySurfaceCommand.deleteMany({ where: { entityId: { in: vendorIds } } });
    await app.prisma.deliveryCashSettlement.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
    await app.prisma.earning.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
    await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: [...orderIds, ...vendorIds] } }, { userId: { in: ids } }] }, 'GOLD-2 golden journey fixture cleanup (gold-2-mmg)');
    await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    // The market's stock_movements rows stay: that ledger is append-only in
    // the database (migration 20260825000000) and outlives its items by design.
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await purgeRedis([...ids, ...sessionIds, ...vendorIds, ...riderIds, ...orderIds], [...ids, CLIENT_IP]);
  });
}

/** Keys that name this file's ids, plus the velocity counters (which name an
 *  HMAC of the actor, never the id itself). Nothing else is touched. */
async function purgeRedis(ids: string[], velocityActors: string[]) {
  const wanted = new Set([...ids, ...velocityActors.map((a) => hashVelocityId(a))]);
  let cursor = '0';
  do {
    const [next, keys] = await app.redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    const mine = keys.filter((k) => k.split(':').some((part) => wanted.has(part)));
    if (mine.length > 0) await app.redis.del(...mine);
  } while (cursor !== '0');
}

beforeAll(async () => {
  vi.stubEnv('MMG_PAY_URL_ALLOWED_HOSTS', PAY_HOST);
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
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await purgeFixtures();

  customer = await makeUser('Mala', ['CUSTOMER'], 'CUSTOMER');
  stranger = await makeUser('Tess', ['CUSTOMER'], 'CUSTOMER');
  for (const who of [customer, stranger]) {
    await sys(() => app.prisma.address.create({
      data: { userId: who.userId, label: 'Home', addressLine1: '31 MMG Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: HOME.lat, longitude: HOME.lng, isDefault: true },
    }));
  }
  admin = await makeUser('Ama', ['ADMIN'], 'ADMIN', { admin: true });

  dinerOwner = await makeUser('Dev', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const diner = await makeStore(dinerOwner, 'Gold MMG Diner', 'RESTAURANT');
  dinerId = diner.vendorId;
  dinerItemId = (await sys(() => app.prisma.item.create({ data: { vendorId: dinerId, categoryId: diner.categoryId, name: 'MMG Pepperpot', basePrice: 2500, isAvailable: true } }))).id;
  // The diner's link goes live the production way: staged, then applied by
  // the cool-off executor (the cool-off itself is graded on the cafe below).
  await stageLink(dinerOwner, dinerId, DINER_LINK);
  expect((await coolOffPasses(dinerId)).applied).toBe(1);

  marketOwner = await makeUser('Mo', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const shop = await makeStore(marketOwner, 'Gold Market', 'SUPERMARKET');
  marketId = shop.vendorId;
  const stock = (name: string, price: number, group: string | null) => sys(() => app.prisma.item.create({
    data: { vendorId: marketId, categoryId: shop.categoryId, name, basePrice: price, isAvailable: true, stockQuantity: 8, substitutionGroup: group },
  }));
  market.rice = (await stock('Rice 5kg', 1800, 'rice')).id;
  market.riceOther = (await stock('Rice 5kg (other brand)', 1800, 'rice')).id;
  market.riceLarge = (await stock('Rice 10kg', 3000, 'rice')).id;
  market.oil = (await stock('Cooking Oil 1L', 900, null)).id;
  await stageLink(marketOwner, marketId, MARKET_LINK);
  expect((await coolOffPasses(marketId)).applied).toBe(1);
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
  vi.unstubAllEnvs();
});

describe('GOLD-2 · VEND-03 / MONEY-02 — the pay link', () => {
  it('is the owner’s alone, needs a step-up, is staged behind the cool-off, and nothing is payable until the cool-off job applies it', async () => {
    const cafeOwner = await makeUser('Cai', ['VENDOR_OWNER'], 'VENDOR_OWNER');
    const cafe = await makeStore(cafeOwner, 'Gold MMG Cafe', 'RESTAURANT');
    const cafeItem = (await sys(() => app.prisma.item.create({ data: { vendorId: cafe.vendorId, categoryId: cafe.categoryId, name: 'Cafe Roti', basePrice: 1500, isAvailable: true } }))).id;
    const linkState = () => sys(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: cafe.vendorId }, select: { mmgPayUrl: true, mmgPayUrlPending: true, mmgPayUrlApplyAt: true } }));
    const unset = { mmgPayUrl: null, mmgPayUrlPending: null, mmgPayUrlApplyAt: null };

    // Another store's owner and a customer cannot point this store's money
    // anywhere. (The other owner's request is answered for THEIR OWN store —
    // vendor.routes.ts pickVendorId ignores a store header the caller does not
    // hold — so the invariant asserted is that the cafe is untouched.)
    const grillOwner = await makeUser('Gus', ['VENDOR_OWNER'], 'VENDOR_OWNER');
    await makeStore(grillOwner, 'Gold MMG Grill', 'RESTAURANT');
    await grantStepUp(app, grillOwner.token);
    await call('PUT', '/api/v1/vendor/profile', grillOwner.token, { mmgPayUrl: CAFE_LINK }, asStore(cafe.vendorId));
    const aCustomer = await call('PUT', '/api/v1/vendor/profile', customer.token, { mmgPayUrl: CAFE_LINK }, asStore(cafe.vendorId));
    expect(aCustomer.statusCode).toBe(403);
    expect(await linkState()).toEqual(unset);
    expect(await sys(() => app.prisma.moneySurfaceCommand.count({ where: { entityId: cafe.vendorId } }))).toBe(0);
    // The owner, before confirming it is them.
    const cold = await call('PUT', '/api/v1/vendor/profile', cafeOwner.token, { mmgPayUrl: CAFE_LINK }, asStore(cafe.vendorId));
    expect(cold.statusCode).toBe(403);
    expect(cold.json().error.code).toBe('STEP_UP_REQUIRED');
    // A destination that is not an approved public HTTPS pay link.
    await grantStepUp(app, cafeOwner.token);
    for (const unsafe of [`http://${PAY_HOST}/pay/cafe`, 'https://evil.example.net/pay/cafe']) {
      const refused = await call('PUT', '/api/v1/vendor/profile', cafeOwner.token, { mmgPayUrl: unsafe }, asStore(cafe.vendorId));
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe('INVALID_MMG_PAY_URL');
    }
    expect(await linkState()).toEqual(unset);
    expect(await sys(() => app.prisma.moneySurfaceCommand.count({ where: { entityId: cafe.vendorId } }))).toBe(0);

    // Staged: the answer says what is live (nothing) and what is pending.
    const before = Date.now();
    const staged = await call('PUT', '/api/v1/vendor/profile', cafeOwner.token, { mmgPayUrl: CAFE_LINK }, asStore(cafe.vendorId));
    const after = Date.now();
    expect(staged.statusCode, staged.body).toBe(200);
    expect(staged.json().data.mmgPayUrl).toBeNull();
    expect(staged.json().data.mmgPayUrlPending).toBe(CAFE_LINK);
    const pending = await linkState();
    expect(pending.mmgPayUrl).toBeNull();
    expect(pending.mmgPayUrlPending).toBe(CAFE_LINK);
    expect(pending.mmgPayUrlApplyAt!.getTime()).toBeGreaterThanOrEqual(before + DAY);
    expect(pending.mmgPayUrlApplyAt!.getTime()).toBeLessThanOrEqual(after + DAY);
    const commands = await sys(() => app.prisma.moneySurfaceCommand.findMany({ where: { entityId: cafe.vendorId }, select: { kind: true, state: true } }));
    expect(commands).toEqual([{ kind: 'MMG_LINK_STAGE', state: 'DECIDED' }]);
    const told = await sys(() => app.prisma.notification.findMany({ where: { userId: cafeOwner.userId }, select: { title: true, data: true } }));
    expect(told.map((n) => n.title)).toEqual(['Your MMG pay link is changing']);

    // While only staged, nobody can be sent to pay into it.
    const early = await checkoutMmg([{ vendorId: cafe.vendorId, itemId: cafeItem, quantity: 1 }]);
    expect(early.statusCode).toBe(400);
    expect(early.json().error.code).toBe('MMG_NOT_AVAILABLE');
    expect(await sys(() => app.prisma.order.count({ where: { vendorId: cafe.vendorId } }))).toBe(0);

    // The cool-off executor before the cool-off has passed applies nothing.
    await applyDueMmgLinkChanges({ prisma: app.prisma, io: app.io });
    expect(await linkState()).toEqual(pending);

    // The cool-off passes; the executor makes it live and tells the owner.
    expect((await coolOffPasses(cafe.vendorId)).applied).toBe(1);
    expect(await linkState()).toEqual({ mmgPayUrl: CAFE_LINK, mmgPayUrlPending: null, mmgPayUrlApplyAt: null });
    const applied = await sys(() => app.prisma.moneySurfaceCommand.findMany({ where: { entityId: cafe.vendorId }, orderBy: { createdAt: 'asc' }, select: { kind: true, state: true } }));
    expect(applied).toEqual([{ kind: 'MMG_LINK_STAGE', state: 'APPLIED' }, { kind: 'MMG_LINK_APPLY', state: 'APPLIED' }]);
    const toldLive = await sys(() => app.prisma.notification.findMany({ where: { userId: cafeOwner.userId }, orderBy: { createdAt: 'asc' }, select: { title: true } }));
    expect(toldLive.map((n) => n.title)).toEqual(['Your MMG pay link is changing', 'Your new MMG pay link is live']);
    const profile = await call('GET', '/api/v1/vendor/profile', cafeOwner.token, undefined, asStore(cafe.vendorId));
    expect(profile.json().data.vendors.find((v: { id: string }) => v.id === cafe.vendorId)).toMatchObject({ mmgPayUrl: CAFE_LINK, mmgPayUrlPending: null });
  });
});

describe('GOLD-2 · VEND-03 / MONEY-02 / CUST-02 — an MMG order end to end', () => {
  it('opens the store’s own link, records the customer’s claim and the store’s attestation as claims, fulfils, hands over on a fresh screen, and both sides close the delivery pay', async () => {
    const rider = await makeRider('Ravi');
    const otherRider = await makeRider('Otto');
    const ref = newRef();

    const { order, paymentAction } = await dinerOrder();
    // One MMG Pepperpot plus the delivery leg (inside the included distance).
    expect({ total: order.total, deliveryFee: order.deliveryFee }).toEqual({ total: 3000, deliveryFee: 500 });
    expect(paymentAction).toEqual({
      kind: 'OPEN_EXTERNAL_URL', method: 'MOBILE_MONEY', provider: 'MMG', fundsFlow: 'DIRECT_TO_VENDOR',
      orderId: order.id, recipientName: 'Gold MMG Diner', amount: order.total, url: DINER_LINK,
    });
    const placed = await orderRow(order.id);
    expect({ status: placed.status, paymentStatus: placed.paymentStatus, mmgPayUrlSnapshot: placed.mmgPayUrlSnapshot, mmgRecipientNameSnapshot: placed.mmgRecipientNameSnapshot })
      .toEqual({ status: 'PENDING', paymentStatus: 'PENDING', mmgPayUrlSnapshot: DINER_LINK, mmgRecipientNameSnapshot: 'Gold MMG Diner' });

    // Unpaid MMG never moves: not at the store, not on the rider board.
    const acceptUnpaid = await storeStep(order.id, 'accept');
    expect(acceptUnpaid.statusCode).toBe(409);
    expect(acceptUnpaid.json().error.code).toBe('MMG_PAYMENT_PENDING');
    const grabUnpaid = await call('POST', `/api/v1/rider/orders/${order.id}/accept`, rider.token, {});
    expect(grabUnpaid.statusCode).toBe(400);
    expect(grabUnpaid.json().error.code).toBe('INVALID_STATUS');
    expect(await claimFacts(order.id)).toMatchObject({ status: 'PENDING', paymentStatus: 'PENDING' });

    // The customer's word (their device), then strangers who try to speak for this order.
    const claimed = await call('POST', `/api/v1/customer/orders/${order.id}/payment-claim`, customer.token, { paid: true, reference: ref });
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect(claimed.json().data).toMatchObject({ orderId: order.id, paymentStatus: 'PENDING', storeClaimed: false, mismatch: false, replayed: false });
    const notTheirs = await call('POST', `/api/v1/customer/orders/${order.id}/payment-claim`, stranger.token, { paid: false });
    expect(notTheirs.statusCode).toBe(404);
    const otherStore = await attest(order.id, ref, marketOwner, marketId);
    expect(otherStore.statusCode).toBe(404);
    const theRider = await call('POST', `/api/v1/vendor/orders/${order.id}/confirm-payment`, rider.token, { reference: ref }, asStore(dinerId));
    expect(theRider.statusCode).toBe(403);
    const afterClaim = await orderRow(order.id);
    expect({ customerMmgClaim: afterClaim.customerMmgClaim, customerPaymentRef: afterClaim.customerPaymentRef, paymentStatus: afterClaim.paymentStatus, mmgAttestedRef: afterClaim.mmgAttestedRef })
      .toEqual({ customerMmgClaim: 'PAID', customerPaymentRef: ref, paymentStatus: 'PENDING', mmgAttestedRef: null });

    // The store's word, with the wallet's reference: a CLAIM, never a capture.
    const attestedFrom = Date.now();
    const attested = await attest(order.id, ref);
    expect(attested.statusCode, attested.body).toBe(200);
    expect(attested.json().data.paymentStatus).toBe('CLAIMED');
    const claimedRow = await orderRow(order.id);
    expect({ paymentStatus: claimedRow.paymentStatus, mmgAttestedRef: claimedRow.mmgAttestedRef, mmgAttestedById: claimedRow.mmgAttestedById, mismatch: claimedRow.mmgClaimMismatchAt })
      .toEqual({ paymentStatus: 'CLAIMED', mmgAttestedRef: ref, mmgAttestedById: dinerOwner.userId, mismatch: null });
    expect(claimedRow.mmgAttestedAt!.getTime()).toBeGreaterThanOrEqual(attestedFrom - 1000);
    expect(claimedRow.mmgAttestedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const evidence = await sys(() => app.prisma.auditLog.findMany({ where: { entityId: order.id, action: { in: ['ATTEST_MMG_PAYMENT', 'VENDOR_CLAIMED_PAYMENT_RECEIVED'] } }, select: { action: true, userId: true, changes: true } }));
    expect(evidence.map((e) => e.action).sort()).toEqual(['ATTEST_MMG_PAYMENT', 'VENDOR_CLAIMED_PAYMENT_RECEIVED']);
    expect(evidence.find((e) => e.action === 'ATTEST_MMG_PAYMENT')!.changes).toMatchObject({ reference: ref, amount: String(claimedRow.totalAmount), recipient: 'Gold MMG Diner', basis: 'VENDOR_ATTESTED' });
    // A second tap by the store's staff writes nothing new.
    const doubleTap = await attest(order.id, ref);
    expect(doubleTap.statusCode).toBe(200);
    expect(doubleTap.json().data.paymentStatus).toBe('CLAIMED');
    expect(await sys(() => app.prisma.auditLog.count({ where: { entityId: order.id, action: 'ATTEST_MMG_PAYMENT' } }))).toBe(1);

    // Fulfilment, then the rider carries it.
    for (const [step, expected] of [['accept', 'ACCEPTED'], ['preparing', 'PREPARING'], ['ready', 'READY_FOR_PICKUP']] as const) {
      const moved = await storeStep(order.id, step);
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().data.status).toBe(expected);
    }
    const grab = await call('POST', `/api/v1/rider/orders/${order.id}/accept`, rider.token, {});
    expect(grab.statusCode, grab.body).toBe(200);
    for (const step of ['en-route-pickup', 'arrived-pickup', 'picked-up', 'en-route-delivery']) {
      expect((await riderStep(rider, order.id, step)).statusCode).toBe(200);
    }

    // [MKT-F057] Every door call below carries the customer's PIN, so each refusal is its OWN rule.
    const pin = await doorPin(order.id);
    // The rider can never self-attest MMG at the door.
    const cashDoor = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, rider.token, { outcome: 'paid', gps: HOME, ridePin: pin });
    expect(cashDoor.statusCode).toBe(409);
    expect(cashDoor.json().error.code).toBe('CASH_HANDOVER_ONLY');
    expect(await claimFacts(order.id)).toMatchObject({ status: 'EN_ROUTE_DELIVERY', paymentStatus: 'CLAIMED' });

    // The screen rendered on the way goes stale at the door.
    const onTheWay = await activeHandover(rider);
    expect(onTheWay).toMatchObject({ rail: 'MOBILE_MONEY', paymentState: 'CLAIMED', custodyState: 'EN_ROUTE_DELIVERY', permitted: 'DELIVER_NO_CASH', blockReason: null });
    expect((await riderStep(rider, order.id, 'arrived')).statusCode).toBe(200);
    const stale = await call('PUT', `/api/v1/rider/orders/${order.id}/delivered`, rider.token, { handoverVersion: onTheWay.version, ridePin: pin });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('HANDOVER_STALE');
    expect(await claimFacts(order.id)).toMatchObject({ status: 'ARRIVED' });
    const notTheRider = await call('PUT', `/api/v1/rider/orders/${order.id}/delivered`, otherRider.token, { ridePin: pin });
    expect(notTheRider.statusCode).toBe(403);
    expect(notTheRider.json().error.code).toBe('NOT_YOUR_ORDER');
    const fresh = await activeHandover(rider);
    expect(fresh).toMatchObject({ custodyState: 'ARRIVED', permitted: 'DELIVER_NO_CASH' });
    const delivered = await call('PUT', `/api/v1/rider/orders/${order.id}/delivered`, rider.token, { handoverVersion: fresh.version, ridePin: pin });
    expect(delivered.statusCode, delivered.body).toBe(200);
    expect(delivered.json().data).toMatchObject({ orderId: order.id, status: 'DELIVERED', deliveryFee: order.deliveryFee, tip: 0, earning: order.deliveryFee });
    // Swift never turned the store's word into a capture.
    expect(await claimFacts(order.id)).toMatchObject({ status: 'DELIVERED', paymentStatus: 'CLAIMED' });

    // The customer's MMG went to the store, fee included: the store owes the
    // rider the delivery pay, in cash, and both sides must say the same figure.
    const earnings = await sys(() => app.prisma.earning.findMany({ where: { orderId: order.id }, select: { riderId: true, type: true, amount: true } }));
    expect(earnings).toEqual([{ riderId: rider.riderId, type: 'DELIVERY_FEE', amount: new Prisma.Decimal(order.deliveryFee) }]);
    const owed = await sys(() => app.prisma.deliveryCashSettlement.findMany({ where: { orderId: order.id } }));
    expect(owed).toHaveLength(1);
    expect({ riderId: owed[0]!.riderId, vendorId: owed[0]!.vendorId, amount: Number(owed[0]!.amount), status: owed[0]!.status })
      .toEqual({ riderId: rider.riderId, vendorId: dinerId, amount: order.deliveryFee, status: 'OWED' });
    const settlementId = owed[0]!.id;
    const wrongFigure = await call('POST', `/api/v1/rider/cash-settlements/${settlementId}/confirm`, rider.token, { amount: order.deliveryFee + 100 });
    expect(wrongFigure.statusCode).toBe(409);
    expect(wrongFigure.json().error.code).toBe('ATTESTED_AMOUNT_MISMATCH');
    const notTheirSettlement = await call('POST', `/api/v1/rider/cash-settlements/${settlementId}/confirm`, otherRider.token, { amount: order.deliveryFee });
    expect(notTheirSettlement.statusCode).toBe(404);
    expect((await sys(() => app.prisma.deliveryCashSettlement.findUniqueOrThrow({ where: { id: settlementId } }))).status).toBe('OWED');
    const confirmedFrom = Date.now();
    const storeHalf = await call('POST', `/api/v1/vendor/cash-settlements/${settlementId}/confirm`, dinerOwner.token, { amount: order.deliveryFee }, asStore(dinerId));
    expect(storeHalf.statusCode, storeHalf.body).toBe(200);
    expect(storeHalf.json().data.status).toBe('STORE_CONFIRMED');
    const riderHalf = await call('POST', `/api/v1/rider/cash-settlements/${settlementId}/confirm`, rider.token, { amount: order.deliveryFee });
    expect(riderHalf.statusCode, riderHalf.body).toBe(200);
    expect(riderHalf.json().data.status).toBe('SETTLED');
    const settled = await sys(() => app.prisma.deliveryCashSettlement.findUniqueOrThrow({ where: { id: settlementId } }));
    expect({ status: settled.status, store: Number(settled.storeAttestedAmount), rider: Number(settled.riderAttestedAmount) })
      .toEqual({ status: 'SETTLED', store: order.deliveryFee, rider: order.deliveryFee });
    for (const at of [settled.storeConfirmedAt, settled.riderConfirmedAt]) {
      expect(at!.getTime()).toBeGreaterThanOrEqual(confirmedFrom - 1000);
      expect(at!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });
});

describe('GOLD-2 · VEND-03 / MONEY-02 — duplicates and mismatches', () => {
  it('one wallet reference settles one order; its own reference settles the second', async () => {
    const shared = newRef();
    const first = (await dinerOrder()).order;
    const second = (await dinerOrder(2)).order;

    const ok = await attest(first.id, shared);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data.paymentStatus).toBe('CLAIMED');

    const clash = await attest(second.id, shared);
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('REFERENCE_ALREADY_USED');
    const untouched = await orderRow(second.id);
    expect({ paymentStatus: untouched.paymentStatus, mmgAttestedRef: untouched.mmgAttestedRef, mmgClaimRevision: untouched.mmgClaimRevision })
      .toEqual({ paymentStatus: 'PENDING', mmgAttestedRef: null, mmgClaimRevision: 0 });
    expect(await sys(() => app.prisma.auditLog.count({ where: { entityId: second.id, action: 'ATTEST_MMG_PAYMENT' } }))).toBe(0);

    const own = await attest(second.id, newRef());
    expect(own.statusCode).toBe(200);
    expect(own.json().data.paymentStatus).toBe('CLAIMED');
    expect((await orderRow(first.id)).mmgAttestedRef).toBe(shared);
  });

  it('a customer and a store naming different references is a disagreement: it latches and holds the order', async () => {
    const { order } = await dinerOrder();
    const customerSays = newRef();
    const storeSays = newRef();
    expect((await call('POST', `/api/v1/customer/orders/${order.id}/payment-claim`, customer.token, { paid: true, reference: customerSays })).statusCode).toBe(200);
    const attested = await attest(order.id, storeSays);
    expect(attested.statusCode, attested.body).toBe(200);
    expect(await claimFacts(order.id)).toMatchObject({ status: 'PENDING', paymentStatus: 'CLAIMED', mismatch: true });
    const held = await storeStep(order.id, 'accept');
    expect(held.statusCode).toBe(409);
    expect(held.json().error.code).toBe('MMG_CLAIM_MISMATCH');
    // Neither party can clear it by repeating themselves.
    expect((await call('POST', `/api/v1/customer/orders/${order.id}/payment-claim`, customer.token, { paid: true, reference: storeSays })).statusCode).toBe(200);
    expect(await claimFacts(order.id)).toMatchObject({ status: 'PENDING', mismatch: true });
    expect((await storeStep(order.id, 'accept')).statusCode).toBe(409);
  });
});

describe('GOLD-2 · VEND-03 / CUST-02 — a disputed payment holds the order until a person decides', () => {
  it('a denial after pickup stops the door; the operator’s decision on the current evidence releases it', async () => {
    const rider = await makeRider('Dina');
    const { order } = await dinerOrder();
    expect((await attest(order.id, newRef())).statusCode).toBe(200);
    for (const step of ['accept', 'preparing', 'ready'] as const) expect((await storeStep(order.id, step)).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/rider/orders/${order.id}/accept`, rider.token, {})).statusCode).toBe(200);
    for (const step of ['en-route-pickup', 'arrived-pickup', 'picked-up', 'en-route-delivery']) {
      expect((await riderStep(rider, order.id, step)).statusCode).toBe(200);
    }

    const denied = await call('POST', `/api/v1/customer/orders/${order.id}/payment-claim`, customer.token, { paid: false });
    expect(denied.statusCode, denied.body).toBe(200);
    expect(denied.json().data).toMatchObject({ paymentStatus: 'CLAIMED', storeClaimed: true, mismatch: true });
    const disputed = await claimFacts(order.id);
    expect(disputed).toMatchObject({ status: 'EN_ROUTE_DELIVERY', paymentStatus: 'CLAIMED', mismatch: true, resolution: null });
    // A person is asked to decide: the platform's admins are paged, once.
    const paged = await sys(() => app.prisma.notification.findMany({ where: { userId: admin.userId, data: { path: ['orderId'], equals: order.id } }, select: { data: true } }));
    expect(paged.map((n) => (n.data as { kind?: string }).kind)).toEqual(['mmg_claim_mismatch']);

    // The door is shut: the rider cannot arrive, the screen says why, delivery is refused.
    const arrive = await riderStep(rider, order.id, 'arrived');
    expect(arrive.statusCode).toBe(409);
    expect(arrive.json().error.code).toBe('MMG_CLAIM_MISMATCH');
    expect(await activeHandover(rider)).toMatchObject({ permitted: 'BLOCKED', blockReason: 'MMG_CLAIM_MISMATCH' });
    // Even with the customer's PIN the door stays shut: the hold is the rule here.
    const pin = await doorPin(order.id);
    const deliver = await call('PUT', `/api/v1/rider/orders/${order.id}/delivered`, rider.token, { ridePin: pin });
    expect(deliver.statusCode).toBe(409);
    expect(deliver.json().error.code).toBe('MMG_CLAIM_MISMATCH');
    expect(await claimFacts(order.id)).toEqual(disputed);

    // Only an operator decides, on the evidence they reviewed.
    const byTheStore = await resolveClaim(order.id, dinerOwner.token, { resolution: 'CUSTOMER_PAID', note: 'Store says it is fine', expectedClaimRevision: disputed.revision });
    expect(byTheStore.statusCode).toBe(403);
    const stale = await resolveClaim(order.id, admin.token, { resolution: 'CUSTOMER_PAID', note: 'Checked the wallet message', expectedClaimRevision: disputed.revision - 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('MMG_CLAIM_STALE');
    const afterCustody = await resolveClaim(order.id, admin.token, { resolution: 'CUSTOMER_DID_NOT_PAY', note: 'No payment in the wallet statement', expectedClaimRevision: disputed.revision });
    expect(afterCustody.statusCode).toBe(409);
    expect(afterCustody.json().error.code).toBe('MMG_RECOVERY_REQUIRED');
    expect(await claimFacts(order.id)).toEqual(disputed);

    const upheld = await resolveClaim(order.id, admin.token, { resolution: 'CUSTOMER_PAID', note: 'Wallet statement shows the transfer', expectedClaimRevision: disputed.revision });
    expect(upheld.statusCode, upheld.body).toBe(200);
    expect(upheld.json().data).toMatchObject({ orderId: order.id, paymentStatus: 'CLAIMED', mismatch: false, resolution: 'CUSTOMER_PAID', replayed: false });
    const replay = await resolveClaim(order.id, admin.token, { resolution: 'CUSTOMER_PAID', note: 'Wallet statement shows the transfer', expectedClaimRevision: disputed.revision });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.replayed).toBe(true);
    expect(await claimFacts(order.id)).toEqual({ status: 'EN_ROUTE_DELIVERY', paymentStatus: 'CLAIMED', mismatch: false, revision: disputed.revision + 1, resolution: 'CUSTOMER_PAID' });

    // Released: the door opens.
    expect((await riderStep(rider, order.id, 'arrived')).statusCode).toBe(200);
    const open = await activeHandover(rider);
    expect(open).toMatchObject({ permitted: 'DELIVER_NO_CASH', blockReason: null });
    const delivered = await call('PUT', `/api/v1/rider/orders/${order.id}/delivered`, rider.token, { handoverVersion: open.version, ridePin: pin });
    expect(delivered.statusCode, delivered.body).toBe(200);
    expect(await claimFacts(order.id)).toMatchObject({ status: 'DELIVERED', paymentStatus: 'CLAIMED' });
  });

  it('a denial before the store accepts holds acceptance; "did not pay" reopens the payment, the rejected reference cannot be reused, and the customer can walk away', async () => {
    const { order } = await dinerOrder();
    const storeRef = newRef();
    expect((await attest(order.id, storeRef)).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/customer/orders/${order.id}/payment-claim`, customer.token, { paid: false })).statusCode).toBe(200);
    const disputed = await claimFacts(order.id);
    expect(disputed).toMatchObject({ status: 'PENDING', paymentStatus: 'CLAIMED', mismatch: true });

    const accept = await storeStep(order.id, 'accept');
    expect(accept.statusCode).toBe(409);
    expect(accept.json().error.code).toBe('MMG_CLAIM_MISMATCH');
    // The store's claim stands until decided, so the customer cannot cancel around it.
    const cancelHeld = await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, { reason: 'Store says I paid, I did not' });
    expect(cancelHeld.statusCode).toBe(409);
    expect(cancelHeld.json().error.code).toBe('MMG_CANCEL_UNAVAILABLE');

    const rejected = await resolveClaim(order.id, admin.token, { resolution: 'CUSTOMER_DID_NOT_PAY', note: 'No matching transfer in the wallet statement', expectedClaimRevision: disputed.revision });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await claimFacts(order.id)).toEqual({ status: 'PENDING', paymentStatus: 'PENDING', mismatch: false, revision: disputed.revision + 1, resolution: 'CUSTOMER_DID_NOT_PAY' });
    // The rejected claim cannot be revived by the store tapping again.
    const revive = await attest(order.id, storeRef);
    expect(revive.statusCode).toBe(409);
    expect(revive.json().error.code).toBe('MMG_ATTEMPT_REJECTED');
    expect((await storeStep(order.id, 'accept')).statusCode).toBe(409);
    // Nothing was paid, so the customer may walk away.
    const cancel = await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, customer.token, { reason: 'Never paid; ordering elsewhere' });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(await claimFacts(order.id)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PENDING' });
  });
});

describe('GOLD-2 · MONEY-02 — expiry and recovery', () => {
  it('an unpaid order the store never answers expires with honest notices; an attested one does not; the customer’s next order goes through', async () => {
    const jobs = { prisma: app.prisma, io: app.io, redis: app.redis, log: app.log };
    const unpaid = (await dinerOrder()).order;
    const attested = (await dinerOrder()).order;
    expect((await attest(attested.id, newRef())).statusCode).toBe(200);

    // The order worker's no-response expiry reaches both.
    expect(await autoCancelUnresponsiveOrder(jobs, unpaid.id)).toBe(true);
    expect(await autoCancelUnresponsiveOrder(jobs, attested.id)).toBe(false);

    const expired = await orderRow(unpaid.id);
    expect({ status: expired.status, paymentStatus: expired.paymentStatus, cancelledBy: expired.cancelledBy, reason: expired.cancellationReason })
      .toEqual({ status: 'CANCELLED', paymentStatus: 'PENDING', cancelledBy: null, reason: 'Auto-cancelled: vendor did not respond' });
    const toCustomer = await sys(() => app.prisma.notification.findMany({ where: { userId: customer.userId, data: { path: ['orderId'], equals: unpaid.id }, title: 'Order cancelled — no response' }, select: { body: true } }));
    // Honest for MMG: never "you were not charged" — the store may hold the money.
    expect(toCustomer).toEqual([{ body: `We're sorry — the store didn't respond to order ${expired.orderNumber} in time, so it was cancelled. If you already sent the MMG payment, the store refunds you directly; please try another store.` }]);
    const toStore = await sys(() => app.prisma.notification.findMany({ where: { userId: dinerOwner.userId, data: { path: ['orderId'], equals: unpaid.id } }, select: { body: true } }));
    const refundNotice = `Order ${expired.orderNumber} was auto-cancelled (no response) before its MMG payment was confirmed. If the customer's transfer arrived in your MMG, refund them directly.`;
    expect(toStore.filter((n) => n.body === refundNotice)).toHaveLength(1);
    // The store confirmed the money landed: no silent cancellation of paid goods.
    expect(await claimFacts(attested.id)).toMatchObject({ status: 'PENDING', paymentStatus: 'CLAIMED' });
    expect(await sys(() => app.prisma.notification.count({ where: { userId: customer.userId, data: { path: ['orderId'], equals: attested.id }, title: 'Order cancelled — no response' } }))).toBe(0);
    // A late attestation cannot resurrect the expired order as paid.
    const late = await attest(unpaid.id, newRef());
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('ORDER_CLOSED');

    // Recovery: the store picks the attested order back up, and the customer's next order goes through.
    expect((await storeStep(attested.id, 'accept')).statusCode).toBe(200);
    const next = await dinerOrder();
    expect(next.paymentAction).toMatchObject({ kind: 'OPEN_EXTERNAL_URL', url: DINER_LINK, orderId: next.order.id });
  });
});

describe('GOLD-2 · VEND-03 — grocery substitution on an MMG order', () => {
  /** A picked MMG grocery bag: 2 × Rice (to be swapped) + 1 × Oil (picked). */
  async function marketBag() {
    const res = await checkoutMmg([{ vendorId: marketId, itemId: market.rice, quantity: 2 }, { vendorId: marketId, itemId: market.oil, quantity: 1 }]);
    expect(res.statusCode, res.body).toBe(200);
    const orderId = res.json().data.order.id as string;
    expect((await attest(orderId, newRef(), marketOwner, marketId)).statusCode).toBe(200);
    expect((await storeStep(orderId, 'accept', marketOwner, marketId)).statusCode).toBe(200);
    expect((await storeStep(orderId, 'preparing', marketOwner, marketId)).statusCode).toBe(200);
    const lines = await sys(() => app.prisma.orderItem.findMany({ where: { orderId } }));
    const riceLine = lines.find((l) => l.itemId === market.rice)!;
    const oilLine = lines.find((l) => l.itemId === market.oil)!;
    const picked = await call('PUT', `/api/v1/vendor/orders/${orderId}/items/${oilLine.id}/picked`, marketOwner.token, { picked: true }, asStore(marketId));
    expect(picked.statusCode, picked.body).toBe(200);
    return { orderId, riceLineId: riceLine.id };
  }
  /** Quantity on the shelf; these items are all stock-tracked. */
  const shelf = async (id: string): Promise<number> => {
    const { stockQuantity } = await sys(() => app.prisma.item.findUniqueOrThrow({ where: { id }, select: { stockQuantity: true } }));
    expect(stockQuantity).not.toBeNull();
    return stockQuantity!;
  };

  it('a same-price swap proceeds: totals untouched, each shelf moved once, and the bag closes', async () => {
    const [riceBefore, otherBefore] = [await shelf(market.rice), await shelf(market.riceOther)];
    const { orderId, riceLineId } = await marketBag();
    const before = await orderRow(orderId);
    expect(await shelf(market.rice)).toBe(riceBefore - 2);

    // The bag cannot close with an open question in it.
    const openQuestion = await storeStep(orderId, 'ready', marketOwner, marketId);
    expect(openQuestion.statusCode).toBe(409);
    expect(openQuestion.json().error.code).toBe('PICKING_INCOMPLETE');
    const proposed = await call('POST', `/api/v1/vendor/orders/${orderId}/items/${riceLineId}/substitute`, marketOwner.token, { substituteItemId: market.riceOther }, asStore(marketId));
    expect(proposed.statusCode, proposed.body).toBe(200);
    expect(proposed.json().data.subStatus).toBe('PENDING');
    const notTheirs = await call('POST', `/api/v1/customer/orders/${orderId}/items/${riceLineId}/substitution`, stranger.token, { approve: true });
    expect(notTheirs.statusCode).toBe(404);
    const approved = await call('POST', `/api/v1/customer/orders/${orderId}/items/${riceLineId}/substitution`, customer.token, { approve: true });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().data.subStatus).toBe('APPROVED');

    const after = await orderRow(orderId);
    expect([Number(after.subtotalCustomer), Number(after.totalAmount)]).toEqual([Number(before.subtotalCustomer), Number(before.totalAmount)]);
    expect(await shelf(market.rice)).toBe(riceBefore); // the original went back on the shelf
    expect(await shelf(market.riceOther)).toBe(otherBefore - 2); // the substitute came off it
    const picked = await call('PUT', `/api/v1/vendor/orders/${orderId}/items/${riceLineId}/picked`, marketOwner.token, { picked: true }, asStore(marketId));
    expect(picked.statusCode, picked.body).toBe(200);
    const ready = await storeStep(orderId, 'ready', marketOwner, marketId);
    expect(ready.statusCode, ready.body).toBe(200);
    expect(ready.json().data.status).toBe('READY_FOR_PICKUP');
  });

  // -------------------------------------------------------------------------
  // E02 (S1, UNASSIGNED): on an MMG order every price-changing picking step
  // is hard-blocked (picking.service.ts:18-25, assertMmgMoneyAdjustable): the
  // store may PROPOSE a dearer substitute, but the customer's approval, the
  // customer's rejection AND the store's own line refund all answer 409
  // MMG_ADJUSTMENT_UNAVAILABLE, so the line stays PENDING and the bag can
  // never be marked ready — stock-out handling leaves the app. This pins the
  // minimal in-app resolution any fix must allow: the customer rejects the
  // substitute, the line comes off with its amount recorded against the
  // order, and the bag closes. The bag and the proposal are set up in
  // beforeAll, so the it.fails can only "pass" on the resolution itself.
  // Flip to `it(...)` when the MMG adjustment/refund obligation lands.
  // -------------------------------------------------------------------------
  describe('[E02] a stock-out on an MMG order', () => {
    let orderId: string;
    let riceLineId: string;
    let lineTotal: number;
    let totalBefore: number;

    beforeAll(async () => {
      ({ orderId, riceLineId } = await marketBag());
      const proposed = await call('POST', `/api/v1/vendor/orders/${orderId}/items/${riceLineId}/substitute`, marketOwner.token, { substituteItemId: market.riceLarge }, asStore(marketId));
      expect(proposed.statusCode, proposed.body).toBe(200);
      expect(proposed.json().data.subStatus).toBe('PENDING');
      lineTotal = Number((await sys(() => app.prisma.orderItem.findUniqueOrThrow({ where: { id: riceLineId } }))).totalCustomer);
      expect(lineTotal).toBe(3600);
      totalBefore = Number((await orderRow(orderId)).totalAmount);
    });

    it.fails('[E02] is resolved in the app: the customer rejects the dearer substitute, the line comes off, and the bag closes', async () => {
      const reject = await call('POST', `/api/v1/customer/orders/${orderId}/items/${riceLineId}/substitution`, customer.token, { approve: false });
      expect(reject.statusCode).toBe(200);
      expect(reject.json().data.subStatus).toBe('REJECTED');
      expect(Number((await orderRow(orderId)).totalAmount)).toBe(totalBefore - lineTotal);
      const ready = await storeStep(orderId, 'ready', marketOwner, marketId);
      expect(ready.statusCode).toBe(200);
    });
  });
});

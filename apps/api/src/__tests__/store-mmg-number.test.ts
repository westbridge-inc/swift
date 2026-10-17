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
import { riderRoutes } from '../modules/rider/rider.routes';
import { DispatchService, makeDispatchService, stuckDispatchEligibleWhere } from '../modules/dispatch/dispatch.service';
import { applyDueMmgLinkChanges } from '../modules/integrity/money-surface';
import { hashVelocityId } from '../modules/integrity/velocity';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { grantStepUp } from './helpers/step-up';

// ---------------------------------------------------------------------------
// [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] MMG to the STORE'S NUMBER.
//
// The store enters its MMG number once (owner only, a +592 mobile), with every
// protection the old pay link had (ALG-34: step-up, a cool-off with the old
// number still live, the owner told, "this wasn't me" signs other devices out).
// The customer chooses MMG; the store ACCEPTS; only then does THAT customer's
// order show "Pay $X by MMG to <store>'s MMG number <number>" (the exact order
// total). The store taps "Paid by MMG" when it sees the money; nothing is
// prepared or dispatched before that (COORD ruling Q1), and until then the
// customer may still cancel in the app (Q2). Builds 9-11 know only the pay link:
// with STORE_MMG_PAY_LINK off they see cash only, and an old-shape MMG checkout
// is refused with an MMG_* code they already turn into "back to cash".
// The production composition (tenant context per request, the empty-JSON
// parser, the vendor-header scope), the real customer and vendor routes.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+5920333';
const FIXTURE = 'paysimp-store-number-fixture';
const CLIENT_IP = '10.20.33.3';
const PAY_HOST = 'pay.example.com';
const NUMBER = '+5926001234';
const NEXT = '+5926009876';
const DAY = 24 * 60 * 60 * 1000;
const HOME = { lat: 6.8045, lng: -58.1553 };
const STORE = { lat: 6.8013, lng: -58.1551 };

let app: FastifyInstance;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };
let customer: Actor;
let stranger: Actor;
let owner: Actor;
let manager: Actor;
let staff: Actor;
let otherOwner: Actor;
let otherVendorId: string;
let rider: Actor & { riderId: string };
let vendorId: string;
let itemId: string;

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName, lastName: `Num${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `psn-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
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
const vendorRow = () => sys(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } }));
const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));

/** Time passes the cool-off (its one aging input), then the executor runs. */
async function coolOffPasses() {
  await sys(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgNumberApplyAt: new Date(Date.now() - 1000) } }));
  return sys(() => applyDueMmgLinkChanges({ prisma: app.prisma, io: app.io }));
}

async function fillCart(who: Actor = customer) {
  expect((await call('DELETE', '/api/v1/customer/cart', who.token)).statusCode).toBe(200);
  const added = await call('POST', '/api/v1/customer/cart/items', who.token, { vendorId, itemId, quantity: 1 });
  expect(added.statusCode, added.body).toBe(201);
}
function checkout(who: Actor, body: Record<string, unknown>) {
  return call('POST', '/api/v1/customer/checkout', who.token, body, { 'idempotency-key': `psn-${nanoid(10)}` });
}
async function numberOrder(who: Actor = customer) {
  await fillCart(who);
  const res = await checkout(who, { paymentMethod: 'MOBILE_MONEY', mmgPayTo: 'STORE_NUMBER' });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as { order: { id: string; total: number }; paymentAction: unknown };
}
const accept = (orderId: string) => call('PUT', `/api/v1/vendor/orders/${orderId}/accept`, owner.token, undefined, store());
const preparing = (orderId: string) => call('PUT', `/api/v1/vendor/orders/${orderId}/preparing`, owner.token, undefined, store());
const paidByMmg = (orderId: string) => call('POST', `/api/v1/vendor/orders/${orderId}/confirm-payment`, owner.token, { reference: `MP${nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, '7')}` }, store());
const orderView = (orderId: string, who: Actor = customer) => call('GET', `/api/v1/customer/orders/${orderId}`, who.token);

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
    await app.prisma.moneySurfaceCommand.deleteMany({ where: { entityId: { in: vendorIds } } });
    await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: [...orderIds, ...vendorIds] } }, { userId: { in: ids } }] }, 'PAYMENT-SIMPLIFY store-number fixture cleanup');
    await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    const riderIds = (await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((r) => r.id);
    await app.prisma.deliveryCashSettlement.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
    await app.prisma.earning.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
    await app.prisma.vendorStaff.deleteMany({ where: { OR: [{ vendorId: { in: vendorIds } }, { userId: { in: ids } }] } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
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
  vi.stubEnv('MMG_PAY_URL_ALLOWED_HOSTS', PAY_HOST);
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
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();
  await purgeFixtures();

  customer = await makeUser('Mala', ['CUSTOMER'], 'CUSTOMER');
  stranger = await makeUser('Tess', ['CUSTOMER'], 'CUSTOMER');
  for (const who of [customer, stranger]) {
    await sys(() => app.prisma.address.create({
      data: { userId: who.userId, label: 'Home', addressLine1: '7 Number Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: HOME.lat, longitude: HOME.lng, isDefault: true },
    }));
  }
  owner = await makeUser('Dev', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  manager = await makeUser('Mia', ['CUSTOMER'], 'CUSTOMER');
  const ownerRow = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const vendor = await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name: 'Number Diner', slug: `psn-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}900`, addressLine1: 'Diner Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 50,
      // A stored, otherwise valid pay link: dormant while STORE_MMG_PAY_LINK is off.
      mmgPayUrl: `https://${PAY_HOST}/pay/psn-diner`,
    },
  }));
  vendorId = vendor.id;
  const category = await sys(() => app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } }));
  itemId = (await sys(() => app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Pepperpot', basePrice: 2500, isAvailable: true } }))).id;
  await sys(() => app.prisma.vendorStaff.create({ data: { vendorId, userId: manager.userId, role: 'MANAGER', invitedBy: owner.userId } }));
  staff = await makeUser('Sam', ['CUSTOMER'], 'CUSTOMER');
  await sys(() => app.prisma.vendorStaff.create({ data: { vendorId, userId: staff.userId, role: 'STAFF', invitedBy: owner.userId } }));
  otherOwner = await makeUser('Oz', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const otherOwnerRow = await sys(() => app.prisma.vendorOwner.create({ data: { userId: otherOwner.userId } }));
  otherVendorId = (await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: otherOwnerRow.id, name: 'Other Shop', slug: `psn-o-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}901`, addressLine1: 'Other Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 50,
    },
  }))).id;
  const riderActor = await makeUser('Rae', ['RIDER', 'CUSTOMER'], 'RIDER');
  const riderRow = await sys(() => app.prisma.rider.create({
    data: {
      userId: riderActor.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE', documentsVerified: true,
      isOnline: true, isAvailable: true, currentLat: STORE.lat, currentLng: STORE.lng, lastLocationUpdate: new Date(),
      locationSessionId: riderActor.sessionId, floatLimit: 100_000,
    },
  }));
  rider = { ...riderActor, riderId: riderRow.id };
});

afterAll(async () => {
  try { await purgeFixtures(); } finally { await app.close(); vi.unstubAllEnvs(); }
});

describe('[PAYMENT-SIMPLIFY · ALG-34 parity] the store MMG number', () => {
  it('owner only, step-up first, a mobile only; a new number is STAGED, goes live after the cool-off, and the owner is told', async () => {
    const byManager = await call('PUT', '/api/v1/vendor/profile', manager.token, { mmgNumber: NUMBER }, store());
    expect(byManager.statusCode, byManager.body).toBe(403);

    const cold = await call('PUT', '/api/v1/vendor/profile', owner.token, { mmgNumber: NUMBER }, store());
    expect(cold.statusCode).toBe(403);
    expect(cold.json().error.code).toBe('STEP_UP_REQUIRED');

    await grantStepUp(app, owner.token);
    const landline = await call('PUT', '/api/v1/vendor/profile', owner.token, { mmgNumber: '+592 225 1234' }, store());
    expect(landline.statusCode).toBe(400);
    expect(landline.json().error.code).toBe('INVALID_MMG_NUMBER');

    const staged = await call('PUT', '/api/v1/vendor/profile', owner.token, { mmgNumber: '600 1234' }, store());
    expect(staged.statusCode, staged.body).toBe(200);
    expect(staged.json().data.mmgNumber).toBeNull(); // not live yet
    expect(staged.json().data.mmgNumberPending).toBe(NUMBER);
    expect((await vendorRow()).mmgNumber).toBeNull();
    const stage = await sys(() => app.prisma.moneySurfaceCommand.findFirstOrThrow({ where: { entityId: vendorId, kind: 'MMG_NUMBER_STAGE' } }));
    expect(stage.state).toBe('DECIDED');
    expect(stage.stepUpSessionId).toBe(owner.sessionId);
    const told = await sys(() => app.prisma.notification.findMany({ where: { userId: owner.userId } }));
    expect(told.some((n) => (n.data as { kind?: string } | null)?.kind === 'mmg_number_change_staged')).toBe(true);

    expect((await coolOffPasses()).applied).toBe(1);
    expect((await vendorRow()).mmgNumber).toBe(NUMBER);
    expect(await sys(() => app.prisma.moneySurfaceCommand.count({ where: { entityId: vendorId, kind: 'MMG_NUMBER_APPLY', state: 'APPLIED' } }))).toBe(1);
    const profile = await call('GET', '/api/v1/vendor/profile', owner.token, undefined, store());
    const mine = profile.json().data.vendors.find((v: { id: string }) => v.id === vendorId);
    expect(mine.mmgNumber).toBe(NUMBER);
    expect(mine.mmgNumberPending).toBeNull();
  });

  it('"this wasn\'t me" drops a staged number, keeps the live one, and signs out the other devices', async () => {
    const other = await sys(() => app.prisma.session.create({
      data: { userId: owner.userId, token: `psn-other-${nanoid(8)}`, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'psn-other', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
    }));
    await grantStepUp(app, owner.token);
    expect((await call('PUT', '/api/v1/vendor/profile', owner.token, { mmgNumber: NEXT }, store())).statusCode).toBe(200);
    expect((await vendorRow()).mmgNumberPending).toBe(NEXT);

    const byManager = await call('DELETE', '/api/v1/vendor/profile/mmg-number/pending', manager.token, undefined, store());
    expect(byManager.statusCode).toBe(403);
    const cancelled = await call('DELETE', '/api/v1/vendor/profile/mmg-number/pending', owner.token, undefined, store());
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().data.cancelled).toBe(true);
    const row = await vendorRow();
    expect([row.mmgNumber, row.mmgNumberPending, row.mmgNumberApplyAt]).toEqual([NUMBER, null, null]);
    expect(await sys(() => app.prisma.session.findUnique({ where: { id: other.id } }))).toBeNull();
    expect(await sys(() => app.prisma.session.findUnique({ where: { id: owner.sessionId } }))).not.toBeNull();
  });

  it('the old pay link is replaced: a new link is refused before step-up, and the profile does not show the stored one', async () => {
    const refused = await call('PUT', '/api/v1/vendor/profile', owner.token, { mmgPayUrl: `https://${PAY_HOST}/pay/psn-new` }, store());
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('MMG_PAY_LINK_OFF');
    expect(refused.json().error.message).toMatch(/MMG number instead of a pay link/);
    const profile = await call('GET', '/api/v1/vendor/profile', owner.token, undefined, store());
    const mine = profile.json().data.vendors.find((v: { id: string }) => v.id === vendorId);
    expect(mine.mmgPayLinkEnabled).toBe(false);
    expect(mine.mmgPayUrl).toBeNull();
    expect((await vendorRow()).mmgPayUrl).toBe(`https://${PAY_HOST}/pay/psn-diner`); // dormant, not deleted
  });
});

describe('[PAYMENT-SIMPLIFY] the customer pays the store\'s number, after the store accepts', () => {
  it('the cart offers MMG to the number (never the number itself); the old link rail is off, so builds 9-11 see cash only', async () => {
    await fillCart();
    const cart = await call('GET', '/api/v1/customer/cart', customer.token);
    expect(cart.statusCode, cart.body).toBe(200);
    const caps = cart.json().data.paymentCapabilities;
    expect(caps.mmg.available).toBe(false);
    expect(caps.mmg.unavailableReason).toBe('PAY_LINKS_OFF');
    expect(caps.mmgStoreNumber).toMatchObject({ available: true, payTo: 'STORE_NUMBER', shownWhen: 'STORE_ACCEPTS', unavailableReason: null });
    expect(JSON.stringify(cart.json())).not.toContain('6001234');
  });

  it('an app that asks for MMG the old (link) way is refused with an MMG_* code, and nothing is written', async () => {
    await fillCart();
    const before = await sys(() => app.prisma.order.count({ where: { customerId: customer.userId } }));
    const res = await checkout(customer, { paymentMethod: 'MOBILE_MONEY' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MMG_UPDATE_APP');
    expect(res.json().error.message).toBe('Paying by MMG needs the latest Swift app. Update Swift to pay by MMG, or choose cash.');
    expect(await sys(() => app.prisma.order.count({ where: { customerId: customer.userId } }))).toBe(before);
  });

  it('checkout commits the number; the store accepts unpaid; ONLY its customer then sees the number and the exact total; nothing moves until "Paid by MMG"', async () => {
    const placed = await numberOrder();
    expect(placed.paymentAction).toBeNull(); // no link to open: Swift sends the customer nowhere
    const committed = await orderRow(placed.order.id);
    expect([committed.paymentMethod, committed.paymentStatus, committed.mmgNumberSnapshot, committed.mmgPayUrlSnapshot]).toEqual(['MOBILE_MONEY', 'PENDING', NUMBER, null]);

    // Before acceptance: no number.
    expect((await orderView(placed.order.id)).json().data.mmgPayment).toBeNull();

    // The store accepts an unpaid MMG order [Q1].
    const accepted = await accept(placed.order.id);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await orderRow(placed.order.id)).status).toBe('ACCEPTED');

    // The store changes its number later: the order keeps the number it committed to.
    await sys(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgNumber: NEXT } }));
    const view = (await orderView(placed.order.id)).json().data;
    expect(view.mmgPayment).toMatchObject({
      payTo: 'STORE_NUMBER', recipientName: 'Number Diner', number: NUMBER, numberDisplay: '+592 600 1234',
      amount: Number(committed.totalAmount),
    });
    expect(view.mmgPayment.instruction).toMatch(/^Pay .+ by MMG to Number Diner's MMG number \+592 600 1234\.$/);
    expect(view.paymentAction).toBeNull();
    await sys(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgNumber: NUMBER } }));

    // Another customer cannot read it at all.
    expect((await orderView(placed.order.id, stranger)).statusCode).toBe(404);

    // Nothing is prepared before the store says the money arrived.
    const early = await preparing(placed.order.id);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('MMG_PAYMENT_PENDING');

    const paid = await paidByMmg(placed.order.id);
    expect(paid.statusCode, paid.body).toBe(200);
    expect((await orderView(placed.order.id)).json().data.mmgPayment).toBeNull(); // paid: the number goes away
    expect((await preparing(placed.order.id)).statusCode).toBe(200);
  });

  it('[Q2] the customer can cancel an accepted MMG order until the store marks it "Paid by MMG", and not after', async () => {
    const open = await numberOrder();
    expect((await accept(open.order.id)).statusCode).toBe(200);
    const preview = (await orderView(open.order.id)).json().data;
    expect(preview.canCancel).toBe(true);
    const cancelled = await call('POST', `/api/v1/customer/orders/${open.order.id}/cancel`, customer.token, {});
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await orderRow(open.order.id)).status).toBe('CANCELLED');
    // A cancelled order never shows the number again.
    expect((await orderView(open.order.id)).json().data.mmgPayment).toBeNull();

    const paidOrder = await numberOrder();
    expect((await accept(paidOrder.order.id)).statusCode).toBe(200);
    expect((await paidByMmg(paidOrder.order.id)).statusCode).toBe(200);
    expect((await orderView(paidOrder.order.id)).json().data.canCancel).toBe(false);
    const refused = await call('POST', `/api/v1/customer/orders/${paidOrder.order.id}/cancel`, customer.token, {});
    expect(refused.statusCode).toBe(409);
    expect((await orderRow(paidOrder.order.id)).status).toBe('ACCEPTED');
  });

  it('a store without a number is not offered, and a number checkout is refused', async () => {
    await sys(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgNumber: '+5922251234' } })); // a landline row: re-checked on read
    await fillCart();
    const caps = (await call('GET', '/api/v1/customer/cart', customer.token)).json().data.paymentCapabilities;
    expect(caps.mmgStoreNumber).toMatchObject({ available: false, unavailableReason: 'VENDOR_NOT_CONFIGURED' });
    const res = await checkout(customer, { paymentMethod: 'MOBILE_MONEY', mmgPayTo: 'STORE_NUMBER' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MMG_NOT_AVAILABLE');
    await sys(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgNumber: NUMBER } }));
  });
});

// ---------------------------------------------------------------------------
// [COORD security ask · SPS-F-0016 / LB-015] ONLY the ACCEPTED transition is
// un-gated. Every other step that moves goods, a rider or money still refuses
// an MMG order until the store's "Paid by MMG", and acceptance itself creates
// no money record, no rider float, no dispatch and no earning.
// ---------------------------------------------------------------------------
describe('[PAYMENT-SIMPLIFY · Q1 boundary] accepting an unpaid MMG order moves nothing else', () => {
  it('after acceptance: no prepare, no ready, no board listing, no rider claim, no dispatch offer, no money rows; "Paid by MMG" then arms dispatch once', async () => {
    const arm = vi.spyOn(DispatchService.prototype, 'prepareForPlatformDelivery');
    try {
      const placed = await numberOrder();
      const riderBefore = await sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } }));
      expect((await accept(placed.order.id)).statusCode).toBe(200);
      const row = await orderRow(placed.order.id);
      expect([row.status, row.paymentStatus, row.riderId, row.fulfillmentMode]).toEqual(['ACCEPTED', 'PENDING', null, 'PLATFORM_RIDER']);

      // Acceptance armed no dispatch (the ON_ACCEPT trigger waits for the money).
      expect(arm).not.toHaveBeenCalled();
      // The dispatch engine itself refuses to offer it.
      expect(await makeDispatchService(app).dispatchOrder(placed.order.id)).toEqual({});
      expect(await sys(() => app.prisma.dispatchSearch.count({ where: { subjectId: placed.order.id } }))).toBe(0);
      // The stuck-dispatch reconciler does not treat it as stuck (it waits for the money, not a rider).
      const stuck = () => sys(() => app.prisma.order.count({ where: { AND: [stuckDispatchEligibleWhere(new Date(Date.now() + 60_000)), { id: placed.order.id }] } }));
      expect(await stuck()).toBe(0);
      // No money record, no float, no earning.
      expect(await sys(() => app.prisma.deliveryCashSettlement.count({ where: { orderId: placed.order.id } }))).toBe(0);
      expect(await sys(() => app.prisma.earning.count({ where: { orderId: placed.order.id } }))).toBe(0);
      const riderAfter = await sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } }));
      expect(riderAfter.committedFloat).toEqual(riderBefore.committedFloat);

      // The store cannot move it on: preparing is the payment gate; ready is unreachable from here.
      const prep = await call('PUT', `/api/v1/vendor/orders/${placed.order.id}/preparing`, owner.token, undefined, store());
      expect(prep.statusCode, prep.body).toBe(409);
      expect(prep.json().error.code).toBe('MMG_PAYMENT_PENDING');
      const ready = await call('PUT', `/api/v1/vendor/orders/${placed.order.id}/ready`, owner.token, undefined, store());
      expect(ready.statusCode).toBeGreaterThanOrEqual(400);
      expect((await orderRow(placed.order.id)).status).toBe('ACCEPTED');
      // No rider sees it or can take it.
      const board = await call('GET', '/api/v1/rider/orders/available', rider.token);
      expect(board.statusCode, board.body).toBe(200);
      expect(JSON.stringify(board.json().data)).not.toContain(placed.order.id);
      const grab = await call('POST', `/api/v1/rider/orders/${placed.order.id}/accept`, rider.token, {});
      expect(grab.statusCode, grab.body).toBe(409);
      expect(grab.json().error.code).toBe('MMG_PAYMENT_PENDING');
      expect((await orderRow(placed.order.id)).riderId).toBeNull();

      // Only THIS store's owner or manager may say "Paid by MMG": staff, another store and the customer may not.
      const ref = `MP${nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, '7')}`;
      const byStaff = await call('POST', `/api/v1/vendor/orders/${placed.order.id}/confirm-payment`, staff.token, { reference: ref }, store());
      expect(byStaff.statusCode).toBe(403);
      const byOtherStore = await call('POST', `/api/v1/vendor/orders/${placed.order.id}/confirm-payment`, otherOwner.token, { reference: ref }, { 'x-vendor-id': otherVendorId });
      expect(byOtherStore.statusCode).toBe(404);
      const byCustomer = await call('POST', `/api/v1/vendor/orders/${placed.order.id}/confirm-payment`, customer.token, { reference: ref }, store());
      expect([403, 404]).toContain(byCustomer.statusCode);
      expect((await orderRow(placed.order.id)).paymentStatus).toBe('PENDING');

      const paid = await call('POST', `/api/v1/vendor/orders/${placed.order.id}/confirm-payment`, manager.token, { reference: ref }, store());
      expect(paid.statusCode, paid.body).toBe(200);
      expect((await orderRow(placed.order.id)).paymentStatus).toBe('CLAIMED');
      expect(await stuck()).toBe(1); // paid and still riderless: the reconciler may now re-drive it
      // "Paid by MMG" is the moment dispatch is armed — once, at the order's own version.
      expect(arm).toHaveBeenCalledTimes(1);
      expect(arm).toHaveBeenCalledWith(placed.order.id, row.fulfillmentModeVersion);
      // A second tap is idempotent: nothing new is written, nothing is armed again.
      const again = await call('POST', `/api/v1/vendor/orders/${placed.order.id}/confirm-payment`, manager.token, { reference: ref }, store());
      expect(again.statusCode).toBe(200);
      expect(arm).toHaveBeenCalledTimes(1);
      expect(await sys(() => app.prisma.orderStatusLog.count({ where: { orderId: placed.order.id, note: { startsWith: 'MMG payment attested' } } }))).toBe(1);
    } finally {
      arm.mockRestore();
    }
  });
});

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { customerRoutes } from '../modules/user/customer.routes';
import courierRoutes from '../modules/courier/courier.routes';
import { ALGO_DEFAULTS } from '../modules/algo/algo-config';
import { checkVelocity, ORDER_PLACE_ACTION, ORDER_RESERVE_LUA, readOrderPlacementBudget, refundOrderPlacement, reserveOrderPlacement, velocityKey } from '../modules/integrity/velocity';
import { holdTillSyncLock } from '../modules/inventory/till-sync-lock';
import { CheckoutOutcomeUnknownError } from '../modules/order/checkout-outbox';
import { OrderService, type CheckoutCommit } from '../modules/order/order.service';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [FULL-LAUNCH · owner ruling 5 Nov 2026] Nothing limited how many orders one person placed: one prepaid SIM could put
// many cash orders on many stores at once. 6 an hour for a person, 12 across a linked identity cluster, a store order
// and a parcel alike. Only an order that gets through counts, a replay never pays twice, and the IP is never counted:
// Guyana's carriers put many customers behind one address. Every request here comes from the same injected IP.
// ---------------------------------------------------------------------------

const RUN = nanoid(6).toLowerCase();
const FIXTURE = 'order-place-limit-fixture';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);
const DAY = 86_400_000;
const AT = { lat: 2.9, lng: -59.9 };
const LIMIT = ALGO_DEFAULTS['velocity.limits']['order.place']!;

let app: FastifyInstance;
const userIds: string[] = [];
const vendorIds: string[] = [];
const clusterIds: string[] = [];
let store = { vendorId: '', itemId: '' };
let otherStore = { vendorId: '', itemId: '' };

type Actor = { userId: string; token: string };

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Limit', lastName: `L${RUN}`, roles, activeRole, status: 'ACTIVE',
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `pl-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token };
}

async function makeStore(name: string) {
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ids = await sys(async () => {
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name, slug: `pl-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5926990000',
        addressLine1: '1 Savannah Road', city: 'Aishalton', region: 'Upper Takutu', latitude: AT.lat, longitude: AT.lng,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
      },
    });
    const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
    const item = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Rice plate', basePrice: 2000, isAvailable: true } });
    return { vendorId: vendor.id, itemId: item.id };
  });
  vendorIds.push(ids.vendorId);
  return ids;
}

const call = (method: 'GET' | 'POST', url: string, token: string, payload?: Record<string, unknown>, headers: Record<string, string> = {}) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
});

async function pickupCheckout(c: Actor, at = store, headers: Record<string, string> = {}) {
  const added = await call('POST', '/api/v1/customer/cart/items', c.token, { vendorId: at.vendorId, itemId: at.itemId, quantity: 1 });
  expect([200, 201], added.body).toContain(added.statusCode);
  return call('POST', '/api/v1/customer/checkout', c.token, { paymentMethod: 'CASH', fulfillmentSelections: { [at.vendorId]: 'PICKUP' } }, headers);
}

const placed = (c: Actor) => sys(() => app.prisma.order.count({ where: { customerId: c.userId } }));

async function link(...actors: Actor[]) {
  const cluster = await sys(() => app.prisma.identityCluster.create({ data: { members: { create: actors.map((a) => ({ accountId: a.userId, linkedVia: [] })) } } }));
  clusterIds.push(cluster.id);
  return cluster.id;
}

const PARCEL = {
  pickup: AT, dropoff: { lat: AT.lat + 0.02, lng: AT.lng }, pickupAddress: '12 Sender Street', dropoffAddress: '34 Recipient Avenue',
  packageSize: 'SMALL', packageDescription: 'A box of spare parts', speed: 'STANDARD', recipientName: 'Test Recipient', recipientPhone: '+5926001234', payer: 'SENDER',
};
const sendParcel = (c: Actor, key?: string) => call('POST', '/api/v1/courier/order', c.token, PARCEL, key ? { 'idempotency-key': key } : {});

/** What this hour has spent, read from the keys themselves. */
const hourStart = () => { const s = Math.floor(Date.now() / 1000); return Math.floor(s / LIMIT.perSeconds) * LIMIT.perSeconds; };
const spentBy = async (dimension: 'actor' | 'cluster', id: string) => Number(await app.redis.get(velocityKey(dimension, id, ORDER_PLACE_ACTION, hourStart())) ?? 0);
const spent = (c: Actor) => spentBy('actor', c.userId);
const clearCart = (c: Actor) => sys(() => app.prisma.cart.deleteMany({ where: { customerId: c.userId } }));
const pickupBody = (at = store) => ({ paymentMethod: 'CASH', fulfillmentSelections: { [at.vendorId]: 'PICKUP' } });
const REDIS_FAILS_AFTER_MS = 4_000; // plugins/redis.ts: how long a command waits while Redis is down.

async function dropVelocity() {
  const keys = await app.redis.keys('vel:*');
  if (keys.length) await app.redis.del(...keys);
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();
  store = await makeStore('Limit Kitchen');
  otherStore = await makeStore('Limit Bakery');
}, 120_000);

beforeEach(dropVelocity);
afterEach(dropVelocity);

afterAll(async () => {
  await sys(async () => {
    const orders = await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: userIds } }, { vendorId: { in: vendorIds } }] }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: userIds } } });
    await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: userIds } } });
    await app.prisma.identityCluster.deleteMany({ where: { id: { in: clusterIds } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  });
  await app.close();
}, 120_000);

describe('[FULL-LAUNCH] the figures', () => {
  it('are the owner’s: 6 an hour for a person, 12 an hour across a linked cluster', () => {
    expect(ALGO_DEFAULTS['velocity.limits']['order.place']).toEqual({ max: 6, perSeconds: 3_600, clusterMax: 12 });
  });
});

describe('[FULL-LAUNCH] one person', () => {
  it('places up to the limit; the next is refused in plain words, nothing is written, the cart stays', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    for (let i = 0; i < LIMIT.max; i++) expect((await pickupCheckout(c)).statusCode, `order ${i + 1}`).toBe(200);
    expect(await placed(c)).toBe(LIMIT.max);
    const over = await pickupCheckout(c);
    expect(over.statusCode, over.body).toBe(429);
    expect(over.json().error.code).toBe('VELOCITY_LIMIT');
    expect(over.json().error.message).toMatch(/^Too many orders in a short time — wait \d+ minutes? and try again\.$/);
    expect(await placed(c)).toBe(LIMIT.max);
    const cart = await call('GET', '/api/v1/customer/cart', c.token);
    expect(cart.json().data.items.length).toBeGreaterThan(0);
  });

  it('a refused checkout costs nothing: a store that is closed, a dozen times, then the order goes through', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await sys(() => app.prisma.vendor.update({ where: { id: otherStore.vendorId }, data: { acceptingOrders: false } }));
    try {
      for (let i = 0; i < 12; i++) {
        const refused = await (i === 0 ? pickupCheckout(c, otherStore) : call('POST', '/api/v1/customer/checkout', c.token, { paymentMethod: 'CASH', fulfillmentSelections: { [otherStore.vendorId]: 'PICKUP' } }));
        expect(refused.statusCode, refused.body).toBe(400);
        expect(refused.json().error.code).toBe('VENDOR_CLOSED');
      }
    } finally {
      await sys(() => app.prisma.vendor.update({ where: { id: otherStore.vendorId }, data: { acceptingOrders: true } }));
    }
    expect((await call('POST', '/api/v1/customer/checkout', c.token, { paymentMethod: 'CASH', fulfillmentSelections: { [otherStore.vendorId]: 'PICKUP' } })).statusCode).toBe(200);
  });

  it('a replay of a placed order still answers past the limit, and it spends nothing', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const key = `pl-idem-${nanoid(10)}`;
    const first = await pickupCheckout(c, store, { 'idempotency-key': key });
    expect(first.statusCode).toBe(200);
    const body = { paymentMethod: 'CASH', fulfillmentSelections: { [store.vendorId]: 'PICKUP' } };
    // The same command again and again: one order, and the budget still holds five more.
    for (let i = 0; i < LIMIT.max + 2; i++) {
      const replay = await call('POST', '/api/v1/customer/checkout', c.token, body, { 'idempotency-key': key });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().replayed).toBe(true);
    }
    expect(await placed(c)).toBe(1);
    for (let i = 1; i < LIMIT.max; i++) expect((await pickupCheckout(c)).statusCode, `order ${i + 1}`).toBe(200);
    expect((await pickupCheckout(c)).statusCode).toBe(429);
    // Refused or not, the placed order's own key still replays.
    const replay = await call('POST', '/api/v1/customer/checkout', c.token, body, { 'idempotency-key': key });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().replayed).toBe(true);
  });

  it('the refused command gives its key back: the same key places the order once the window has passed', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    for (let i = 0; i < LIMIT.max; i++) expect((await pickupCheckout(c)).statusCode).toBe(200);
    const key = `pl-later-${nanoid(10)}`;
    expect((await pickupCheckout(c, store, { 'idempotency-key': key })).statusCode).toBe(429);
    await dropVelocity();
    const later = await call('POST', '/api/v1/customer/checkout', c.token, { paymentMethod: 'CASH', fulfillmentSelections: { [store.vendorId]: 'PICKUP' } }, { 'idempotency-key': key });
    expect(later.statusCode, later.body).toBe(200);
    expect(later.json().replayed).toBeUndefined();
  });

  it('a multi-store cart that would pass the limit places nothing and spends nothing: the order that fits still goes', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    for (let i = 0; i < LIMIT.max - 1; i++) expect((await pickupCheckout(c)).statusCode).toBe(200);
    for (const at of [store, otherStore]) {
      const added = await call('POST', '/api/v1/customer/cart/items', c.token, { vendorId: at.vendorId, itemId: at.itemId, quantity: 1 });
      expect([200, 201], added.body).toContain(added.statusCode);
    }
    const both = await call('POST', '/api/v1/customer/checkout', c.token, { paymentMethod: 'CASH', fulfillmentSelections: { [store.vendorId]: 'PICKUP', [otherStore.vendorId]: 'PICKUP' } });
    expect(both.statusCode, both.body).toBe(429);
    expect(await placed(c)).toBe(LIMIT.max - 1);
    expect(await spent(c)).toBe(LIMIT.max - 1);
    await clearCart(c);
    const single = await pickupCheckout(c);
    expect(single.statusCode, single.body).toBe(200);
    expect(await spent(c)).toBe(LIMIT.max);
  });

  it('a multi-store cart that fits counts one order per store', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    for (const at of [store, otherStore]) {
      expect([200, 201]).toContain((await call('POST', '/api/v1/customer/cart/items', c.token, { vendorId: at.vendorId, itemId: at.itemId, quantity: 1 })).statusCode);
    }
    const both = await call('POST', '/api/v1/customer/checkout', c.token, { paymentMethod: 'CASH', fulfillmentSelections: { [store.vendorId]: 'PICKUP', [otherStore.vendorId]: 'PICKUP' } });
    expect(both.statusCode, both.body).toBe(200);
    expect(await spent(c)).toBe(2);
  });

  it('a store busy applying a file: the same key retried and refused again and again spends nothing, then spends once', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const key = `pl-busy-${nanoid(10)}`;
    expect([200, 201]).toContain((await call('POST', '/api/v1/customer/cart/items', c.token, { vendorId: otherStore.vendorId, itemId: otherStore.itemId, quantity: 1 })).statusCode);
    let release = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    let held = () => {};
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const holder = app.prisma.$transaction(async (tx) => {
      await holdTillSyncLock(tx, otherStore.vendorId);
      held();
      await released;
    }, { timeout: 30_000 });
    await holding;
    try {
      for (let i = 0; i < LIMIT.max + 2; i++) {
        const busy = await call('POST', '/api/v1/customer/checkout', c.token, pickupBody(otherStore), { 'idempotency-key': key });
        expect(busy.statusCode, busy.body).toBe(409);
        expect(busy.json().error.code).toBe('STORE_BUSY');
      }
    } finally {
      release();
      await holder;
    }
    expect(await spent(c)).toBe(0);
    const placedNow = await call('POST', '/api/v1/customer/checkout', c.token, pickupBody(otherStore), { 'idempotency-key': key });
    expect(placedNow.statusCode, placedNow.body).toBe(200);
    expect(await spent(c)).toBe(1);
  }, 60_000);

  it('a price that moved inside the commit gives its reservation back', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    expect([200, 201]).toContain((await call('POST', '/api/v1/customer/cart/items', c.token, { vendorId: store.vendorId, itemId: store.itemId, quantity: 1 })).statusCode);
    for (let i = 0; i < LIMIT.max + 2; i++) {
      const moved = await call('POST', '/api/v1/customer/checkout', c.token, { ...pickupBody(), expectedTotal: 1 });
      expect(moved.statusCode, moved.body).toBe(409);
      expect(moved.json().error.code).toBe('PRICE_CHANGED');
    }
    expect(await spent(c)).toBe(0);
    expect((await call('POST', '/api/v1/customer/checkout', c.token, pickupBody())).statusCode).toBe(200);
    expect(await spent(c)).toBe(1);
  });

  it('an unknown outcome keeps the spend: it may be an order', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const spy = vi.spyOn(OrderService.prototype, 'checkout').mockImplementationOnce(async (input) => {
      await input.reservePlacement!(1);
      throw new CheckoutOutcomeUnknownError(null);
    });
    try {
      const res = await call('POST', '/api/v1/customer/checkout', c.token, pickupBody());
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json().error.code).toBe('CHECKOUT_OUTCOME_UNKNOWN');
    } finally {
      spy.mockRestore();
    }
    expect(await spent(c)).toBe(1);
  });

  it('after its commit an order keeps the spend, whatever is thrown next', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const answer = { orders: [] } as unknown as CheckoutCommit['answer'];
    const spy = vi.spyOn(OrderService.prototype, 'checkout').mockImplementationOnce(async (input) => {
      await input.reservePlacement!(1);
      input.onCommitted!({ receiptId: null, answer });
      throw new Error('a failure after the commit point');
    });
    try {
      expect((await call('POST', '/api/v1/customer/checkout', c.token, pickupBody())).statusCode).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect(await spent(c)).toBe(1);
  });

  it('a parcel spends the same budget, and the seventh order of any kind is refused before anything is written', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    for (let i = 0; i < LIMIT.max - 1; i++) expect((await pickupCheckout(c)).statusCode).toBe(200);
    const parcel = await sendParcel(c);
    expect(parcel.statusCode, parcel.body).toBe(201);
    const over = await sendParcel(c);
    expect(over.statusCode, over.body).toBe(429);
    expect(over.json().error.code).toBe('VELOCITY_LIMIT');
    expect(await placed(c)).toBe(LIMIT.max);
  });

  it('a parcel refused for want of riders spends nothing', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    vi.stubEnv('DISPATCH_AVAILABILITY', '1');
    try {
      for (let i = 0; i < LIMIT.max + 2; i++) expect((await sendParcel(c)).json().error.code).toBe('DELIVERY_NO_RIDERS');
    } finally {
      vi.unstubAllEnvs();
    }
    for (let i = 0; i < LIMIT.max; i++) expect((await sendParcel(c)).statusCode, `parcel ${i + 1}`).toBe(201);
  });

  it('one parcel sent three times at once spends once: the retries wait for the lock and read the receipt', async () => {
    vi.stubEnv('MASTER_KEK', randomBytes(32).toString('base64'));
    resetKeyProviderForTests();
    try {
      const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
      for (let i = 0; i < LIMIT.max - 1; i++) expect((await pickupCheckout(c)).statusCode).toBe(200);
      const key = `pl-race-${nanoid(10)}`;
      const answers = await Promise.all([sendParcel(c, key), sendParcel(c, key), sendParcel(c, key)]);
      // The last slot, three sends: nobody is told "too many orders" for a parcel that exists.
      expect(answers.map((a) => a.statusCode)).toEqual([201, 201, 201]);
      expect(await placed(c)).toBe(LIMIT.max);
      expect(await spent(c)).toBe(LIMIT.max);
    } finally {
      vi.unstubAllEnvs();
      resetKeyProviderForTests();
    }
  });

  it('a parcel rolled back inside its transaction gives its reservation back', async () => {
    vi.stubEnv('MASTER_KEK', '');
    resetKeyProviderForTests();
    try {
      const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
      const res = await sendParcel(c, `pl-back-${nanoid(10)}`);
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json().error.code).toBe('COURIER_RETRY_UNAVAILABLE');
      expect(await placed(c)).toBe(0);
      expect(await spent(c)).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      resetKeyProviderForTests();
    }
  });

  it('a parcel whose commit gives no answer keeps the spend: it may exist', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const real = app.prisma.$transaction.bind(app.prisma) as (...args: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(app.prisma, '$transaction').mockImplementationOnce((async (...args: unknown[]) => {
      await real(...args);
      throw new Error('the connection dropped at the commit');
    }) as never);
    try {
      expect((await sendParcel(c)).statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await spent(c)).toBe(1);
  });

  it('the parcel route reads the budget before its transaction: on the wall a non-tenant read must not run inside one', () => {
    const route = readFileSync(join(process.cwd(), 'src/modules/courier/courier.routes.ts'), 'utf8');
    const read = route.indexOf('await readOrderPlacementBudget(');
    const opened = route.indexOf('await app.prisma.$transaction(async (tx) => {\n      await lockActiveOrderCustomer(tx, userId, customer.tenantId);');
    expect(read).toBeGreaterThan(0);
    expect(opened).toBeGreaterThan(read);
  });

  it('a parcel replay answers past the limit and spends nothing', async () => {
    // A synthetic key for the sealed replay answer.
    vi.stubEnv('MASTER_KEK', randomBytes(32).toString('base64'));
    resetKeyProviderForTests();
    try {
      const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
      const key = `pl-parcel-${nanoid(10)}`;
      expect((await sendParcel(c, key)).statusCode).toBe(201);
      for (let i = 1; i < LIMIT.max; i++) expect((await pickupCheckout(c)).statusCode).toBe(200);
      expect((await pickupCheckout(c)).statusCode).toBe(429);
      expect((await sendParcel(c, key)).statusCode).toBe(201);
      expect(await placed(c)).toBe(LIMIT.max);
    } finally {
      vi.unstubAllEnvs();
      resetKeyProviderForTests();
    }
  });
});

describe('[FULL-LAUNCH] never the IP', () => {
  it('strangers behind one carrier address do not share a budget', async () => {
    // More customers' orders than a cluster may place, all from the one injected address.
    let total = 0;
    for (let person = 0; person < 3; person++) {
      const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
      for (let i = 0; i < LIMIT.max; i++) {
        expect((await pickupCheckout(c)).statusCode, `person ${person} order ${i + 1}`).toBe(200);
        total += 1;
      }
    }
    expect(total).toBeGreaterThan(LIMIT.clusterMax!);
  }, 120_000);

  it('writes no counter but the person’s and the cluster’s', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await link(c);
    await reserveOrderPlacement(app.redis, await readOrderPlacementBudget({ prisma: app.prisma }, c.userId));
    const keys = await app.redis.keys(`vel:${ORDER_PLACE_ACTION}:*`);
    expect(keys.map((k) => k.split(':')[2]).sort()).toEqual(['actor', 'cluster']);
  });
});

describe('[FULL-LAUNCH] one identity cluster', () => {
  const spend = async (clusterId: string, n: number) => {
    for (let i = 0; i < n; i++) await checkVelocity({ redis: app.redis }, { action: ORDER_PLACE_ACTION, actor: { clusterId } });
  };

  it('linked accounts share 12 an hour: another account buys no more orders', async () => {
    const a = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const b = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const clusterId = await link(a, b);
    await spend(clusterId, LIMIT.clusterMax! - 1);
    expect((await pickupCheckout(a)).statusCode).toBe(200);
    const refused = await pickupCheckout(b);
    expect(refused.statusCode, refused.body).toBe(429);
    expect(await placed(b)).toBe(0);
    // All or nothing: a full cluster charges the person nothing either.
    expect(await spent(b)).toBe(0);
  });

  it('one person’s refused taps leave the cluster’s budget alone: a linked account still orders', async () => {
    const a = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const b = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const clusterId = await link(a, b);
    for (let i = 0; i < LIMIT.max; i++) expect((await pickupCheckout(a)).statusCode).toBe(200);
    for (let i = 0; i < LIMIT.max; i++) {
      const res = i === 0 ? await pickupCheckout(a) : await call('POST', '/api/v1/customer/checkout', a.token, pickupBody());
      expect(res.statusCode, res.body).toBe(429);
    }
    expect(await spentBy('cluster', clusterId)).toBe(LIMIT.max);
    expect((await pickupCheckout(b)).statusCode).toBe(200);
  });

  it('an account whose cluster needs a person’s review keeps its own limit and charges nobody else', async () => {
    const a = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const clusterId = await link(a);
    await sys(() => app.prisma.identityCluster.update({ where: { id: clusterId }, data: { authorityReviewRequired: true } }));
    await spend(clusterId, LIMIT.clusterMax!);
    expect((await pickupCheckout(a)).statusCode).toBe(200);
    const keys = await app.redis.keys(`vel:${ORDER_PLACE_ACTION}:actor:*`);
    expect(keys.length).toBe(1);
  });
});

describe('[FULL-LAUNCH] a reservation given back', () => {
  const budget = () => ({ limit: LIMIT, userId: `pl-${nanoid(8)}`, clusterId: `pl-${nanoid(8)}` });

  it('comes off both keys, and never goes below zero', async () => {
    const b = budget();
    const first = await reserveOrderPlacement(app.redis, b, 2);
    const second = await reserveOrderPlacement(app.redis, b, 1);
    await refundOrderPlacement(app.redis, first);
    expect(await spentBy('actor', b.userId)).toBe(1);
    expect(await spentBy('cluster', b.clusterId)).toBe(1);
    await refundOrderPlacement(app.redis, first);
    expect(await spentBy('actor', b.userId)).toBe(1);
    await refundOrderPlacement(app.redis, second);
    expect(await spentBy('actor', b.userId)).toBe(0);
  });

  it('does not bring back a window that has ended', async () => {
    const b = budget();
    const reservation = await reserveOrderPlacement(app.redis, b);
    await app.redis.del(...reservation!.keys);
    await refundOrderPlacement(app.redis, reservation);
    expect(await app.redis.exists(...reservation!.keys)).toBe(0);
  });

  it('every key dies with its window', async () => {
    const reservation = await reserveOrderPlacement(app.redis, budget());
    for (const key of reservation!.keys) {
      const ttl = await app.redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(LIMIT.perSeconds);
    }
  });

  it('no limit configured: nothing is reserved', async () => {
    expect(await reserveOrderPlacement(app.redis, null)).toBeNull();
  });
});

describe('[FULL-LAUNCH] a control that is down', () => {
  // Only the reservation fails. A keyed checkout refuses earlier, on its own claim, which is older than this limit.
  const reserveFails = (ms = 0) => {
    const real = app.redis.eval.bind(app.redis) as (...args: unknown[]) => Promise<unknown>;
    return vi.spyOn(app.redis, 'eval').mockImplementation((async (...args: unknown[]) => {
      if (args[0] !== ORDER_RESERVE_LUA) return real(...args);
      await new Promise((resolve) => setTimeout(resolve, ms));
      throw new Error('redis down');
    }) as never);
  };

  it('a checkout with no key goes ahead', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const spy = reserveFails();
    try {
      expect((await pickupCheckout(c)).statusCode).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect(await placed(c)).toBe(1);
  });

  it('a parcel goes ahead, even when the refusal takes as long as a dead Redis takes', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const spy = reserveFails(REDIS_FAILS_AFTER_MS);
    try {
      const res = await sendParcel(c);
      expect(res.statusCode, res.body).toBe(201);
    } finally {
      spy.mockRestore();
    }
    expect(await placed(c)).toBe(1);
  }, 30_000);
});

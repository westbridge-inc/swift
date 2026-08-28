import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// THE HOME ACTIVE-ORDER CONTRACT.
//
// Home's live-order card is the only place a customer sees an order in flight
// without opening it. It renders two things it cannot compute for itself:
//
//   orderType     — decides the WORDS. `lib/orderStatus.ts` selects the taxi,
//                   courier or from-a-store label table from it. Missing, every
//                   order falls through to from-a-store, so a passenger sitting
//                   in the back of a moving car is told "Waiting for the store".
//                   That file exists BECAUSE of that bug; the client half of
//                   the fix was correct and shipped.
//
//   holdExpiresAt — the free-cancel window. Paired with `placedAt` it is the
//                   two ends `holdRingWindow` requires before it will draw
//                   anything; it refuses to synthesize a window from an assumed
//                   length, so one missing field silently removes the countdown
//                   rather than making it wrong.
//
// Both were absent from this route's `activeOrder` select while every sibling
// order route sent them (`customer.routes.ts` order detail and order list both
// carry `holdExpiresAt`). Nothing failed. The client was right, the schema was
// right, the words were right — and the fields stopped at the select.
//
// That is the failure mode this file grades: not "is the label correct" (a
// mobile unit test already owns that) but "does the server actually SEND the
// input that label needs". A seam nobody asserts is a seam that reopens.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];

const PHONE_PREFIX = '+59200812';

/** A token alone is not a signed-in customer: `authenticateOptional` looks the
 *  raw JWT up in `sessions` and falls back to GUEST on a miss — and a guest has
 *  no active order at all, so every assertion here would grade an empty feed. */
async function signIn(id: string): Promise<string> {
  const jwt = app.jwt.sign({ userId: id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: id, token: jwt, refreshToken: nanoid(48),
      deviceId: `activeorder-${nanoid(6)}`, deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return jwt;
}

let seq = 0;
async function makeCustomer(): Promise<{ id: string; token: string }> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
      firstName: 'Active', lastName: `Order${seq}`,
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      isPhoneVerified: true,
    },
  });
  createdUserIds.push(user.id);
  return { id: user.id, token: await signIn(user.id) };
}

async function makeOrder(opts: {
  customerId: string;
  orderType: 'TAXI' | 'FOOD_DELIVERY';
  holdExpiresAt?: Date | null;
}) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `SW-AOC-${nanoid(8).toUpperCase()}`,
      orderType: opts.orderType,
      customerId: opts.customerId,
      status: 'PENDING',
      deliveryAddress: '1 Contract Street, Georgetown',
      deliveryLat: 6.8013, deliveryLng: -58.1551,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 0, totalAmount: 1000,
      paymentMethod: 'CASH',
      ...(opts.holdExpiresAt !== undefined ? { holdExpiresAt: opts.holdExpiresAt } : {}),
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

/** The feed is cached for 60s under a tenant-prefixed per-user key. A residual
 *  entry would answer the request and these assertions would grade a stale
 *  feed written by the code as it was BEFORE the change. */
async function clearHomeCache(userId: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, batch] = await app.redis.scan(cursor, 'MATCH', `*home:${userId}:*`, 'COUNT', 200);
    cursor = next;
    if (batch.length) await app.redis.del(...batch);
  } while (cursor !== '0');
}

async function fetchActiveOrder(token: string, userId: string): Promise<any> {
  await clearHomeCache(userId);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/customer/home',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.activeOrder;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  registerErrorHandler(app);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  // Idempotent purge of an interrupted prior run (house pattern: one unique
  // fixture phone prefix per file).
  const stale = await app.prisma.user.findMany({
    where: { phone: { startsWith: PHONE_PREFIX } },
    select: { id: true },
  });
  if (stale.length) {
    await app.prisma.order.deleteMany({ where: { customerId: { in: stale.map((u) => u.id) } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: stale.map((u) => u.id) } } });
    await app.prisma.user.deleteMany({ where: { id: { in: stale.map((u) => u.id) } } });
  }
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('Home sends the order TYPE, so the card can use the right words', () => {
  it('a taxi ride arrives on Home labelled as a taxi ride', async () => {
    const customer = await makeCustomer();
    await makeOrder({ customerId: customer.id, orderType: 'TAXI' });

    const activeOrder = await fetchActiveOrder(customer.token, customer.id);

    expect(activeOrder, 'the customer has a non-terminal order; Home must return it').toBeTruthy();
    // This is the whole defect in one line. Without it the client's label table
    // falls back to from-a-store and the passenger reads "Waiting for the
    // store" — for a ride that has no store.
    expect(
      activeOrder.orderType,
      'orderType is what selects the taxi/courier/store label table on the client; ' +
        'dropping it from the select makes every order read as a food order',
    ).toBe('TAXI');
  });

  it('a food order carries its type too — the field is not taxi-only plumbing', async () => {
    const customer = await makeCustomer();
    await makeOrder({ customerId: customer.id, orderType: 'FOOD_DELIVERY' });

    const activeOrder = await fetchActiveOrder(customer.token, customer.id);
    expect(activeOrder.orderType).toBe('FOOD_DELIVERY');
  });
});

describe('Home sends the HOLD, so the free-cancel window is visible from Home', () => {
  it('a held order arrives with both ends of its window', async () => {
    const customer = await makeCustomer();
    const holdEnds = new Date(Date.now() + 5 * 60_000);
    await makeOrder({ customerId: customer.id, orderType: 'FOOD_DELIVERY', holdExpiresAt: holdEnds });

    const activeOrder = await fetchActiveOrder(customer.token, customer.id);

    // BOTH, together. `holdRingWindow` returns null unless it has the start and
    // the end, and it will not invent a five-minute default — so losing either
    // field removes the countdown silently instead of drawing a wrong one.
    expect(activeOrder.holdExpiresAt, 'the end of the hold window').toBeTruthy();
    expect(activeOrder.placedAt, 'the start of the hold window').toBeTruthy();
    expect(new Date(activeOrder.holdExpiresAt).getTime()).toBe(holdEnds.getTime());
  });

  it('the hold is an ABSOLUTE instant, never a remaining-seconds count', async () => {
    // Home is cached for HOME_CACHE_TTL (60s) against a five-minute window. A
    // countdown computed server-side would leave the cache up to 20% wrong on
    // the one number the cancellation policy is built around; an absolute
    // timestamp is still exactly true whenever it is read.
    const customer = await makeCustomer();
    const holdEnds = new Date(Date.now() + 5 * 60_000);
    await makeOrder({ customerId: customer.id, orderType: 'FOOD_DELIVERY', holdExpiresAt: holdEnds });

    const activeOrder = await fetchActiveOrder(customer.token, customer.id);
    expect(typeof activeOrder.holdExpiresAt).toBe('string');
    expect(Number.isNaN(Date.parse(activeOrder.holdExpiresAt))).toBe(false);
    // A seconds-remaining field would be the wrong shape arriving beside it.
    expect(activeOrder).not.toHaveProperty('holdRemainingSeconds');
  });

  it('an order past its hold still returns, and reports the window as closed', async () => {
    // The card must distinguish "held" from "with the store". A past timestamp
    // is server HISTORY — the client predicate reads it as no live window.
    const customer = await makeCustomer();
    const past = new Date(Date.now() - 60_000);
    await makeOrder({ customerId: customer.id, orderType: 'FOOD_DELIVERY', holdExpiresAt: past });

    const activeOrder = await fetchActiveOrder(customer.token, customer.id);
    expect(activeOrder).toBeTruthy();
    expect(new Date(activeOrder.holdExpiresAt).getTime()).toBeLessThan(Date.now());
  });

  it('an order that was never held reports no window rather than a fabricated one', async () => {
    const customer = await makeCustomer();
    await makeOrder({ customerId: customer.id, orderType: 'FOOD_DELIVERY', holdExpiresAt: null });

    const activeOrder = await fetchActiveOrder(customer.token, customer.id);
    expect(activeOrder).toBeTruthy();
    expect(activeOrder.holdExpiresAt).toBeNull();
  });
});

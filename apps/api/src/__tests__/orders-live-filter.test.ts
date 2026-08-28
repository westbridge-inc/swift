import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { TERMINAL_ORDER_STATUSES } from '../modules/order/order.service';

// ---------------------------------------------------------------------------
// A FILTER CANNOT FIND WHAT PAGINATION NEVER FETCHED.
//
// The activity list built its "IN PROGRESS" section by filtering the pages of
// history it had loaded. The filter itself was correct. The list it filtered
// was not the list: `GET /orders` is `placedAt` DESC and pages at 20, so the
// only live orders that section could ever find were live orders that happened
// to be among the customer's twenty most recent.
//
// Measured on a real account before the fix — 101 orders, 19 of them open:
//
//     rank   1,2,5,6,7,8      live   → on page 1, shown
//     rank   44,45,71,77,…    live   → pages 3-5, INVISIBLE
//     rank   97,99,100        live   → placed in MARCH, still READY_FOR_PICKUP
//
// Six shown under a heading that means nineteen. Home, which queries live
// orders directly instead of filtering a page of history, showed one of the
// hidden ones the entire time — so the two surfaces disagreed about whether
// the customer had an order in flight, and the one dedicated to answering that
// question was the one that was wrong.
//
// The endpoint now answers `live` itself, against TERMINAL_ORDER_STATUSES —
// the same set every other partition in the platform uses. This file grades
// that: the buried order must come back, the two halves must tile the whole
// history exactly, and the complement must be taken from the canonical set
// rather than a list written out by hand.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];

const PHONE_PREFIX = '+59200932';

/** A raw JWT is not a session: `authenticate` looks the token up in `sessions`,
 *  so an unsigned-in id would grade a 401 rather than the filter. */
async function signIn(id: string): Promise<string> {
  const jwt = app.jwt.sign({ userId: id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: id, token: jwt, refreshToken: nanoid(48),
      deviceId: `livefilter-${nanoid(6)}`, deviceType: 'test',
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
      firstName: 'Live', lastName: `Filter${seq}`,
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      isPhoneVerified: true,
    },
  });
  createdUserIds.push(user.id);
  return { id: user.id, token: await signIn(user.id) };
}

/** `placedAt` is explicit on every fixture: the burial is the whole point, and
 *  a fixture that let the database stamp them would order by insert speed. */
async function makeOrder(opts: {
  customerId: string;
  status: string;
  placedAt: Date;
}) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `SW-LF-${nanoid(8).toUpperCase()}`,
      orderType: 'FOOD_DELIVERY',
      customerId: opts.customerId,
      status: opts.status as never,
      placedAt: opts.placedAt,
      deliveryAddress: '1 Filter Street, Georgetown',
      deliveryLat: 6.8013, deliveryLng: -58.1551,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 0, totalAmount: 1000,
      paymentMethod: 'CASH',
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

async function getOrders(token: string, query: string): Promise<{ status: number; body: any }> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/customer/orders${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, body: res.json() };
}

const idsOf = (body: any): string[] => (body?.data ?? []).map((o: any) => String(o.id));

/**
 * The shape that shipped: one live order older than a full page of finished
 * ones. 24 terminal orders placed most recently, one live order placed before
 * all of them — so it lands at rank 25, one row past the 20-row page.
 */
async function customerWithABuriedLiveOrder() {
  const customer = await makeCustomer();
  const base = Date.now();
  const buried = await makeOrder({
    customerId: customer.id,
    status: 'READY_FOR_PICKUP',
    placedAt: new Date(base - 1_000 * 60 * 60 * 24 * 90),
  });
  const recent: string[] = [];
  for (let i = 0; i < 24; i += 1) {
    const o = await makeOrder({
      customerId: customer.id,
      status: 'DELIVERED',
      placedAt: new Date(base - i * 60_000),
    });
    recent.push(o.id);
  }
  return { customer, buried, recent };
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

describe('a live order older than one page of history', () => {
  it('is genuinely out of reach of page 1 (the fixture reproduces the bug)', async () => {
    // POSITIVE CONTROL. If this ever fails, the fixture stopped burying the
    // order and every assertion below would pass without proving anything.
    const { customer, buried } = await customerWithABuriedLiveOrder();

    const page1 = await getOrders(customer.token, '');

    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(20);
    expect(
      idsOf(page1.body),
      'the buried live order must NOT be on page 1 — that is the condition being fixed',
    ).not.toContain(buried.id);
  });

  it('comes back on the first page when the caller asks for live orders', async () => {
    const { customer, buried } = await customerWithABuriedLiveOrder();

    const live = await getOrders(customer.token, '?live=true');

    expect(live.status).toBe(200);
    expect(
      idsOf(live.body),
      'this is the order the customer is still waiting on; asking for live orders must return it',
    ).toContain(buried.id);
    // …and nothing finished rode along with it.
    expect(live.body.data.every((o: any) => !TERMINAL_ORDER_STATUSES.includes(o.status))).toBe(true);
    expect(live.body.meta.total).toBe(1);
  });

  it('is absent from history, so the two halves never show it twice', async () => {
    const { customer, buried, recent } = await customerWithABuriedLiveOrder();

    const history = await getOrders(customer.token, '?live=false&limit=50');

    expect(history.status).toBe(200);
    expect(idsOf(history.body)).not.toContain(buried.id);
    expect(history.body.meta.total).toBe(recent.length);
  });
});

describe('the two halves tile the customer\'s orders exactly', () => {
  // The client reconciles history against the live list BY ID. That is only
  // safe because these two queries are complements — no gap, no overlap.
  it('live ∪ history = everything, and live ∩ history = nothing', async () => {
    const { customer } = await customerWithABuriedLiveOrder();

    const all = await getOrders(customer.token, '?limit=50');
    const live = await getOrders(customer.token, '?live=true&limit=50');
    const history = await getOrders(customer.token, '?live=false&limit=50');

    const allIds = new Set(idsOf(all.body));
    const liveIds = idsOf(live.body);
    const histIds = idsOf(history.body);

    expect(liveIds.filter((id) => histIds.includes(id)), 'an order in both halves').toEqual([]);
    expect(new Set([...liveIds, ...histIds]), 'an order in neither half').toEqual(allIds);
    expect(all.body.meta.total).toBe(live.body.meta.total + history.body.meta.total);
  });

  it('a status is live unless the canonical set calls it finished', async () => {
    // FAILED is the member a hand-written terminal set in this very screen
    // missed, and the reason the set now has one owner. Graded from the
    // canonical export so this cannot pass by restating the same list.
    const customer = await makeCustomer();
    const base = Date.now();
    for (const status of TERMINAL_ORDER_STATUSES) {
      await makeOrder({ customerId: customer.id, status, placedAt: new Date(base) });
    }
    const stillGoing = await makeOrder({
      customerId: customer.id, status: 'PREPARING', placedAt: new Date(base),
    });

    const live = await getOrders(customer.token, '?live=true&limit=50');

    expect(idsOf(live.body)).toEqual([stillGoing.id]);
    expect(
      live.body.meta.total,
      `every one of ${TERMINAL_ORDER_STATUSES.join(', ')} must count as finished`,
    ).toBe(1);
  });
});

describe('the two filters cannot silently contradict each other', () => {
  it('rejects status and live together rather than picking one', async () => {
    const customer = await makeCustomer();

    const res = await getOrders(customer.token, '?status=DELIVERED&live=true');

    expect(res.status, 'a query with no honest answer must not return 200').toBe(400);
  });

  it('still honours an explicit status filter on its own', async () => {
    // Guards the branch above: the new clause must not have swallowed the
    // pre-existing behaviour of `status`.
    const { customer, buried } = await customerWithABuriedLiveOrder();

    const res = await getOrders(customer.token, '?status=READY_FOR_PICKUP&limit=50');

    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual([buried.id]);
  });

  it('rejects a live value that is not a boolean', async () => {
    const customer = await makeCustomer();

    const res = await getOrders(customer.token, '?live=yes');

    expect(res.status, '`live=yes` must not be read as false and silently return history').toBe(400);
  });
});

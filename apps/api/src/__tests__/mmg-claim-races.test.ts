/**
 * [ORDER-SPINE S1-6 · REPORT-211 · ORDER-SPINE-CROSS-LANE-INTEGRATION-GATE] The
 * direct-MMG claim authority on a REAL PostgreSQL row lock.
 *
 * Every request here goes through the actual Fastify routes, the actual Prisma
 * client and the actual `orders` row. The contended cases pause the FIRST
 * command right after it holds `SELECT … FOR UPDATE` (a test-only observer that
 * no route ever sets), then prove from `pg_stat_activity` that the SECOND
 * command is waiting on a lock — not merely scheduled later — before releasing.
 * Sleeps prove nothing here; the waiter is observed.
 *
 * What current main did, and what these assert instead:
 *   - a customer "I did not pay" recorded before the store's claim was not
 *     durable, so the store's later claim finished CLAIMED with no dispute;
 *   - the customer's route read a stale preview outside any lock;
 *   - the admin resolver cleared whatever dispute was open with an unlocked,
 *     unversioned write and a separate audit call;
 *   - nothing stopped a disputed order from being offered or listed to riders;
 *   - [R2] a grocery pick or substitution proposal gated on a preview could
 *     land after the denial committed, and a claim notice the queue accepted
 *     was consumed whatever its delivery then managed.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { grantSuiteCapability } from '../lib/test-target-lock';

grantSuiteCapability('unscoped-mutation');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const PICKUP = { lat: 6.8021, lng: -58.1561 };
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'mmg-claim-races-test');
const ref = (tag: string) => `R${RUN}${tag}`.toUpperCase();

let app: FastifyInstance;
let dispatch: DispatchService;
let customerId = '', customerToken = '';
let otherCustomerToken = '';
let vendorOwnerId = '', vendorToken = '', vendorId = '';
let adminToken = '';
let foreignAdminToken = '';
let riderUserId = '', riderToken = '';
const users: string[] = [];
const orderIds: string[] = [];
const FOREIGN_TENANT = `mmgrace${RUN.toLowerCase()}`;

type Service = typeof import('../modules/order/mmg-claim.service');
async function service(): Promise<Service> {
  return import('../modules/order/mmg-claim.service');
}

async function person(n: number, roles: string[], active: string, extra: Record<string, unknown> = {}, tenantId = 'swift-default') {
  const u = await runWithTenant(tenantId, () => app.prisma.user.create({ data: {
    phone: `+59263${NUM}${n}`, firstName: 'Race', lastName: `Claim${n}`, roles: roles as never, activeRole: active as never,
    countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, selfieCapturedAt: new Date(), tenantId, ...extra,
  } as never }));
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: active, jti: nanoid(8) });
  const session = await system(() => app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `mmg-race-${n}-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { id: u.id, token, sessionId: session.id };
}

async function mmgOrder(over: Record<string, unknown> = {}) {
  const order = await system(() => app.prisma.order.create({ data: {
    orderNumber: `MR${NUM}${nanoid(5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, customerId, vendorId,
    status: 'ACCEPTED', orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
    pickupAddress: 'Race Diner', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
    deliveryAddress: '1 Race St', deliveryLat: PICKUP.lat + 0.01, deliveryLng: PICKUP.lng + 0.01,
    paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING',
    mmgPayUrlSnapshot: 'https://pay.mmg.gy/checkout/race123', mmgRecipientNameSnapshot: 'Race Diner',
    subtotalBase: 3000, subtotalMarkup: 0, subtotalCustomer: 3000, deliveryFee: 500, tipAmount: 0, totalAmount: 3500,
    ...over,
  } as never }));
  orderIds.push(order.id);
  return order;
}

const json = { 'content-type': 'application/json' };
const confirm = (orderId: string, reference: string) => app.inject({ method: 'POST', url: `/api/v1/vendor/orders/${orderId}/confirm-payment`, payload: { reference }, headers: { ...json, authorization: `Bearer ${vendorToken}`, 'x-vendor-id': vendorId } });
const claim = (orderId: string, payload: Record<string, unknown>, token = customerToken) => app.inject({ method: 'POST', url: `/api/v1/customer/orders/${orderId}/payment-claim`, payload, headers: { ...json, authorization: `Bearer ${token}` } });
const resolve = (orderId: string, payload: Record<string, unknown>, token = adminToken) => app.inject({ method: 'POST', url: `/api/v1/admin/orders/${orderId}/payment-claim/resolve`, payload, headers: { ...json, authorization: `Bearer ${token}`, 'x-swift-reason': `Wallet statement reviewed for run ${RUN}` } });
const vendorStep = (orderId: string, step: 'preparing' | 'ready') => app.inject({ method: 'PUT', url: `/api/v1/vendor/orders/${orderId}/${step}`, payload: {}, headers: { ...json, authorization: `Bearer ${vendorToken}`, 'x-vendor-id': vendorId } });
const pickLine = (orderId: string, lineId: string) => app.inject({ method: 'PUT', url: `/api/v1/vendor/orders/${orderId}/items/${lineId}/picked`, payload: { picked: true }, headers: { ...json, authorization: `Bearer ${vendorToken}`, 'x-vendor-id': vendorId } });
const proposeSub = (orderId: string, lineId: string, substituteItemId: string) => app.inject({ method: 'POST', url: `/api/v1/vendor/orders/${orderId}/items/${lineId}/substitute`, payload: { substituteItemId }, headers: { ...json, authorization: `Bearer ${vendorToken}`, 'x-vendor-id': vendorId } });
const board = () => app.inject({ method: 'GET', url: '/api/v1/rider/orders/available', headers: { authorization: `Bearer ${riderToken}` } });
/** [R4 · F-PR1262-SOL-03] The ids the rider board lists. It answers
 *  `{ success, data: Order[] }`; any other shape fails here rather than
 *  reading as an empty board, so neither "not listed" nor "listed" can pass
 *  on a misread. */
async function boardIds(): Promise<string[]> {
  const res = await board();
  expect(res.statusCode, res.body).toBe(200);
  const listed: unknown = res.json().data;
  expect(Array.isArray(listed), `rider board shape: ${res.body.slice(0, 200)}`).toBe(true);
  return (listed as Array<{ id: string }>).map((o) => o.id);
}
const riderGrab = (orderId: string) => app.inject({ method: 'POST', url: `/api/v1/rider/orders/${orderId}/accept`, payload: {}, headers: { ...json, authorization: `Bearer ${riderToken}` } });
const customerView = (orderId: string) => app.inject({ method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { authorization: `Bearer ${customerToken}` } });
const row = (id: string) => system(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const audits = (id: string, action: string) => system(() => app.prisma.auditLog.count({ where: { entityId: id, action } }));
const outboxRows = (id: string) => system(() => app.prisma.orderOutbox.findMany({ where: { orderId: id, kind: 'mmg-claim-notice' }, orderBy: { createdAt: 'asc' } }));
const code = (res: { json: () => any }) => res.json().error?.code ?? res.json().code;

/** Poll the server's own view of its backends until one is WAITING on a lock
 *  inside a FOR UPDATE — the observable proof that the second command reached
 *  the row lock and is blocked there, not queued somewhere in the client. */
async function lockWaiterObserved(): Promise<boolean> {
  for (let i = 0; i < 120; i += 1) {
    const rows = await app.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%'`;
    if (Number(rows[0]?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Hold the first command right after its row lock, start the second, prove it
 *  waits on that lock, then let both finish. */
async function contended<A, B>(first: 'CUSTOMER' | 'STORE' | 'ADMIN' | 'PICK', a: () => Promise<A>, b: () => Promise<B>) {
  const { mmgClaimLockObserver } = await service();
  let holding!: () => void;
  const held = new Promise<void>((r) => { holding = r; });
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  let paused = false;
  mmgClaimLockObserver.afterLock = async ({ actor }) => {
    if (actor === first && !paused) { paused = true; holding(); await gate; }
  };
  try {
    const pa = a();
    await held;
    const pb = b();
    const waited = await lockWaiterObserved();
    open();
    const [ra, rb] = await Promise.all([pa, pb]);
    return { ra, rb, waited };
  } finally {
    open();
    delete mmgClaimLockObserver.afterLock;
  }
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();
  dispatch = new DispatchService(app.prisma, app.redis, app.io, new HaversineMapsProvider(), async () => {});

  const c = await person(1, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } });
  customerId = c.id; customerToken = c.token;
  otherCustomerToken = (await person(2, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } })).token;
  const v = await person(3, ['VENDOR_OWNER'], 'VENDOR_OWNER');
  vendorOwnerId = v.id; vendorToken = v.token;
  const owner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: vendorOwnerId, vendors: { create: {
    name: `Race Diner ${RUN}`, slug: `race-diner-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+59263${NUM}9`, addressLine1: '2 Race St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: PICKUP.lat, longitude: PICKUP.lng, status: 'ACTIVE', isVerified: true, acceptingOrders: true, isCurrentlyOpen: true,
  } } }, include: { vendors: true } }));
  vendorId = owner.vendors[0]!.id;
  adminToken = (await person(4, ['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', { admin: { create: { permissions: ['*'] } } })).token;
  await system(() => app.prisma.tenant.create({ data: { id: FOREIGN_TENANT, name: 'Race Elsewhere', slug: FOREIGN_TENANT } }));
  foreignAdminToken = (await person(5, ['ADMIN', 'CUSTOMER'], 'ADMIN', { admin: { create: { permissions: ['*'] } } }, FOREIGN_TENANT)).token;
  const r = await person(6, ['RIDER', 'CUSTOMER'], 'RIDER');
  riderUserId = r.id; riderToken = r.token;
  await system(() => app.prisma.rider.create({ data: {
    userId: riderUserId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit: 1_000_000,
    isOnline: true, isAvailable: true, locationSessionId: r.sessionId, currentLat: PICKUP.lat + 0.001, currentLng: PICKUP.lng + 0.001,
    lastLocationUpdate: new Date(), averageRating: 5, acceptanceRate: 100,
  } }));
});

afterEach(async () => {
  const { mmgClaimLockObserver } = await service().catch(() => ({ mmgClaimLockObserver: {} as Record<string, unknown> }));
  delete (mmgClaimLockObserver as Record<string, unknown>)['afterLock'];
  delete (mmgClaimLockObserver as Record<string, unknown>)['beforeCommit'];
});

afterAll(async () => {
  await system(async () => {
    for (const id of orderIds) {
      const keys = await app.redis.keys(`*${id}*`);
      if (keys.length) await app.redis.del(...keys);
    }
    if (orderIds.length) {
      await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
      await app.prisma.order.updateMany({ where: { id: { in: orderIds } }, data: { riderId: null } });
    }
    await app.prisma.rider.updateMany({ where: { userId: riderUserId }, data: { isOnline: false, isAvailable: false, currentOrderId: null } });
    if (orderIds.length) await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: users } } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    // Operator pages go to every SUPER_ADMIN in the database, not only ours.
    for (const id of orderIds) {
      await app.prisma.notification.deleteMany({ where: { data: { path: ['orderId'], equals: id } } });
      await app.prisma.notification.deleteMany({ where: { dedupeKey: { startsWith: `mmg-claim:${id}:` } } });
    }
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.prisma.tenant.deleteMany({ where: { id: FOREIGN_TENANT } });
  });
  await app.close();
});

// ===========================================================================
describe('both arrival orders end in the same durable disagreement', () => {
  it('customer denial FIRST, store claim second: both succeed, and the order is CLAIMED + held', async () => {
    const order = await mmgOrder();
    const denial = await claim(order.id, { paid: false });
    expect(denial.statusCode, denial.body).toBe(200);
    expect(denial.json().data).toMatchObject({ mismatch: false, paymentStatus: 'PENDING' });
    const store = await confirm(order.id, ref('A'));
    expect(store.statusCode, store.body).toBe(200);
    const after = await row(order.id);
    expect(after.paymentStatus).toBe('CLAIMED');
    expect(after.mmgClaimMismatchAt, 'current main leaves this null — the denial was never durable').not.toBeNull();
    expect(after.customerMmgClaim).toBe('NOT_PAID');
    expect(after.mmgClaimRevision).toBe(2);
    expect(await audits(order.id, 'MMG_CLAIM_MISMATCH')).toBe(1);
  });

  it('store claim FIRST, customer denial second: the same final state', async () => {
    const order = await mmgOrder();
    expect((await confirm(order.id, ref('B'))).statusCode).toBe(200);
    const denial = await claim(order.id, { paid: false });
    expect(denial.statusCode, denial.body).toBe(200);
    expect(denial.json().data).toMatchObject({ mismatch: true, paymentStatus: 'CLAIMED' });
    const after = await row(order.id);
    expect(after).toMatchObject({ paymentStatus: 'CLAIMED', customerMmgClaim: 'NOT_PAID', mmgClaimRevision: 2 });
    expect(after.mmgClaimMismatchAt).not.toBeNull();
  });

  it.each(['CUSTOMER', 'STORE'] as const)('CONTENDED, %s holds the row lock: the other waits on it, both commit, one disagreement', async (first) => {
    const order = await mmgOrder();
    const customerSide = () => claim(order.id, { paid: false });
    const storeSide = () => confirm(order.id, ref(`C${first[0]}`));
    const { ra, rb, waited } = first === 'CUSTOMER'
      ? await contended('CUSTOMER', customerSide, storeSide)
      : await contended('STORE', storeSide, customerSide);
    expect(waited, 'the second command must be observed waiting on the row lock').toBe(true);
    expect(ra.statusCode, ra.body).toBe(200);
    expect(rb.statusCode, rb.body).toBe(200);
    const after = await row(order.id);
    expect(after).toMatchObject({ paymentStatus: 'CLAIMED', customerMmgClaim: 'NOT_PAID', mmgClaimRevision: 2 });
    expect(after.mmgClaimMismatchAt).not.toBeNull();
    expect(await audits(order.id, 'MMG_CLAIM_MISMATCH')).toBe(1);
    const opened = (await outboxRows(order.id)).filter((o) => (o.payload as { effect?: string }).effect === 'DISAGREEMENT_OPENED');
    expect(opened).toHaveLength(1);
  });

  it.each([
    ['customer reference first', true],
    ['store reference first', false],
  ])('different references are a disagreement (%s); equivalent references are not', async (_label, customerFirst) => {
    const differ = await mmgOrder();
    if (customerFirst) {
      expect((await claim(differ.id, { paid: true, reference: ref('X1') })).statusCode).toBe(200);
      expect((await confirm(differ.id, ref('Y1'))).statusCode).toBe(200);
    } else {
      expect((await confirm(differ.id, ref('Y2'))).statusCode).toBe(200);
      expect((await claim(differ.id, { paid: true, reference: ref('X2') })).statusCode).toBe(200);
    }
    expect((await row(differ.id)).mmgClaimMismatchAt).not.toBeNull();
    const same = await mmgOrder();
    const r = ref(customerFirst ? 'S1' : 'S2');
    expect((await claim(same.id, { paid: true, reference: `  ${r.toLowerCase()} ` })).statusCode).toBe(200);
    expect((await confirm(same.id, r)).statusCode).toBe(200);
    const agreed = await row(same.id);
    expect(agreed.mmgClaimMismatchAt).toBeNull();
    expect(agreed.customerPaymentRef).toBe(r);
  });

  it('a duplicate claim from the same party changes nothing and announces nothing', async () => {
    const order = await mmgOrder();
    expect((await confirm(order.id, ref('D'))).statusCode).toBe(200);
    expect((await claim(order.id, { paid: false })).statusCode).toBe(200);
    const before = await row(order.id);
    const outboxBefore = (await outboxRows(order.id)).length;
    const again = await claim(order.id, { paid: false });
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ replayed: true, mismatch: true });
    const after = await row(order.id);
    expect(after.mmgClaimRevision).toBe(before.mmgClaimRevision);
    expect(after.customerMmgClaimAt).toEqual(before.customerMmgClaimAt);
    expect(await audits(order.id, 'CUSTOMER_CLAIMED_NOT_PAID')).toBe(1);
    expect((await outboxRows(order.id)).length).toBe(outboxBefore);
  });

  it('refusals leave no trace: another customer, a closed order, an unclaimable payment', async () => {
    const order = await mmgOrder();
    expect((await claim(order.id, { paid: false }, otherCustomerToken)).statusCode).toBe(404);
    const closed = await mmgOrder({ status: 'CANCELLED' });
    const refused = await claim(closed.id, { paid: false });
    expect(refused.statusCode).toBe(409);
    expect(code(refused)).toBe('ORDER_CLOSED');
    const failed = await mmgOrder({ paymentStatus: 'FAILED' });
    expect(code(await claim(failed.id, { paid: false }))).toBe('PAYMENT_NOT_CLAIMABLE');
    for (const id of [order.id, closed.id, failed.id]) {
      expect((await row(id)).customerMmgClaim).toBe('UNRECORDED');
      expect(await audits(id, 'CUSTOMER_CLAIMED_NOT_PAID')).toBe(0);
    }
  });
});

// ===========================================================================
describe('the database refuses the finding-6 end state outright', () => {
  it('CLAIMED + customer denial + no open disagreement + no covering decision is unrepresentable', async () => {
    const order = await mmgOrder({ paymentStatus: 'CLAIMED', mmgAttestedRef: ref('K') });
    await expect(system(() => app.prisma.$executeRaw`
      UPDATE "orders" SET "customerMmgClaim" = 'NOT_PAID', "customerMmgClaimAt" = now(), "mmgClaimRevision" = 1
      WHERE "id" = ${order.id}`)).rejects.toThrow(/chk_orders_mmg_disagreement_held/);
    await expect(system(() => app.prisma.$executeRaw`
      UPDATE "orders" SET "customerMmgClaim" = 'NOT_PAID', "customerMmgClaimAt" = NULL WHERE "id" = ${order.id}`))
      .rejects.toThrow(/chk_orders_customer_mmg_claim_shape/);
    const untouched = await row(order.id);
    expect(untouched.customerMmgClaim).toBe('UNRECORDED');
  });
});

// ===========================================================================
describe('an unresolved disagreement fails closed at every fulfilment boundary', () => {
  async function disputed(status = 'ACCEPTED') {
    const order = await mmgOrder({ status });
    expect((await claim(order.id, { paid: false })).statusCode).toBe(200);
    expect((await confirm(order.id, ref(`F${nanoid(3).toUpperCase().replace(/[^A-Z0-9]/g, 'Q')}`))).statusCode).toBe(200);
    expect((await row(order.id)).mmgClaimMismatchAt).not.toBeNull();
    return order;
  }

  it('vendor preparation and readiness are refused', async () => {
    const order = await disputed('ACCEPTED');
    const prep = await vendorStep(order.id, 'preparing');
    expect(prep.statusCode).toBe(409);
    expect(code(prep)).toBe('MMG_CLAIM_MISMATCH');
    const prepping = await disputed('PREPARING');
    expect(code(await vendorStep(prepping.id, 'ready'))).toBe('MMG_CLAIM_MISMATCH');
    expect((await row(prepping.id)).status).toBe('PREPARING');
  });

  it('the rider board does not list it, a direct claim is refused, and dispatch offers it to nobody', async () => {
    const order = await disputed('READY_FOR_PICKUP');
    expect(await boardIds()).not.toContain(order.id);
    const grab = await riderGrab(order.id);
    expect(grab.statusCode).toBe(409);
    expect((await row(order.id)).riderId).toBeNull();
    expect(await dispatch.dispatchOrder(order.id)).toEqual({});
    expect(await app.redis.get(`dispatch:offer:${order.id}`)).toBeNull();

    // Positive control: the SAME order, once an operator upholds the store's
    // claim, is listed and offered — so the refusals above were the dispute.
    const { mmgClaimRevision } = await row(order.id);
    const decided = await resolve(order.id, { resolution: 'CUSTOMER_PAID', note: 'Statement shows the transfer', expectedClaimRevision: mmgClaimRevision });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(await boardIds()).toContain(order.id);
    const offered = await dispatch.dispatchOrder(order.id);
    // Some online rider now holds the card (ours is ~150 m away; a leftover
    // online fixture from another suite may rank first — either proves it).
    expect(offered.offered).toBeTruthy();
  });
});

// ===========================================================================
describe('grocery picking and proposals commit under the claim authority\'s row lock [R2]', () => {
  let categoryId = '';
  async function groceryLine() {
    if (!categoryId) {
      categoryId = (await system(() => app.prisma.category.create({ data: { vendorId, name: `Aisles ${RUN}`, sortOrder: 0 } }))).id;
    }
    const substitute = await system(() => app.prisma.item.create({ data: {
      vendorId, categoryId, name: `Rice other brand ${RUN}`, basePrice: 1000, isAvailable: true, stockQuantity: 10,
    } }));
    const order = await mmgOrder({ orderType: 'GROCERY_DELIVERY', items: { create: [{
      itemId: `loose-${RUN}`, name: 'Rice 5kg', quantity: 1, basePrice: 1000, markedUpPrice: 1000, markupAmount: 0,
      totalBase: 1000, totalMarkup: 0, totalCustomer: 1000,
    }] } });
    expect((await confirm(order.id, ref(`G${nanoid(3).toUpperCase().replace(/[^A-Z0-9]/g, 'Q')}`))).statusCode).toBe(200);
    const [line] = await system(() => app.prisma.orderItem.findMany({ where: { orderId: order.id } }));
    return { order, lineId: line!.id, substituteId: substitute.id };
  }
  const lineOf = (lineId: string) => system(() => app.prisma.orderItem.findUniqueOrThrow({ where: { id: lineId } }));
  const COMMANDS = {
    pick: (g: Awaited<ReturnType<typeof groceryLine>>) => pickLine(g.order.id, g.lineId),
    propose: (g: Awaited<ReturnType<typeof groceryLine>>) => proposeSub(g.order.id, g.lineId, g.substituteId),
  } as const;
  const landed = (name: keyof typeof COMMANDS, line: { picked: boolean; subStatus: string }) =>
    (name === 'pick' ? line.picked : line.subStatus === 'PENDING');

  for (const name of Object.keys(COMMANDS) as Array<keyof typeof COMMANDS>) {
    it(`${name}: the customer denial holds the row first — the ${name} waits on it, then is refused`, async () => {
      const g = await groceryLine();
      const { ra: denial, rb: command, waited } = await contended('CUSTOMER', () => claim(g.order.id, { paid: false }), () => COMMANDS[name](g));
      expect(waited, 'the affirmative write reached the SAME row lock and waited on it').toBe(true);
      expect(denial.statusCode, denial.body).toBe(200);
      expect(denial.json().data).toMatchObject({ mismatch: true });
      expect(command.statusCode, command.body).toBe(409);
      expect(code(command)).toBe('MMG_CLAIM_MISMATCH');
      expect(landed(name, await lineOf(g.lineId)), 'no preparation after the dispute').toBe(false);
    });

    it(`${name}: the ${name} holds the row first — the denial waits, then records the dispute after it`, async () => {
      const g = await groceryLine();
      const { ra: command, rb: denial, waited } = await contended('PICK', () => COMMANDS[name](g), () => claim(g.order.id, { paid: false }));
      expect(waited, 'the denial reached the SAME row lock and waited on it').toBe(true);
      expect(command.statusCode, command.body).toBe(200);
      expect(denial.statusCode, denial.body).toBe(200);
      expect(denial.json().data).toMatchObject({ mismatch: true });
      expect(landed(name, await lineOf(g.lineId)), 'the preparation that preceded the dispute stands').toBe(true);
      expect((await row(g.order.id)).mmgClaimMismatchAt).not.toBeNull();
    });
  }
});

// ===========================================================================
describe('admin resolution: locked, revision-bound, atomic, idempotent', () => {
  async function openDispute() {
    const order = await mmgOrder();
    expect((await confirm(order.id, ref(`M${nanoid(3).toUpperCase().replace(/[^A-Z0-9]/g, 'Q')}`))).statusCode).toBe(200);
    expect((await claim(order.id, { paid: false })).statusCode).toBe(200);
    return { order, revision: (await row(order.id)).mmgClaimRevision as number };
  }

  it('the old request shape (no reviewed revision) is refused and changes nothing', async () => {
    const { order } = await openDispute();
    const res = await resolve(order.id, { resolution: 'CUSTOMER_PAID', note: 'Statement shows the transfer' });
    expect(res.statusCode).toBe(400);
    expect((await row(order.id)).mmgClaimMismatchAt).not.toBeNull();
  });

  it('one decision, retried: one resolution, one audit row, one durable event', async () => {
    const { order, revision } = await openDispute();
    const body = { resolution: 'CUSTOMER_DID_NOT_PAY', note: 'No transfer on the statement', expectedClaimRevision: revision };
    const first = await resolve(order.id, body);
    expect(first.statusCode, first.body).toBe(200);
    const again = await resolve(order.id, body);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data).toMatchObject({ replayed: true });
    const after = await row(order.id);
    expect(after).toMatchObject({ paymentStatus: 'PENDING', mmgClaimResolution: 'CUSTOMER_DID_NOT_PAY', mmgClaimRevision: revision + 1, mmgClaimResolvedRevision: revision + 1 });
    expect(after.mmgClaimMismatchAt).toBeNull();
    expect(after.mmgAttestedRef, 'the rejected attempt keeps its reference reserved').not.toBeNull();
    expect(await audits(order.id, 'ADMIN POST /api/v1/admin/orders/:id/payment-claim/resolve')).toBe(1);
    expect((await outboxRows(order.id)).filter((o) => (o.payload as { effect?: string }).effect === 'RESOLVED')).toHaveLength(1);
  });

  it('two different decisions on one generation, contended: exactly one winner', async () => {
    const { order, revision } = await openDispute();
    const { ra, rb, waited } = await contended('ADMIN',
      () => resolve(order.id, { resolution: 'CUSTOMER_PAID', note: 'Statement shows the transfer', expectedClaimRevision: revision }),
      () => resolve(order.id, { resolution: 'CUSTOMER_DID_NOT_PAY', note: 'No transfer on the statement', expectedClaimRevision: revision }));
    expect(waited).toBe(true);
    expect(ra.statusCode, ra.body).toBe(200);
    expect(rb.statusCode).toBe(409);
    expect(code(rb)).toBe('MMG_CLAIM_ALREADY_RESOLVED');
    expect((await row(order.id)).mmgClaimResolution).toBe('CUSTOMER_PAID');
    expect(await audits(order.id, 'ADMIN POST /api/v1/admin/orders/:id/payment-claim/resolve')).toBe(1);
  });

  it('a delayed decision against D0 cannot clear a newer dispute D1', async () => {
    const { order, revision } = await openDispute();
    expect((await resolve(order.id, { resolution: 'CUSTOMER_PAID', note: 'Statement shows the transfer', expectedClaimRevision: revision })).statusCode).toBe(200);
    expect((await claim(order.id, { paid: true })).statusCode).toBe(200);
    expect((await claim(order.id, { paid: false })).statusCode).toBe(200);
    const d1 = await row(order.id);
    expect(d1.mmgClaimMismatchAt, 'the changed statement opened D1').not.toBeNull();
    const stale = await resolve(order.id, { resolution: 'CUSTOMER_DID_NOT_PAY', note: 'Old screen, old dispute', expectedClaimRevision: revision });
    expect(stale.statusCode).toBe(409);
    expect(code(stale)).toBe('MMG_CLAIM_ALREADY_RESOLVED');
    const stale2 = await resolve(order.id, { resolution: 'CUSTOMER_DID_NOT_PAY', note: 'Old screen, old dispute', expectedClaimRevision: revision + 1 });
    expect(code(stale2)).toBe('MMG_CLAIM_STALE');
    expect((await row(order.id)).mmgClaimMismatchAt).toEqual(d1.mmgClaimMismatchAt);
  });

  it('a failure after the state, audit and obligation are staged rolls ALL of them back', async () => {
    const { order, revision } = await openDispute();
    const { mmgClaimLockObserver } = await service();
    mmgClaimLockObserver.beforeCommit = async ({ actor }) => { if (actor === 'ADMIN') throw new Error('injected: crash before COMMIT'); };
    const res = await resolve(order.id, { resolution: 'CUSTOMER_PAID', note: 'Statement shows the transfer', expectedClaimRevision: revision });
    delete mmgClaimLockObserver.beforeCommit;
    expect(res.statusCode).toBe(500);
    const after = await row(order.id);
    expect(after.mmgClaimMismatchAt).not.toBeNull();
    expect(after).toMatchObject({ mmgClaimResolution: null, mmgClaimRevision: revision });
    expect(await audits(order.id, 'ADMIN POST /api/v1/admin/orders/:id/payment-claim/resolve')).toBe(0);
    expect((await outboxRows(order.id)).filter((o) => (o.payload as { effect?: string }).effect === 'RESOLVED')).toHaveLength(0);
    // …and the same decision then succeeds cleanly.
    expect((await resolve(order.id, { resolution: 'CUSTOMER_PAID', note: 'Statement shows the transfer', expectedClaimRevision: revision })).statusCode).toBe(200);
  });

  it('a failure inside the customer command rolls back the claim, its evidence and its obligation', async () => {
    const order = await mmgOrder();
    expect((await confirm(order.id, ref('RB'))).statusCode).toBe(200);
    const { mmgClaimLockObserver } = await service();
    mmgClaimLockObserver.beforeCommit = async ({ actor }) => { if (actor === 'CUSTOMER') throw new Error('injected: crash before COMMIT'); };
    const res = await claim(order.id, { paid: false });
    delete mmgClaimLockObserver.beforeCommit;
    expect(res.statusCode).toBe(500);
    const after = await row(order.id);
    expect(after).toMatchObject({ customerMmgClaim: 'UNRECORDED', mmgClaimMismatchAt: null, mmgClaimRevision: 1 });
    expect(await audits(order.id, 'CUSTOMER_CLAIMED_NOT_PAID')).toBe(0);
    expect((await outboxRows(order.id)).filter((o) => (o.payload as { effect?: string }).effect === 'DISAGREEMENT_OPENED')).toHaveLength(0);
  });

  it('an operator of ANOTHER tenant cannot see or decide this dispute', async () => {
    const { order, revision } = await openDispute();
    const res = await resolve(order.id, { resolution: 'CUSTOMER_PAID', note: 'Statement shows the transfer', expectedClaimRevision: revision }, foreignAdminToken);
    expect(res.statusCode).toBe(404);
    expect((await row(order.id)).mmgClaimMismatchAt).not.toBeNull();
  });
});

// ===========================================================================
describe('a rejected attempt stays rejected, and the customer is told the truth', () => {
  it('the store cannot revive it, the pay link is withdrawn, and cancellation remains open', async () => {
    const order = await mmgOrder();
    const attempt = ref('RJ');
    expect((await confirm(order.id, attempt)).statusCode).toBe(200);
    expect((await claim(order.id, { paid: false })).statusCode).toBe(200);
    const { mmgClaimRevision } = await row(order.id);
    expect((await resolve(order.id, { resolution: 'CUSTOMER_DID_NOT_PAY', note: 'No transfer on the statement', expectedClaimRevision: mmgClaimRevision })).statusCode).toBe(200);
    for (const reference of [attempt, ref('RK')]) {
      const revive = await confirm(order.id, reference);
      expect(revive.statusCode).toBe(409);
      expect(code(revive)).toBe('MMG_ATTEMPT_REJECTED');
    }
    expect((await row(order.id)).paymentStatus).toBe('PENDING');
    const view = await customerView(order.id);
    expect(view.statusCode).toBe(200);
    expect(view.json().data.paymentAction).toBeNull();
    expect(view.json().data.mmgClaim).toMatchObject({ attemptRejected: true, resolution: 'CUSTOMER_DID_NOT_PAY', disputed: false });
    const cancel = await app.inject({ method: 'POST', url: `/api/v1/customer/orders/${order.id}/cancel`, payload: { reason: 'store never received it' }, headers: { ...json, authorization: `Bearer ${customerToken}` } });
    expect(cancel.statusCode, cancel.body).toBe(200);
  });
});

// ===========================================================================
describe('durable notices', () => {
  it('opening a dispute leaves a processed obligation and deduplicated inbox rows; replaying the job adds nothing', async () => {
    const order = await mmgOrder();
    expect((await confirm(order.id, ref('N'))).statusCode).toBe(200);
    expect((await claim(order.id, { paid: false })).statusCode).toBe(200);
    const obligations = await outboxRows(order.id);
    const opened = obligations.find((o) => (o.payload as { effect?: string }).effect === 'DISAGREEMENT_OPENED');
    expect(opened, 'the obligation committed with the dispute').toBeTruthy();
    expect(opened!.processedAt, 'the request delivered it immediately').not.toBeNull();
    const keyed = await system(() => app.prisma.notification.findMany({ where: { dedupeKey: { startsWith: `mmg-claim:${order.id}:` } }, select: { userId: true, dedupeKey: true } }));
    expect(keyed.map((n) => n.dedupeKey)).toEqual(expect.arrayContaining([
      `mmg-claim:${order.id}:r2:customer`, `mmg-claim:${order.id}:r2:business`, `mmg-claim:${order.id}:r2:admin`,
    ]));
    const { runMmgClaimNoticeJob } = await service();
    const { NotificationService } = await import('../modules/notification/notification.service');
    await runMmgClaimNoticeJob({ prisma: app.prisma, notifications: new NotificationService(app.prisma, app.io) }, opened!.payload as Record<string, unknown>);
    const again = await system(() => app.prisma.notification.count({ where: { dedupeKey: { startsWith: `mmg-claim:${order.id}:` } } }));
    expect(again).toBe(keyed.length);
  });

  it('[R2] the queue publisher leaves an owed notice alone; the sweep drain delivers it once and consumes it', async () => {
    const order = await mmgOrder();
    expect((await confirm(order.id, ref('Q'))).statusCode).toBe(200);
    expect((await claim(order.id, { paid: false })).statusCode).toBe(200);
    const opened = (await outboxRows(order.id)).find((o) => (o.payload as { effect?: string }).effect === 'DISAGREEMENT_OPENED');
    expect(opened).toBeTruthy();
    // As if the request's own delivery had not finished.
    await system(() => app.prisma.orderOutbox.update({ where: { id: opened!.id }, data: { processedAt: null, claimedAt: null, availableAt: new Date(Date.now() - 1_000) } }));
    const published: string[] = [];
    const queue = { add: async (name: string) => { published.push(name); return {}; } };
    const { drainCheckoutOutbox } = await import('../modules/order/checkout-outbox');
    await drainCheckoutOutbox(
      { prisma: app.prisma, queues: { orderQueue: queue, notificationQueue: queue, dispatchQueue: queue } as never, log: { info: () => undefined, warn: () => undefined, error: () => undefined } },
      { orderIds: [order.id] },
    );
    expect(published, 'the real claim statement skips the kind').not.toContain('mmg-claim-notice');
    expect((await system(() => app.prisma.orderOutbox.findUniqueOrThrow({ where: { id: opened!.id } }))).processedAt).toBeNull();
    const inboxBefore = await system(() => app.prisma.notification.count({ where: { dedupeKey: { startsWith: `mmg-claim:${order.id}:` } } }));
    const { drainMmgClaimNotices } = await service();
    const { NotificationService } = await import('../modules/notification/notification.service');
    const drained = await drainMmgClaimNotices({ prisma: app.prisma, notifications: new NotificationService(app.prisma, app.io) }, { limit: 200 });
    expect(drained.delivered).toBeGreaterThanOrEqual(1);
    const after = await system(() => app.prisma.orderOutbox.findUniqueOrThrow({ where: { id: opened!.id } }));
    expect(after.processedAt, 'delivered, so consumed').not.toBeNull();
    expect(after.attempts).toBe(opened!.attempts + 1);
    expect(await system(() => app.prisma.notification.count({ where: { dedupeKey: { startsWith: `mmg-claim:${order.id}:` } } })), 'nobody told twice').toBe(inboxBefore);
  });

  it('the customer order view carries the claim projection', async () => {
    const order = await mmgOrder();
    expect((await claim(order.id, { paid: true, reference: ref('P') })).statusCode).toBe(200);
    const view = await customerView(order.id);
    expect(view.json().data.mmgClaim).toMatchObject({ customerClaim: 'PAID', storeClaimed: false, disputed: false, canClaim: true, revision: 1 });
  });
});

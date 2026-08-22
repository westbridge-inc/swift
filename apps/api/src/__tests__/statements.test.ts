import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { riderRoutes } from '../modules/rider/rider.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { statementRoutes } from '../modules/order/statement.routes';
import { signStatementToken } from '../modules/order/statement';

// ---------------------------------------------------------------------------
// Statements (marketplace §12, the receipt's siblings): earner earnings and
// vendor sales as print-ready HTML, derived from the ledger on demand.
// Scoping is the point — your statement, never someone else's.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let riderToken: string;
let vendorToken: string;
let riderId: string;
let vendorId: string;
const userIds: string[] = [];
const orderIds: string[] = [];
const earningIds: string[] = [];
let ownerId: string;
const marker = nanoid(6).toLowerCase();

async function makeUser(roles: string[], activeRole: string) {
  const u = await app.prisma.user.create({
    data: {
      phone: `+59259${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'State', lastName: 'Ment',
      roles: roles as never[], activeRole: activeRole as never,
      isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  });
  userIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: u.id, token, refreshToken: nanoid(48),
      deviceId: 'stmt-test', deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });
  return { user: u, token };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(statementRoutes, { prefix: '/api/v1/statements' });
  await app.ready();

  // Rider with two earnings on one order.
  const r = await makeUser(['MOVER'], 'MOVER');
  riderToken = r.token;
  const rider = await app.prisma.rider.create({
    data: { userId: r.user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' },
  });
  riderId = rider.id;

  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');

  // Vendor with one completed order.
  const v = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  vendorToken = v.token;
  const owner = await app.prisma.vendorOwner.create({ data: { userId: v.user.id } });
  ownerId = owner.id;
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Statement Diner ${marker}`,
      slug: `stmt-${marker}`,
      vendorType: 'RESTAURANT',
      phone: '+5926999333',
      addressLine1: '3 Ledger Lane', city: 'Georgetown', region: 'Demerara',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', isVerified: true,
    },
  });
  vendorId = vendor.id;

  const order = await app.prisma.order.create({
    data: {
      orderNumber: `STM-${marker}`,
      orderType: 'FOOD_DELIVERY' as never,
      customerId: customer.user.id,
      vendorId,
      riderId,
      status: 'DELIVERED' as never,
      fulfillment: 'DELIVERY' as never,
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 5000, subtotalMarkup: 0, subtotalCustomer: 5000,
      discount: 500, deliveryFee: 600, tipAmount: 200, totalAmount: 5300,
      paymentMethod: 'CASH' as never,
    },
  });
  orderIds.push(order.id);

  for (const [type, amount] of [['DELIVERY_FEE', 600], ['TIP', 200]] as const) {
    const e = await app.prisma.earning.create({
      data: { riderId, orderId: order.id, type: type as never, amount },
    });
    earningIds.push(e.id);
  }
});

afterAll(async () => {
  if (earningIds.length > 0) await app.prisma.earning.deleteMany({ where: { id: { in: earningIds } } });
  if (orderIds.length > 0) await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  if (vendorId) await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  if (ownerId) await app.prisma.vendorOwner.deleteMany({ where: { id: ownerId } });
  if (riderId) await app.prisma.rider.deleteMany({ where: { id: riderId } });
  if (userIds.length > 0) {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('earner statement', () => {
  it('renders the rider earnings as print-ready HTML with the honest total', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/rider/earnings/statement',
      headers: { authorization: `Bearer ${riderToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain(`STM-${marker}`);
    expect(res.body).toContain('delivery fee');
    expect(res.body).toContain('$800 GYD'); // 600 fee + 200 tip
    expect(res.body).toContain('100% of every fee');
  });

  it('a rider outside the period sees an empty statement, not an error', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/rider/earnings/statement?from=2020-01-01&to=2020-01-31',
      headers: { authorization: `Bearer ${riderToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Nothing in this period');
  });
});

describe('vendor sales statement', () => {
  it('renders completed sales: items minus own promo discount, fees excluded', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/vendor/sales-statement',
      headers: { authorization: `Bearer ${vendorToken}`, 'x-vendor-id': vendorId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain(`STM-${marker}`);
    expect(res.body).toContain('$4,500 GYD'); // 5000 items − 500 discount; fee+tip excluded
    expect(res.body).toContain('flat weekly subscription');
  });

  it('the statement is scoped: the rider token cannot read the vendor statement', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/vendor/sales-statement',
      headers: { authorization: `Bearer ${riderToken}` },
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe('signed statement links (share/print)', () => {
  it('?link=1 mints a short-lived URL that renders the SAME statement without a JWT', async () => {
    const mint = await app.inject({
      method: 'GET', url: '/api/v1/rider/earnings/statement?link=1',
      headers: { authorization: `Bearer ${riderToken}` },
    });
    expect(mint.statusCode).toBe(200);
    const { path, expiresInSeconds } = mint.json().data;
    expect(expiresInSeconds).toBeGreaterThan(0);

    const rendered = await app.inject({ method: 'GET', url: path }); // NO auth header
    expect(rendered.statusCode).toBe(200);
    expect(rendered.headers['content-type']).toContain('text/html');
    expect(rendered.body).toContain(`STM-${marker}`);
    expect(rendered.body).toContain('$800 GYD');
  });

  it('a tampered signature is refused; an expired link is 410', async () => {
    const mint = await app.inject({
      method: 'GET', url: '/api/v1/rider/earnings/statement?link=1',
      headers: { authorization: `Bearer ${riderToken}` },
    });
    const path: string = mint.json().data.path;

    // [F-027-10] The tamper must stay INSIDE the hex alphabet, or the schema
    // rejects it before the signature check and the test stops proving that
    // the signature is what refuses it.
    const tampered = path.replace(/sig=([0-9a-f])/, (_m, c: string) => `sig=${c === '0' ? '1' : '0'}`);
    expect(tampered).not.toBe(path);
    expect((await app.inject({ method: 'GET', url: tampered })).statusCode).toBe(403);

    const expired = path.replace(/expires=\d+/, 'expires=1000000000');
    expect((await app.inject({ method: 'GET', url: expired })).statusCode).toBe(410);
  });

  // -------------------------------------------------------------------------
  // [F-027-10] The signature protocol itself.
  // -------------------------------------------------------------------------
  it('a 32-CHARACTER but 64-BYTE signature is refused — the constant-time path cannot be steered around', async () => {
    // `.length(32)` counted UTF-16 code units while Buffer.from() produces
    // UTF-8 bytes, so 32 'é' passed the schema as a 64-byte buffer and the
    // byte-length guard returned before timingSafeEqual ever ran. The accepted
    // input domain is now exactly 32 hex characters, i.e. exactly 32 bytes.
    const mint = await app.inject({
      method: 'GET', url: '/api/v1/rider/earnings/statement?link=1',
      headers: { authorization: `Bearer ${riderToken}` },
    });
    const path: string = mint.json().data.path;
    const wideChars = path.replace(/sig=[0-9a-f]{32}/, `sig=${'é'.repeat(32)}`);
    const res = await app.inject({ method: 'GET', url: wideChars });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).not.toBe(200);
  });

  it('the signed material is UNAMBIGUOUS — two tuples that used to collide now sign differently', () => {
    // Plain colon concatenation signed `statement:rider:A:B:C:D:1` for BOTH
    // (actor="A:B", from="C", to="D") and (actor="A", from="B:C", to="D").
    // Length-prefixing each field makes that impossible to parse two ways.
    const a = signStatementToken('rider', 'A:B', 'C', 'D', 1);
    const b = signStatementToken('rider', 'A', 'B:C', 'D', 1);
    expect(a).not.toBe(b);

    // And a few more shapes, so this is a property rather than one example.
    expect(signStatementToken('rider', '', 'A:B', 'C', 1)).not.toBe(signStatementToken('rider', 'A', 'B', 'C', 1));
    expect(signStatementToken('rider', 'A:', 'B', 'C', 1)).not.toBe(signStatementToken('rider', 'A', ':B', 'C', 1));
  });

  it('signatures are still deterministic and exactly 32 hex characters', () => {
    const sig = signStatementToken('driver', 'actor-1', '2026-01-01', '2026-01-31', 1735689600);
    expect(sig).toBe(signStatementToken('driver', 'actor-1', '2026-01-01', '2026-01-31', 1735689600));
    expect(sig).toMatch(/^[0-9a-f]{32}$/);
  });
});

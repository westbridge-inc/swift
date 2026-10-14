import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { setAppLogger } from '../utils/logger';
import { osrmOutcomeCounter } from '../plugins/observability';
import { calculateDeliveryFee, deliveryFeeFromRates, DEFAULT_DELIVERY_RATES } from '../utils/markup';
import { billableDistance } from '../utils/billable-distance';
import { renderReceiptHtml } from '../modules/order/receipt';

// ---------------------------------------------------------------------------
// Owner decision 18 (13 Oct 2026): when road routing (OSRM) is down, food and
// shop deliveries keep flowing on the straight-line estimate (× road factor),
// NEVER below the 500 base fee, and it is logged. Taxis keep refusing (#1555).
//
// What already held, proven here end to end with OSRM unreachable: the quote,
// the charged fee, the frozen distance and its engine, the receipt and the
// rider's earning all agree and sit at or above the base fee. What is new: the
// floor is explicit in the formula (a bad per-km rate or a surge below 1 can no
// longer price under it), and a structured line names every fallback-priced
// delivery beside the existing fallback counter and its alarm.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const STORE = { lat: 6.8010, lng: -58.1560 };

let app: FastifyInstance;
let seq = 0;
const phoneBase = 592_340_000_000 + Math.floor(Math.random() * 800_000_000);
const userIds: string[] = [];
let vendorId = '';
let dishId = '';
const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
const savedEnv = { provider: process.env['MAPS_PROVIDER'], url: process.env['OSRM_URL'] };

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Floor', lastName: `F${seq}`, roles, activeRole, isPhoneVerified: true,
      selfieCapturedAt: new Date(), ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'floor', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

const inject = (method: 'GET' | 'POST', url: string, token: string, payload?: Record<string, unknown>) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
});

const fallbackCount = async () => (await osrmOutcomeCounter.get()).values.find((v) => v.labels['op'] === 'route' && v.labels['outcome'] === 'fallback')?.value ?? 0;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  // Road routing configured, and DOWN: nothing listens on port 9.
  process.env['MAPS_PROVIDER'] = 'osrm';
  process.env['OSRM_URL'] = 'http://127.0.0.1:9';
  const record = (msg: unknown, obj?: unknown) => { if (typeof obj === 'string' && msg && typeof msg === 'object') lines.push({ obj: msg as Record<string, unknown>, msg: obj }); };
  setAppLogger({ info: (o: unknown, m?: unknown) => record(o, m), warn: (o: unknown, m?: unknown) => record(o, m), error: () => {}, debug: () => {} } as never);
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Floor Kitchen', slug: `floor-kitchen-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5926997766',
      addressLine1: '7 Robb Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: STORE.lat, longitude: STORE.lng,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0, deliveryRadius: 25,
    },
  });
  vendorId = vendor.id;
  const cat = await app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } });
  dishId = (await app.prisma.item.create({ data: { vendorId, categoryId: cat.id, name: 'Pepperpot', basePrice: 1500, isAvailable: true } })).id;
});

afterAll(async () => {
  setAppLogger(console);
  if (savedEnv.provider === undefined) delete process.env['MAPS_PROVIDER']; else process.env['MAPS_PROVIDER'] = savedEnv.provider;
  if (savedEnv.url === undefined) delete process.env['OSRM_URL']; else process.env['OSRM_URL'] = savedEnv.url;
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.address.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId } });
  await app.prisma.category.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[owner #18] the formula never prices under the base fee', () => {
  it('any distance from zero up costs at least the base fee', () => {
    for (const km of [0, 0.01, 0.4, 2.99, 3, 3.01, 7.5]) expect(calculateDeliveryFee(km)).toBeGreaterThanOrEqual(DEFAULT_DELIVERY_RATES.baseFee);
  });

  it('a bad per-km rate or a surge below 1 in a market config cannot price under it', () => {
    expect(deliveryFeeFromRates(8, { ...DEFAULT_DELIVERY_RATES, perKmRate: -100 })).toBe(500);
    expect(deliveryFeeFromRates(1, { ...DEFAULT_DELIVERY_RATES, surgeMultiplier: 0.5 })).toBe(500);
    // Above the base the schedule is unchanged: 500 + 2 km × 100.
    expect(deliveryFeeFromRates(5, DEFAULT_DELIVERY_RATES)).toBe(700);
  });
});

describe('[owner #18] routing down: deliveries keep flowing at or above the base fee, marked and logged', () => {
  it('quote, charge, frozen distance, receipt and rider earning agree — and the fallback is named', async () => {
    const before = await fallbackCount();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    // A drop a few hundred metres away: inside the first 3 km.
    await app.prisma.address.create({ data: { userId: customer.userId, label: 'Home', addressLine1: '1 Camp Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: STORE.lat + 0.003, longitude: STORE.lng, isDefault: true } });
    const add = await inject('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId: dishId, quantity: 1 });
    expect([200, 201], add.body).toContain(add.statusCode);

    const quote = await inject('GET', '/api/v1/customer/cart', customer.token);
    expect(quote.statusCode, quote.body).toBe(200);
    expect(Number(quote.json().data.deliveryFee)).toBe(500);

    lines.length = 0;
    const placed = await inject('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'DELIVERY' } });
    expect(placed.statusCode, placed.body).toBe(200);
    const orderId = (placed.json().data.orders ?? [placed.json().data.order])[0].id as string;
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: orderId } });

    // The charge equals the quote, at the base fee; the distance is frozen and SAYS it was estimated.
    expect(Number(order.deliveryFee)).toBe(500);
    expect(order.billableKmSource).toBe('haversine');
    expect(billableDistance(order)?.source).toBe('haversine');
    // The rider's earning on this job is the delivery fee (plus any tip): the same 500.
    expect(Number(order.deliveryFee) + Number(order.tipAmount)).toBeGreaterThanOrEqual(500);
    const html = renderReceiptHtml({ ...(order as never as Record<string, unknown>), status: 'DELIVERED', vendor: { name: 'Floor Kitchen', addressLine1: '7 Robb Street', city: 'Georgetown', phone: '' }, customer: { firstName: 'Floor', lastName: 'F' }, items: [] } as never);
    expect(html).toContain('Distance (estimated)');

    // Observable: the counter moved, and one structured line names the delivery.
    expect(await fallbackCount()).toBeGreaterThan(before);
    const named = lines.filter((l) => l.msg === 'delivery:fee-fallback');
    expect(named).toHaveLength(1);
    expect(named[0]!.obj).toMatchObject({ vendorId, source: 'haversine', deliveryFee: 500, baseFee: 500 });
  });
});

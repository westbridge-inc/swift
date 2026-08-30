import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { billableDistance, roundBillableKm, canonicalBillableKm } from '../utils/billable-distance';
import { deliveryFeeFromRates, expressDeliveryFee } from '../utils/markup';
import { CountryConfigService } from '../modules/country/country-config.service';
import { HaversineMapsProvider, OsrmMapsProvider } from '../providers/maps/maps-provider';
import { renderReceiptHtml } from '../modules/order/receipt';

// ---------------------------------------------------------------------------
// [ALG-18 · ALG-INV-1] Billable-distance canonicalization.
//
// Today the fee was priced from a quote-time distance that was then thrown
// away: nothing on the order said how far the trip was priced at, or by which
// engine. A dispute a month later could not be answered; a receipt could not
// state it; an earnings sentence (ALG-21) had nothing to read.
//
// Now the number is decided once, frozen on the order with its source, and
// read through ONE function. This file is the replay: for every order placed
// through checkout, the fee on the row IS the fee schedule applied to the
// frozen distance — feeDistance == receiptDistance, not a spot check.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+59200656';
const STORE = { lat: 6.8010, lng: -58.1560 };

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`, firstName: 'Km', lastName: `User${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/km.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'km', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

async function makeShop(ownerUserId: string) {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Kilometre Kitchen', slug: `km-kitchen-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}98`, addressLine1: '7 Robb Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng, deliveryRadius: 25,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Mains', sortOrder: 0 } });
  const dish = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: 'Cook-up', basePrice: 1200 } });
  return { vendorId: vendor.id, dish };
}

function inject(method: 'GET' | 'POST', url: string, payload: unknown, token: string) {
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}

let shop: Awaited<ReturnType<typeof makeShop>>;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const orphans = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  if (orphans.length) {
    const ids = orphans.map((u) => u.id);
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: ids } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    const voIds = vos.map((v) => v.id);
    await app.prisma.item.deleteMany({ where: { vendor: { ownerId: { in: voIds } } } });
    await app.prisma.category.deleteMany({ where: { vendor: { ownerId: { in: voIds } } } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: voIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: voIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  shop = await makeShop(owner.userId);
});

afterAll(async () => {
  if (createdUserIds.length) {
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: createdUserIds } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  }
  if (createdVendorIds.length) {
    await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  }
  if (createdUserIds.length) {
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('one reader, one rounding', () => {
  it('reads the frozen distance with its engine, and labels both for a person', () => {
    expect(billableDistance({ orderType: 'FOOD_DELIVERY', billableKm: '2.14', billableKmSource: 'osrm' })).toEqual({ km: 2.14, source: 'osrm', label: '2.1 km', sourceLabel: 'routed' });
    expect(billableDistance({ orderType: 'FOOD_DELIVERY', billableKm: 2.16, billableKmSource: 'haversine' })).toMatchObject({ label: '2.2 km', sourceLabel: 'estimated' });
  });

  it('a legacy taxi row reads its taxiDistance, and says it was recorded', () => {
    expect(billableDistance({ orderType: 'TAXI', billableKm: null, taxiDistance: 5.5 })).toEqual({ km: 5.5, source: 'legacy', label: '5.5 km', sourceLabel: 'recorded' });
  });

  it('unknown is null — a pickup, an old order, a nonsense value — never zero', () => {
    expect(billableDistance({ orderType: 'FOOD_DELIVERY' })).toBeNull();
    expect(billableDistance({ orderType: 'FOOD_DELIVERY', billableKm: 0 })).toBeNull();
    expect(billableDistance({ orderType: 'FOOD_DELIVERY', billableKm: 'far' })).toBeNull();
    expect(billableDistance({ orderType: 'FOOD_DELIVERY', billableKm: -1, billableKmSource: 'osrm' })).toBeNull();
  });

  it('the priced number is canonical at 0.01 km — pricing from a finer number than the one frozen was the drift', () => {
    expect(canonicalBillableKm(2.147)).toBe(2.15);
    expect(canonicalBillableKm(2.144)).toBe(2.14);
  });

  it('rounding is declared once: one decimal, half up', () => {
    expect(roundBillableKm(2.05)).toBe(2.1);
    expect(roundBillableKm(2.04)).toBe(2);
    expect(roundBillableKm(12.349)).toBe(12.3);
  });
});

describe('every route estimate names its engine', () => {
  it('haversine says so; an OSRM that cannot be reached falls back and says haversine, not osrm', async () => {
    const h = await new HaversineMapsProvider().routeKm(STORE, { lat: 6.81, lng: -58.16 });
    expect(h.source).toBe('haversine');
    const o = await new OsrmMapsProvider('http://127.0.0.1:9').routeKm(STORE, { lat: 6.81, lng: -58.16 });
    expect(o.source).toBe('haversine');
    expect(o.km).toBe(h.km);
  });
});

describe('[ALG-INV-1] the replay: the fee on every order is the schedule applied to its frozen distance', () => {
  const DROPS = [
    { lat: 6.8000, lng: -58.1500 }, { lat: 6.8100, lng: -58.1700 }, { lat: 6.7900, lng: -58.1300 },
    { lat: 6.8200, lng: -58.1900 }, { lat: 6.8050, lng: -58.1580 }, { lat: 6.7700, lng: -58.1200 },
  ];

  it('six deliveries at six distances, one of them express', async () => {
    const rates = await new CountryConfigService(app.prisma).getDeliveryRates('GY');
    for (const [i, drop] of DROPS.entries()) {
      const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
      await app.prisma.address.create({ data: { userId: customer.userId, label: 'Home', addressLine1: `${i} Camp Street`, city: 'Georgetown', region: 'Demerara-Mahaica', latitude: drop.lat, longitude: drop.lng, isDefault: true } });
      const add = await inject('POST', '/api/v1/customer/cart/items', { vendorId: shop.vendorId, itemId: shop.dish.id, quantity: 1 }, customer.token);
      expect([200, 201], add.body).toContain(add.statusCode);
      const express = i === 3;
      const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [shop.vendorId]: 'DELIVERY' }, ...(express ? { express: true } : {}) }, customer.token);
      expect([200, 201], res.body).toContain(res.statusCode);
      const created = res.json().data?.orders ?? [res.json().data?.order ?? res.json().data];
      const order = await app.prisma.order.findUniqueOrThrow({ where: { id: created[0].id } });

      const frozen = billableDistance(order);
      expect(frozen, 'the distance is frozen on the order').not.toBeNull();
      // The engine is whichever the API resolved — OSRM when the local
      // container is up, haversine otherwise — and the row SAYS which.
      expect(['osrm', 'haversine']).toContain(frozen!.source);
      expect(order.billableKmSource).toBe(frozen!.source);
      // THE identity. The row's fee is the schedule applied to the row's distance.
      const expected = express ? expressDeliveryFee(deliveryFeeFromRates(frozen!.km, rates)) : deliveryFeeFromRates(frozen!.km, rates);
      expect(Number(order.deliveryFee), `order ${i}: fee ↔ frozen distance`).toBe(expected);
      // And the receipt states the same number, with its engine.
      const html = renderReceiptHtml({ ...(order as any), status: 'DELIVERED', vendor: { name: 'Kilometre Kitchen', addressLine1: '7 Robb Street', city: 'Georgetown', phone: '' }, customer: { firstName: 'Km', lastName: 'User' }, items: [] });
      expect(html).toContain(`Distance (${frozen!.source === 'osrm' ? 'routed' : 'estimated'})`);
      expect(html).toContain(`${frozen!.label}`);
    }
  });

  it('the cart quote and the charge are the same fee — the preview prices the canonical number too', async () => {
    // 6.81,-58.17 is the address whose raw kilometres carried a third decimal:
    // priced raw the quote said one fee and the frozen number said another.
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.address.create({ data: { userId: customer.userId, label: 'Home', addressLine1: '9 Camp Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.17, isDefault: true } });
    await inject('POST', '/api/v1/customer/cart/items', { vendorId: shop.vendorId, itemId: shop.dish.id, quantity: 1 }, customer.token);
    const quote = await inject('GET', '/api/v1/customer/cart', undefined, customer.token);
    expect(quote.statusCode, quote.body).toBe(200);
    const quotedFee = Number(quote.json().data.deliveryFee);
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [shop.vendorId]: 'DELIVERY' } }, customer.token);
    expect([200, 201], res.body).toContain(res.statusCode);
    const created = res.json().data?.orders ?? [res.json().data?.order ?? res.json().data];
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: created[0].id } });
    expect(Number(order.deliveryFee), 'quote ↔ charge').toBe(quotedFee);
  });

  it('a pickup freezes nothing, and its receipt has no distance line', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.address.create({ data: { userId: customer.userId, label: 'Home', addressLine1: '1 Main Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, isDefault: true } });
    await inject('POST', '/api/v1/customer/cart/items', { vendorId: shop.vendorId, itemId: shop.dish.id, quantity: 1 }, customer.token);
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [shop.vendorId]: 'PICKUP' } }, customer.token);
    expect([200, 201], res.body).toContain(res.statusCode);
    const created = res.json().data?.orders ?? [res.json().data?.order ?? res.json().data];
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: created[0].id } });
    expect(order.billableKm).toBeNull();
    expect(order.billableKmSource).toBeNull();
    expect(billableDistance(order)).toBeNull();
    const html = renderReceiptHtml({ ...(order as any), vendor: null, customer: null, items: [] });
    expect(html).not.toContain('Distance (');
  });
});

describe('every rail freezes the distance it priced from (source pins)', () => {
  const src = (rel: string) => readFileSync(path.join(__dirname, '..', rel), 'utf8');
  it('checkout, courier and taxi all write billableKm with its source', () => {
    expect(src('modules/order/order.service.ts')).toContain("billableKmSource: plan.distanceKm > 0 ? plan.distanceSource : null");
    expect(src('modules/courier/courier.routes.ts')).toContain('billableKm: distanceKm,\n          billableKmSource: source,');
    expect(src('modules/rides/rides.service.ts')).toContain('billableKm: estimate.billableKm,\n        billableKmSource: estimate.routeSource,');
  });
  it('the receipt reads the distance through the one reader, never the column', () => {
    const receipt = src('modules/order/receipt.ts');
    expect(receipt).toContain("import { billableDistance } from '../../utils/billable-distance';");
    expect(receipt).not.toMatch(/order\.billableKm\b/);
  });
});

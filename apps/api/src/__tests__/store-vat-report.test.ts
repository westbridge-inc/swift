import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5 · PR4] The store's VAT report, end to end on a real database.
//   - made ONLY from the VAT each order froze (the figures its receipt prints): an order without VAT, a cancelled
//     order and another store's order never count;
//   - each order counts on the GUYANA day the store supplied the goods (delivered, or completed at the counter);
//   - the store's OWNER asks for it (a manager is refused); the period is whole Guyana days, at most 92;
//   - it says who files: the store's accountant, never Swift.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const RUN = wordFreeTag(6);
const VAT_NUMBER = '012345678';
let app: FastifyInstance;
const userIds: string[] = [];
const vendorIds: string[] = [];
let ownerToken = '';
let managerToken = '';
let customer = { userId: '', token: '' };
let vendorId = '';
let otherVendorId = '';
const orderIds: Record<string, string> = {};

async function session(userId: string, role: string) {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `vat-report-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return token;
}
const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

async function user(roles: UserRole[], activeRole: UserRole, extra: Record<string, unknown> = {}) {
  const u = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Vat', lastName: `Report${userIds.length}`, roles, activeRole, isPhoneVerified: true, countryCode: 'GY', ...extra,
  } });
  userIds.push(u.id);
  return u;
}

async function store(ownerUserId: string, name: string) {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const v = await app.prisma.vendor.create({ data: {
    ownerId: vo.id, name: `${name} ${RUN}`, slug: `vat-report-${RUN}-${vendorIds.length}`, vendorType: 'SUPERMARKET',
    phone: testPhone(), addressLine1: '1 Report St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
    vatRegistrationNumber: VAT_NUMBER, vatStatus: 'APPROVED', vatMode: 'PRICES_INCLUDE_VAT', vatApprovedNumber: VAT_NUMBER,
    vatApprovedName: `${name} Ltd`, vatEffectiveFrom: new Date('2026-01-01T00:00:00Z'),
  } });
  vendorIds.push(v.id);
  return v.id;
}

/** An order inserted in its final state (an INSERT is not judged by the status trigger), with the VAT it froze. */
async function order(key: string, forVendor: string, o: {
  status: 'DELIVERED' | 'COMPLETED' | 'CANCELLED'; deliveredAt?: Date; completedAt?: Date; placedAt: Date;
  vat: null | { base: number; vat: number; zero: number; exempt: number };
}) {
  const goods = o.vat ? o.vat.base + o.vat.zero + o.vat.exempt : 1500;
  const row = await app.prisma.order.create({ data: {
    orderNumber: `VR-${RUN}-${key}`, orderType: 'GROCERY_DELIVERY' as never, customerId: customer.userId, vendorId: forVendor,
    status: o.status as never, fulfillment: (o.completedAt ? 'PICKUP' : 'DELIVERY') as never, placedAt: o.placedAt,
    ...(o.deliveredAt ? { deliveredAt: o.deliveredAt } : {}),
    deliveryAddress: '2 Buyer St', deliveryLat: 6.8, deliveryLng: -58.15,
    subtotalBase: goods, subtotalMarkup: 0, subtotalCustomer: goods, deliveryFee: 0, serviceFee: 0, taxAmount: 0, tipAmount: 0, discount: 0,
    totalAmount: goods, paymentMethod: 'CASH' as never, paymentStatus: 'CAPTURED' as never,
    ...(o.vat ? {
      vatRateBps: 1400, vatAmount: o.vat.vat, vatBase: o.vat.base, vatStandardGoods: o.vat.base, vatZeroRatedGoods: o.vat.zero,
      vatExemptGoods: o.vat.exempt, vatSellerNumber: VAT_NUMBER, vatSellerName: 'Report Shop Ltd',
    } : {}),
    items: { create: [{
      itemId: `vat-report-item-${key}`, name: `Goods ${key}`, quantity: 1, basePrice: goods, markedUpPrice: goods, markupAmount: 0,
      totalBase: goods, totalMarkup: 0, totalCustomer: goods, ...(o.vat ? { vatClass: 'STANDARD' as never } : {}),
    }] },
    ...(o.completedAt ? { statusHistory: { create: [{ status: 'COMPLETED' as never, createdAt: o.completedAt, note: 'Collected at the counter' }] } } : {}),
  } });
  orderIds[key] = row.id;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const owner = await user(['VENDOR_OWNER'] as UserRole[], 'VENDOR_OWNER' as UserRole, { selfieCapturedAt: new Date() });
  ownerToken = await session(owner.id, 'VENDOR_OWNER');
  vendorId = await store(owner.id, 'Report Shop');
  const manager = await user(['CUSTOMER'] as UserRole[], 'CUSTOMER' as UserRole);
  await app.prisma.vendorStaff.create({ data: { vendorId, userId: manager.id, role: 'MANAGER', invitedBy: owner.id } });
  managerToken = await session(manager.id, 'CUSTOMER');
  const otherOwner = await user(['VENDOR_OWNER'] as UserRole[], 'VENDOR_OWNER' as UserRole);
  otherVendorId = await store(otherOwner.id, 'Other Shop');
  const cust = await user(['CUSTOMER'] as UserRole[], 'CUSTOMER' as UserRole, { selfieCapturedAt: new Date(), customer: { create: {} } });
  customer = { userId: cust.id, token: await session(cust.id, 'CUSTOMER') };

  const placed = new Date('2026-02-27T15:00:00Z');
  // 02:00 UTC on 1 March is 22:00 on 28 February in Guyana: the supply day is 28 February.
  await order('a', vendorId, { status: 'DELIVERED', deliveredAt: new Date('2026-03-01T02:00:00Z'), placedAt: placed, vat: { base: 1000, vat: 123, zero: 600, exempt: 0 } });
  // Collected at the counter on 2 March (no delivery time): the COMPLETED moment is the supply day.
  await order('b', vendorId, { status: 'COMPLETED', completedAt: new Date('2026-03-02T15:00:00Z'), placedAt: new Date('2026-03-02T13:00:00Z'), vat: { base: 2280, vat: 280, zero: 0, exempt: 500 } });
  // Never counted: cancelled, no VAT frozen, another store's, and outside the period.
  await order('cancelled', vendorId, { status: 'CANCELLED', placedAt: new Date('2026-03-05T13:00:00Z'), vat: { base: 1140, vat: 140, zero: 0, exempt: 0 } });
  await order('novat', vendorId, { status: 'DELIVERED', deliveredAt: new Date('2026-03-06T15:00:00Z'), placedAt: new Date('2026-03-06T13:00:00Z'), vat: null });
  await order('other', otherVendorId, { status: 'DELIVERED', deliveredAt: new Date('2026-03-07T15:00:00Z'), placedAt: new Date('2026-03-07T13:00:00Z'), vat: { base: 1140, vat: 140, zero: 0, exempt: 0 } });
  // [REVIEW-M #2109 S4] Two COMPLETED log rows (a re-completion): the supply day is the FIRST (27 Feb), so a March report
  // must not take it in although its second row falls in March.
  await order('twice', vendorId, { status: 'COMPLETED', completedAt: new Date('2026-02-27T15:00:00Z'), placedAt: new Date('2026-02-27T13:00:00Z'), vat: { base: 1140, vat: 140, zero: 0, exempt: 0 } });
  await app.prisma.orderStatusLog.create({ data: { orderId: orderIds['twice']!, status: 'COMPLETED' as never, createdAt: new Date('2026-03-03T15:00:00Z'), note: 'Completed again' } });
  await order('april', vendorId, { status: 'DELIVERED', deliveredAt: new Date('2026-04-01T05:00:00Z'), placedAt: new Date('2026-04-01T03:00:00Z'), vat: { base: 1140, vat: 140, zero: 0, exempt: 0 } });
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: Object.values(orderIds) } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[O-5 PR4] the store’s VAT report', () => {
  it('February 28 to March 31: only this store’s supplied VAT orders, by the Guyana day of supply', async () => {
    const res = await get('/api/v1/vendor/vat/report?from=2026-02-28&to=2026-03-31', ownerToken);
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.days.map((d: { day: string }) => d.day)).toEqual(['2026-02-28', '2026-03-02']);
    expect(data.totals).toEqual({ orders: 2, standardRatedInclVat: 3280, vatCharged: 403, standardRatedExclVat: 2877, zeroRatedSales: 600, exemptSales: 500 });
    expect(data.orders.map((o: { orderNumber: string }) => o.orderNumber)).toEqual([`VR-${RUN}-a`, `VR-${RUN}-b`]);
    expect(data.returnLines.map((l: { line: number; amount: number }) => [l.line, l.amount])).toEqual([[15, 600], [16, 500], [17, 2877], [18, 403]]);
    expect(data.prepared).toBe('Prepared from your Swift orders. Your accountant files your VAT return; Swift does not file it for you.');
    // The seller as each order froze it (a number changed mid-period would show as a second line).
    expect(data).toMatchObject({ from: '2026-02-28', to: '2026-03-31', sellers: [{ name: 'Report Shop Ltd', vatNumber: VAT_NUMBER, orders: 2 }] });
  });

  it('an order counts once, on its FIRST completion: a later completion row inside the period does not pull it in', async () => {
    const res = await get('/api/v1/vendor/vat/report?from=2026-03-01&to=2026-03-31', ownerToken);
    expect((res.json().data.orders as Array<{ orderNumber: string }>).map((o) => o.orderNumber)).not.toContain(`VR-${RUN}-twice`);
    const feb = await get('/api/v1/vendor/vat/report?from=2026-02-27&to=2026-02-27', ownerToken);
    expect((feb.json().data.orders as Array<{ orderNumber: string }>).map((o) => o.orderNumber)).toEqual([`VR-${RUN}-twice`]);
  });

  it('a Guyana day, not a UTC day: from 1 March leaves out the order delivered at 22:00 on 28 February', async () => {
    const res = await get('/api/v1/vendor/vat/report?from=2026-03-01&to=2026-03-31', ownerToken);
    expect(res.json().data.totals).toMatchObject({ orders: 1, vatCharged: 280 });
  });

  it('each order’s figures are the ones its receipt prints', async () => {
    const res = await get('/api/v1/vendor/vat/report?from=2026-02-28&to=2026-03-31', ownerToken);
    const listed = (res.json().data.orders as Array<{ orderId: string; vatCharged: number; standardRatedInclVat: number }>).find((o) => o.orderId === orderIds['a']);
    const receipt = await get(`/api/v1/customer/orders/${orderIds['a']}/receipt`, customer.token);
    expect(receipt.statusCode, receipt.body).toBe(200);
    expect(receipt.body).toMatch(new RegExp(`VAT included \\(14%\\)</td><td class="num">[^<]*${listed!.vatCharged}[^<]*</td>`));
    expect(receipt.body).toMatch(new RegExp(`Standard-rated goods[^<]*\\(incl\\. VAT\\)</td><td class="num">[^<]*1,000[^<]*</td>`));
    expect(listed!.standardRatedInclVat).toBe(1000);
  });

  it('the store’s OWNER only: a manager is refused', async () => {
    const res = await get('/api/v1/vendor/vat/report?from=2026-03-01&to=2026-03-31', managerToken);
    expect(res.statusCode, res.body).toBe(403);
  });

  it('a period of whole Guyana days, at most 92, start before end', async () => {
    for (const q of ['from=2026-03-31&to=2026-03-01', 'from=2026-01-01&to=2026-06-30', 'from=2026-3-1&to=2026-03-31', 'to=2026-03-31']) {
      const res = await get(`/api/v1/vendor/vat/report?${q}`, ownerToken);
      expect(res.statusCode, `${q}: ${res.body}`).toBe(400);
    }
  });
});

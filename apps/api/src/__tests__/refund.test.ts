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
import { classifyRefund, computeRefund } from '../utils/refund';
import { allocateAcrossLines } from '../utils/order-total';

// ---------------------------------------------------------------------------
// [ALG-25] Refund computation — constrained by law before maths. Swift holds
// no order money, so the algorithm's first job is to say WHICH of three
// things a "refund" is, and only then how much. The MMG guard is never
// weakened: an MMG refund is computed for the record and marked not
// executable, with the guard's own words.
// ---------------------------------------------------------------------------

const lines = (rows: Array<[number, boolean, string?]>) => rows.map(([totalCustomer, affected, subStatus]) => ({ totalCustomer, affected, subStatus: subStatus ?? null }));

describe('which of the three refunds it is', () => {
  it('cash before handover is the only one Swift can execute', () => {
    expect(classifyRefund({ paymentMethod: 'CASH', status: 'PREPARING' })).toBe('CASH_PRE_HANDOVER');
    expect(classifyRefund({ paymentMethod: 'CASH', status: 'DELIVERED' })).toBe('CASH_POST_HANDOVER');
    expect(classifyRefund({ paymentMethod: 'CASH', status: 'COMPLETED' })).toBe('CASH_POST_HANDOVER');
    expect(classifyRefund({ paymentMethod: 'MOBILE_MONEY', status: 'PREPARING' })).toBe('MMG_BLOCKED');
    expect(classifyRefund({ paymentMethod: 'MOBILE_MONEY', status: 'DELIVERED' })).toBe('MMG_BLOCKED');
  });
});

describe('item-level partials', () => {
  const base = { paymentMethod: 'CASH', status: 'DELIVERED', deliveryFee: 500, discount: 0, totalAmount: 4800, deliveryHappened: true };

  it('the returned lines, and nothing else, when the delivery happened', () => {
    const r = computeRefund({ ...base, lines: lines([[1200, true], [3100, false]]) });
    expect(r).toMatchObject({ kind: 'CASH_POST_HANDOVER', executable: false, lineTotal: 1200, discountShare: 0, deliveryFee: 0, amount: 1200 });
    expect(r.sentence).toBe('The store owes the customer GY$1,200: GY$1,200 for the returned items. Swift records this; the store and customer settle it directly.');
  });

  it('a basket discount is shared proportionally — the customer is not refunded money they never paid', () => {
    // 4,300 of goods, 430 off (10%). Returning the 1,200 line carries 120 of that discount.
    const r = computeRefund({ ...base, discount: 430, totalAmount: 4370, lines: lines([[1200, true], [3100, false]]) });
    expect(r).toMatchObject({ lineTotal: 1200, discountShare: 120, amount: 1080 });
    expect(r.sentence).toContain('less GY$120 of the discount they carried');
  });

  it('the delivery fee comes back only if the delivery did not happen — the rider’s time is real either way', () => {
    const happened = computeRefund({ ...base, lines: lines([[4300, true]]) });
    expect(happened.deliveryFee).toBe(0);
    expect(happened.amount).toBe(4300);
    const never = computeRefund({ ...base, status: 'PREPARING', deliveryHappened: false, lines: lines([[4300, true]]) });
    expect(never).toMatchObject({ kind: 'CASH_PRE_HANDOVER', executable: true, deliveryFee: 500, amount: 4800 });
    expect(never.sentence).toMatch(/^GY\$4,800 comes off what is collected at the door/);
    expect(never.sentence).toContain('plus the GY$500 delivery fee, because the delivery did not happen');
  });

  it('lines already refunded or rejected at picking carry no money to return', () => {
    const r = computeRefund({ ...base, lines: lines([[1200, true, 'REFUNDED'], [3100, true, 'REJECTED'], [500, true]]) });
    expect(r.lineTotal).toBe(500);
  });

  it('never negative, never more than what was paid', () => {
    expect(computeRefund({ ...base, totalAmount: 1000, lines: lines([[4300, true]]) }).amount).toBe(1000);
    expect(computeRefund({ ...base, discount: 9_999, lines: lines([[1200, true]]) }).amount).toBe(0);
    expect(computeRefund({ ...base, lines: [] }).amount).toBe(0);
  });
});

describe('[M-33] the refund consumes the snapshot, never an aggregate inference', () => {
  const base = { paymentMethod: 'CASH', status: 'DELIVERED', deliveryFee: 500, totalAmount: 4300, deliveryHappened: true };
  const twoLines = (kettle: boolean, fan: boolean) => [
    { id: 'K', totalCustomer: 1200, affected: kettle },
    { id: 'F', totalCustomer: 3100, affected: fan },
  ];

  it('the register’s red test: a full goods return after FREE_DELIVERY refunds every goods dollar and no delivery fee — the old inference under-refunded by the fee', () => {
    const freeDelivery = { goodsDiscount: 0, deliveryDiscount: 500, funder: 'PLATFORM', discountType: 'FREE_DELIVERY', lineAllocations: [{ orderItemId: 'K', goods: 0 }, { orderItemId: 'F', goods: 0 }] };
    const r = computeRefund({ ...base, discount: 500, lines: twoLines(true, true), snapshot: freeDelivery });
    expect(r).toMatchObject({ basis: 'SNAPSHOT', funder: 'PLATFORM', lineTotal: 4300, discountShare: 0, deliveryFee: 0, amount: 4300 });
    expect(r.sentence).toBe('The store owes the customer GY$4,300: GY$4,300 for the returned items. Swift records this; the store and customer settle it directly.');
    // the dual calculation: what the aggregate inference would have said
    expect(r.inferredAmount).toBe(3800);
  });

  it('a discounted fee was never paid: when the delivery did not happen, nothing of it comes back', () => {
    const freeDelivery = { goodsDiscount: 0, deliveryDiscount: 500, funder: 'PLATFORM', discountType: 'FREE_DELIVERY', lineAllocations: null };
    const r = computeRefund({ ...base, status: 'PREPARING', deliveryHappened: false, discount: 500, lines: twoLines(true, true), snapshot: freeDelivery });
    expect(r).toMatchObject({ kind: 'CASH_PRE_HANDOVER', deliveryFee: 0, amount: 4300, basis: 'SNAPSHOT' });
    const halfOff = computeRefund({ ...base, status: 'PREPARING', deliveryHappened: false, discount: 200, totalAmount: 4600, lines: twoLines(true, true), snapshot: { ...freeDelivery, deliveryDiscount: 200 } });
    expect(halfOff.deliveryFee).toBe(300);
  });

  it('a returned line carries ITS OWN goods share from the allocation — exact, not proportional — and the sentence names the funder', () => {
    const platform = { goodsDiscount: 430, deliveryDiscount: 0, funder: 'PLATFORM', discountType: 'FIXED_AMOUNT', lineAllocations: [{ orderItemId: 'K', goods: 200 }, { orderItemId: 'F', goods: 230 }] };
    const kettle = computeRefund({ ...base, discount: 430, totalAmount: 4370, lines: twoLines(true, false), snapshot: platform });
    expect(kettle).toMatchObject({ basis: 'SNAPSHOT', lineTotal: 1200, discountShare: 200, amount: 1000, funder: 'PLATFORM' });
    expect(kettle.sentence).toContain('less GY$200 of the discount they carried (funded by Swift)');
    expect(kettle.inferredAmount).toBe(1080); // the proportional guess
    const vendor = computeRefund({ ...base, discount: 430, totalAmount: 4370, lines: twoLines(true, true), snapshot: { ...platform, funder: 'VENDOR', discountType: 'PERCENTAGE' } });
    expect(vendor).toMatchObject({ discountShare: 430, amount: 3870, funder: 'VENDOR' });
    expect(vendor.sentence).toContain('(funded by the store)');
  });

  it('a snapshot without line shares falls back to the GOODS component in proportion — never the delivery component', () => {
    const mixed = { goodsDiscount: 100, deliveryDiscount: 330, funder: 'PLATFORM', discountType: 'FIXED_AMOUNT', lineAllocations: null };
    const r = computeRefund({ ...base, discount: 430, totalAmount: 4370, lines: twoLines(true, false), snapshot: mixed });
    expect(r.discountShare).toBe(28); // round(100 × 1200 / 4300)
    expect(r.amount).toBe(1172);
  });

  it('no snapshot: a discounted order is INFERRED and says so; an undiscounted order is NONE', () => {
    const inferred = computeRefund({ ...base, discount: 430, totalAmount: 4370, lines: twoLines(true, false) });
    expect(inferred).toMatchObject({ basis: 'INFERRED', discountShare: 120, amount: 1080, inferredAmount: 1080, funder: null });
    expect(inferred.sentence).toContain('INFERRED from the order’s total discount (no component record) — review before settling');
    const none = computeRefund({ ...base, discount: 0, lines: twoLines(true, false) });
    expect(none).toMatchObject({ basis: 'NONE', discountShare: 0, amount: 1200 });
    expect(none.sentence).not.toContain('INFERRED');
  });

  it('allocateAcrossLines: shares sum exactly to the amount, largest remainder first, zero when there is nothing to share', () => {
    expect(allocateAcrossLines(430, [{ id: 'K', amount: 1200 }, { id: 'F', amount: 3100 }])).toEqual([{ id: 'K', share: 120 }, { id: 'F', share: 310 }]);
    expect(allocateAcrossLines(100, [{ id: 'a', amount: 1 }, { id: 'b', amount: 1 }, { id: 'c', amount: 1 }])).toEqual([{ id: 'a', share: 34 }, { id: 'b', share: 33 }, { id: 'c', share: 33 }]);
    expect(allocateAcrossLines(0, [{ id: 'a', amount: 500 }])).toEqual([{ id: 'a', share: 0 }]);
    expect(allocateAcrossLines(50, [{ id: 'a', amount: 0 }, { id: 'b', amount: 0 }])).toEqual([{ id: 'a', share: 0 }, { id: 'b', share: 0 }]);
    for (const amount of [1, 7, 99, 430, 4299, 4300]) {
      const shares = allocateAcrossLines(amount, [{ id: 'K', amount: 1200 }, { id: 'F', amount: 3100 }, { id: 'S', amount: 1 }]);
      expect(shares.reduce((s, x) => s + x.share, 0)).toBe(amount);
    }
  });
});

describe('MMG stays blocked — computed for the record, never executable', () => {
  it('names the guard’s own words and moves nothing', () => {
    const r = computeRefund({ paymentMethod: 'MOBILE_MONEY', status: 'DELIVERED', deliveryFee: 500, discount: 0, totalAmount: 4800, deliveryHappened: true, lines: lines([[1200, true], [3100, false]]) });
    expect(r).toMatchObject({ kind: 'MMG_BLOCKED', executable: false, amount: 1200 });
    expect(r.sentence).toBe('GY$1,200 would be due (GY$1,200 for the returned items), but MMG totals cannot change in-app — the store settles it with the customer directly until in-app MMG adjustments arrive.');
  });

  it('the picking guard is untouched — this never weakened it', () => {
    const picking = readFileSync(path.join(__dirname, '..', 'modules', 'order', 'picking.service.ts'), 'utf8');
    expect(picking).toContain("if (order.paymentMethod !== 'MOBILE_MONEY') return;");
    expect(picking).toContain("'MMG_ADJUSTMENT_UNAVAILABLE'");
    expect(picking).not.toContain('computeRefund');
  });
});

describe('POST /customer/orders/:id/return records what the algorithm said', () => {
  const PHONE_PREFIX = '+59200660';
  const DAY = 24 * 60 * 60 * 1000;
  let app: FastifyInstance;
  const userIds: string[] = [];
  let vendorId: string;

  async function purge() {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (!ids.length) return;
    await app.prisma.returnRequest.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: ids } } });
    const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: vos.map((v) => v.id) } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: vos.map((v) => v.id) } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  async function customer(n: number) {
    const u = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}${String(n).padStart(2, '0')}`, firstName: 'Ret', lastName: `C${n}`, roles: ['CUSTOMER' as UserRole], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } } });
    userIds.push(u.id);
    const token = app.jwt.sign({ userId: u.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({ data: { authMethod: 'OTP', userId: u.id, token, refreshToken: nanoid(40), deviceId: 'ret', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    return { id: u.id, token };
  }

  async function deliveredOrder(customerId: string, paymentMethod: 'CASH' | 'MOBILE_MONEY') {
    return app.prisma.order.create({
      data: {
        orderNumber: `RT-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, status: 'DELIVERED', fulfillment: 'DELIVERY',
        pickupAddress: 'Store', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'Home', deliveryLat: 6.81, deliveryLng: -58.16,
        subtotalBase: 4300, subtotalMarkup: 0, subtotalCustomer: 4300, deliveryFee: 500, discount: 430, totalAmount: 4370, paymentMethod,
        items: { create: [
          { itemId: nanoid(10), name: 'Kettle', quantity: 1, basePrice: 1200, markedUpPrice: 1200, markupAmount: 0, totalBase: 1200, totalMarkup: 0, totalCustomer: 1200 },
          { itemId: nanoid(10), name: 'Fan', quantity: 1, basePrice: 3100, markedUpPrice: 3100, markupAmount: 0, totalBase: 3100, totalMarkup: 0, totalCustomer: 3100 },
        ] },
      },
    });
  }

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
    await purge();
    const ownerUser = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}90`, firstName: 'Ret', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    userIds.push(ownerUser.id);
    const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
    vendorId = (await app.prisma.vendor.create({ data: { ownerId: owner.id, name: 'Return Store', slug: `return-store-${nanoid(5)}`, vendorType: 'STORE', phone: `${PHONE_PREFIX}91`, addressLine1: '1 Return Rd', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE' } })).id;
  });

  afterAll(async () => {
    await purge();
    await app.close();
  });

  it('a delivered CASH retail order: the store owes the customer the goods less their discount, never the delivery fee', async () => {
    const c = await customer(1);
    const order = await deliveredOrder(c.id, 'CASH');
    const res = await app.inject({ method: 'POST', url: `/api/v1/customer/orders/${order.id}/return`, payload: { reason: 'The kettle arrived cracked' }, headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' } });
    expect(res.statusCode, res.body).toBe(201);
    const row = res.json().data;
    expect(row.refundKind).toBe('CASH_POST_HANDOVER');
    expect(Number(row.refundAmount)).toBe(4300 - 430); // every line, the whole discount, no delivery fee
    expect(row.refundSentence).toContain('The store owes the customer GY$3,870');
    // [M-33] No snapshot on this legacy-shaped order: the number is the
    // inference, and it is MARKED so — never silently used as truth.
    expect(row.refundBasis).toBe('INFERRED');
    expect(row.refundSentence).toContain('INFERRED');
    expect(Number(row.refundInferredAmount)).toBe(3870);
    const stored = await app.prisma.returnRequest.findFirstOrThrow({ where: { orderId: order.id } });
    expect(stored.refundKind).toBe('CASH_POST_HANDOVER');
    expect(stored.refundBasis).toBe('INFERRED');
  });

  it('a delivered MMG retail order: computed for the record, marked blocked', async () => {
    const c = await customer(2);
    const order = await deliveredOrder(c.id, 'MOBILE_MONEY');
    const res = await app.inject({ method: 'POST', url: `/api/v1/customer/orders/${order.id}/return`, payload: { reason: 'Wrong size, unopened' }, headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.refundKind).toBe('MMG_BLOCKED');
    expect(res.json().data.refundSentence).toContain('MMG totals cannot change in-app');
    // Nothing on the order moved.
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { totalAmount: true, status: true } });
    expect(Number(after.totalAmount)).toBe(4370);
    expect(after.status).toBe('DELIVERED');
  });
});

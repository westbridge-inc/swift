import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { aggregateSalesComponents, orderComponents, sumComponents } from '../modules/billing/sales-components';
import { computeDigest, generateSalesDigests, recomputeLegacyDigests } from '../modules/billing/sales-digest';
import { buildVendorStatement } from '../modules/order/statement';
import { salesComponentsCounter } from '../plugins/observability';
import { startOfWeekGY } from '../utils/time-gy';

// ---------------------------------------------------------------------------
// [M-38] Vendor statement subtracts every promo from goods sales.
//
// The register's red test: each promo component / funder against the
// canonical ledger. A vendor's own promotion is the only discount that
// reduces its sales; a platform-funded goods discount is money Swift owes the
// vendor; a free delivery is the rider's fee gap, never the vendor's goods;
// a legacy order without a snapshot is split conservatively and MARKED
// estimated. The statement and the weekly digest emit the separated columns;
// legacy digests are recomputed as versioned adjustments.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const DAY = 86_400_000; const WEEK = 7 * DAY;
const PHONE_BASE = 592_012_000_000 + Math.floor(Math.random() * 8_000_000);
const userIds: string[] = []; const vendorIds: string[] = []; const orderIds: string[] = []; const promoIds: string[] = [];
let customerId: string; let seq = 0;
const thisMonday = () => startOfWeekGY(new Date());
const lastWeek = () => new Date(thisMonday().getTime() - WEEK);

async function makeVendor() {
  seq += 1;
  const owner = await prisma.user.create({ data: { phone: `+${PHONE_BASE + seq}`, firstName: 'Comp', lastName: `V${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
  userIds.push(owner.id);
  const vo = await prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await prisma.vendor.create({ data: { ownerId: vo.id, name: `Components Vendor ${seq}`, slug: `components-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+${PHONE_BASE + 600_000 + seq}`, addressLine1: '1 Ledger St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE' } });
  vendorIds.push(vendor.id);
  return vendor.id;
}
async function promo(funder: 'PLATFORM' | 'VENDOR', vendorId?: string) {
  const p = await prisma.promoCode.create({ data: { code: `SC${nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, description: 'components', discountType: 'FIXED_AMOUNT', discountValue: 100, applicableTo: [], validFrom: new Date(Date.now() - DAY), validUntil: new Date(Date.now() + DAY), funder, ...(vendorId ? { vendorId } : {}) } });
  promoIds.push(p.id);
  return p.id;
}
/** A completed sale in the last complete week: gross goods, a separate discount, fee + tip, and optionally a redemption snapshot. */
async function sale(vendorId: string, o: { goods: number; discount?: number; fee?: number; tip?: number; snapshot?: { funder: 'PLATFORM' | 'VENDOR'; goodsDiscount: number; deliveryDiscount: number; promoId: string } }) {
  const discount = o.discount ?? 0;
  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', fulfillment: o.fee ? 'DELIVERY' : 'PICKUP', customerId, vendorId, status: 'COMPLETED',
      deliveryAddress: 'counter', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: o.goods, subtotalMarkup: 0, subtotalCustomer: o.goods, deliveryFee: o.fee ?? 0, tipAmount: o.tip ?? 0, discount,
      totalAmount: o.goods + (o.fee ?? 0) + (o.tip ?? 0) - discount, paymentMethod: 'CASH', placedAt: new Date(lastWeek().getTime() + DAY), pickupAddress: 'store', pickupLat: 6.8, pickupLng: -58.15,
      ...(o.snapshot ? { promoCodeId: o.snapshot.promoId, promoRedemption: { create: { promoCodeId: o.snapshot.promoId, termsVersion: 1, discountType: 'FIXED_AMOUNT', discountValue: 100, funder: o.snapshot.funder, goodsDiscount: o.snapshot.goodsDiscount, deliveryDiscount: o.snapshot.deliveryDiscount, tipDiscount: 0 } } } : {}),
    },
  });
  orderIds.push(order.id);
  await prisma.orderStatusLog.create({ data: { orderId: order.id, status: 'COMPLETED', note: 'test', createdAt: new Date(lastWeek().getTime() + DAY) } });
  return order.id;
}

beforeAll(async () => {
  await prisma.$connect();
  const customer = await prisma.user.create({ data: { phone: `+${PHONE_BASE + 900}`, firstName: 'Comp', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } } });
  userIds.push(customer.id); customerId = customer.id;
});
afterAll(async () => {
  await prisma.settlement.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.promoCode.deleteMany({ where: { id: { in: promoIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('the law (pure): each promo component and funder', () => {
  const base = { subtotalCustomer: 3000, discount: 0, deliveryFee: 500, tipAmount: 200, promoRedemption: null };
  it('platform goods discount: the vendor keeps every goods dollar — Swift owes the discount; the customer paid less', () => {
    expect(orderComponents({ ...base, discount: 500, promoRedemption: { goodsDiscount: 500, deliveryDiscount: 0, funder: 'PLATFORM' } }))
      .toEqual({ goodsSales: 3000, vendorPromoDiscount: 0, sponsorReceivable: 500, customerCollection: 2500, feeFunding: 0, moverPayable: 700, estimated: false });
  });
  it("vendor goods discount: the vendor's own promotion reduces its sales, nothing is owed", () => {
    expect(orderComponents({ ...base, discount: 300, promoRedemption: { goodsDiscount: 300, deliveryDiscount: 0, funder: 'VENDOR' } }))
      .toEqual({ goodsSales: 3000, vendorPromoDiscount: 300, sponsorReceivable: 0, customerCollection: 2700, feeFunding: 0, moverPayable: 700, estimated: false });
  });
  it("free delivery: nothing touches the vendor's goods — the fee gap is platform fee funding, the rider's money", () => {
    expect(orderComponents({ ...base, discount: 500, promoRedemption: { goodsDiscount: 0, deliveryDiscount: 500, funder: 'PLATFORM' } }))
      .toEqual({ goodsSales: 3000, vendorPromoDiscount: 0, sponsorReceivable: 0, customerCollection: 3000, feeFunding: 500, moverPayable: 700, estimated: false });
  });
  it('legacy (no snapshot): the discount is counted as the vendor’s own — the conservative reading — and MARKED estimated; no discount is not estimated', () => {
    expect(orderComponents({ ...base, discount: 400 })).toEqual({ goodsSales: 3000, vendorPromoDiscount: 400, sponsorReceivable: 0, customerCollection: 2600, feeFunding: 0, moverPayable: 700, estimated: true });
    expect(orderComponents({ ...base, discount: 3500 })).toMatchObject({ vendorPromoDiscount: 3000, customerCollection: 0, feeFunding: 500, estimated: true });
    expect(orderComponents(base).estimated).toBe(false);
  });
  it('the sum separates and reconciles: net = goods − own promotions = collected + owed', () => {
    const t = sumComponents([
      { ...base, discount: 500, promoRedemption: { goodsDiscount: 500, deliveryDiscount: 0, funder: 'PLATFORM' } },
      { ...base, discount: 300, promoRedemption: { goodsDiscount: 300, deliveryDiscount: 0, funder: 'VENDOR' } },
      { ...base, discount: 500, promoRedemption: { goodsDiscount: 0, deliveryDiscount: 500, funder: 'PLATFORM' } },
      { ...base, discount: 400 },
    ]);
    expect(t).toEqual({ goodsSales: 12000, vendorPromoDiscount: 700, sponsorReceivable: 500, customerCollection: 10800, feeFunding: 500, moverPayable: 2800, estimatedOrders: 1, netSales: 11300 });
    expect(t.netSales).toBe(t.customerCollection + t.sponsorReceivable);
  });
});

describe('the register’s red test, against the ledger: the digest and the statement emit separate columns', () => {
  let vendorId: string;
  beforeAll(async () => {
    vendorId = await makeVendor();
    const platform = await promo('PLATFORM'); const own = await promo('VENDOR', vendorId);
    await sale(vendorId, { goods: 3000, discount: 500, fee: 500, tip: 200, snapshot: { funder: 'PLATFORM', goodsDiscount: 500, deliveryDiscount: 0, promoId: platform } });
    await sale(vendorId, { goods: 2000, discount: 300, snapshot: { funder: 'VENDOR', goodsDiscount: 300, deliveryDiscount: 0, promoId: own } });
    await sale(vendorId, { goods: 1000, discount: 400, fee: 400, snapshot: { funder: 'PLATFORM', goodsDiscount: 0, deliveryDiscount: 400, promoId: platform } });
    await sale(vendorId, { goods: 1500, discount: 200 }); // legacy: no snapshot
  });
  it('the SQL aggregate equals the pure sum over the same orders', async () => {
    const agg = await aggregateSalesComponents(prisma, { vendorId, from: lastWeek(), to: thisMonday() });
    expect(agg).toEqual({ orders: 4, goodsSales: 7500, vendorPromoDiscount: 500, sponsorReceivable: 500, customerCollection: 6500, feeFunding: 400, moverPayable: 1100, estimatedOrders: 1, netSales: 7000 });
  });
  it('the weekly digest carries the columns, its net is what the vendor keeps (not every discount subtracted), and the shadow counted the disagreement', async () => {
    const before = (await salesComponentsCounter.get()).values.find((v) => v.labels['event'] === 'shadow_diff')?.value ?? 0;
    const totals = await computeDigest(prisma, vendorId, { periodStart: lastWeek(), periodEnd: thisMonday() });
    expect(totals).toMatchObject({ totalOrders: 4, totalBase: 7500, totalDiscount: 1400, goodsSales: 7500, vendorPromoDiscount: 500, sponsorReceivable: 500, customerCollection: 6500, feeFunding: 400, moverPayable: 1100, estimatedOrders: 1, netSales: 7000, componentsVersion: 1 });
    expect((await salesComponentsCounter.get()).values.find((v) => v.labels['event'] === 'shadow_diff')?.value ?? 0).toBe(before + 1); // the old net would have said 6,100
    await generateSalesDigests(prisma, new Date());
    const row = await prisma.settlement.findFirstOrThrow({ where: { vendorId, periodStart: lastWeek(), sequence: 0 } });
    expect(Number(row.netSales)).toBe(7000);
    expect(Number(row.goodsSales)).toBe(7500);
    expect(Number(row.sponsorReceivable)).toBe(500);
    expect(row.estimatedOrders).toBe(1);
    expect(row.componentsVersion).toBe(1);
    // the database holds the columns to their own arithmetic
    await expect(prisma.$executeRaw`UPDATE "settlements" SET "customerCollection" = 1 WHERE "id" = ${row.id}`).rejects.toThrow(/settlements_components_reconcile_check/);
  });
  it('the vendor statement separates the columns, names what Swift owes, keeps the rider’s money out of sales, and says which figures are estimates', async () => {
    const html = await buildVendorStatement(prisma, vendorId, { from: lastWeek(), to: thisMonday(), label: 'last week' });
    expect(html).toContain('Goods sales');
    expect(html).toContain('GY$7,500 GYD');
    expect(html).toContain('Your promotions');
    expect(html).toContain('−GY$500 GYD');
    expect(html).toContain('Platform promotions — owed to you by Swift');
    expect(html).toContain('Collected from customers for goods');
    expect(html).toContain('GY$6,500 GYD');
    expect(html).toContain('Delivery fees and tips (the rider’s, not part of your sales)');
    expect(html).toContain('GY$1,100 GYD');
    expect(html).toContain('Delivery-fee promotions funded by Swift');
    expect(html).toContain('Your sales, net of your own promotions (4 orders)');
    expect(html).toContain('GY$7,000 GYD');
    expect(html).toContain('Estimated, not settled:');
    expect(html).toContain('1 order in this period carry a discount with no funding record');
    expect(html).not.toContain('GY$6,100'); // the old "every promo subtracted" figure is gone
  });
  it('a legacy digest (no components) is recomputed as a versioned ADJUSTMENT carrying them; the digest row never changes; the run is bounded and idempotent', async () => {
    const other = await makeVendor();
    await sale(other, { goods: 2000, discount: 200 });
    const legacy = await prisma.settlement.create({ data: { vendorId: other, periodStart: lastWeek(), periodEnd: thisMonday(), kind: 'DIGEST', sequence: 0, totalOrders: 1, totalBase: 2000, totalMarkup: 0, totalDiscount: 200, netSales: 1800, componentsVersion: 0, status: 'PENDING' } });
    const first = await recomputeLegacyDigests(prisma, 10);
    expect(first.adjusted).toBeGreaterThanOrEqual(1);
    const rows = await prisma.settlement.findMany({ where: { vendorId: other }, orderBy: { sequence: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe(legacy.id);
    expect(rows[0]!.componentsVersion).toBe(0);
    expect(rows[0]!.goodsSales).toBeNull();
    expect(rows[1]).toMatchObject({ kind: 'ADJUSTMENT', sequence: 1, supersedesId: legacy.id, componentsVersion: 1, estimatedOrders: 1 });
    expect(Number(rows[1]!.goodsSales)).toBe(2000);
    expect(Number(rows[1]!.vendorPromoDiscount)).toBe(200);
    expect(rows[1]!.reason).toContain('estimated, not settled');
    const again = await recomputeLegacyDigests(prisma, 10);
    expect((await prisma.settlement.count({ where: { vendorId: other } }))).toBe(2);
    expect(again.pending).toBe(0);
  });
});

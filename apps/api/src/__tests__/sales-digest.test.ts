import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { generateSalesDigests, computeDigest, adjustSalesDigest, scanSalesDigestDelta, digestPeriodFor, completePeriodsBefore } from '../modules/billing/sales-digest';
import { startOfWeekGY } from '../utils/time-gy';

// ---------------------------------------------------------------------------
// [M-27 · S0] The weekly settlement is a SALES DIGEST on canonical periods.
//
// Before: a sliding seven-day window measured from whenever the job ran (an
// early retry or a late run lost a period's tail or made a shifted
// duplicate), only ACTIVE vendors were counted, discounts were ignored, and
// "process → PAID" described money Swift never moved. These are the register's
// red tests: early retry then next week, concurrent workers, a suspended
// seller, the promo component — each compared to the ledger.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const PHONE_BASE = 592_011_000_000 + Math.floor(Math.random() * 8_000_000);
const userIds: string[] = [];
const vendorIds: string[] = [];
const orderIds: string[] = [];
let customerId: string;
let seq = 0;

async function makeVendor(status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  seq += 1;
  const owner = await prisma.user.create({ data: { phone: `+${PHONE_BASE + seq}`, firstName: 'Digest', lastName: `V${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
  userIds.push(owner.id);
  const vo = await prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await prisma.vendor.create({
    data: { ownerId: vo.id, name: `Digest Vendor ${seq}`, slug: `digest-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+${PHONE_BASE + 600_000 + seq}`, addressLine1: '27 Digest St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status, acceptingOrders: status === 'ACTIVE', isVerified: true },
  });
  vendorIds.push(vendor.id);
  return vendor.id;
}
/** A completed sale, its COMPLETED mark at `completedAt`, with an optional discount. */
async function sale(vendorId: string, completedAt: Date, base: number, discount = 0) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `DG-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', customerId, vendorId, status: 'COMPLETED',
      deliveryAddress: 'counter', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: base, subtotalMarkup: 0, subtotalCustomer: base - discount, deliveryFee: 0, discount, totalAmount: base - discount, paymentMethod: 'CASH',
    },
  });
  orderIds.push(order.id);
  await prisma.orderStatusLog.create({ data: { orderId: order.id, status: 'COMPLETED', note: 'test', createdAt: completedAt } });
  return order.id;
}
const rowsFor = (vendorId: string) => prisma.settlement.findMany({ where: { vendorId }, orderBy: [{ periodStart: 'asc' }, { sequence: 'asc' }] });
const thisMonday = () => startOfWeekGY(new Date());
const lastWeek = () => new Date(thisMonday().getTime() - WEEK);      // the most recent complete week
const weekBefore = () => new Date(thisMonday().getTime() - 2 * WEEK);

beforeAll(async () => {
  await prisma.$connect();
  const customer = await prisma.user.create({ data: { phone: `+${PHONE_BASE + 900}`, firstName: 'Digest', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } } });
  userIds.push(customer.id); customerId = customer.id;
});

afterAll(async () => {
  await prisma.settlement.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('[M-27] canonical periods', () => {
  it('a period is a Guyana calendar week, and the week in progress is never digested', () => {
    const now = new Date();
    const { periodStart, periodEnd } = digestPeriodFor(now);
    expect(periodStart.getTime()).toBe(startOfWeekGY(now).getTime());
    expect(periodEnd.getTime() - periodStart.getTime()).toBe(WEEK);
    const periods = completePeriodsBefore(now, 3);
    expect(periods.map((p) => p.periodStart.getTime())).toEqual([lastWeek().getTime(), weekBefore().getTime(), weekBefore().getTime() - WEEK]);
    expect(periods.every((p) => p.periodEnd.getTime() <= thisMonday().getTime())).toBe(true);
  });

  it('the register’s red test: an early retry, then next week — every complete period digested exactly once, no tail lost, no shifted duplicate', async () => {
    const vendorId = await makeVendor();
    await sale(vendorId, new Date(weekBefore().getTime() + 6 * DAY + 23 * 3_600_000), 1000); // the last hour of the week before last — the tail a sliding window lost
    await sale(vendorId, new Date(lastWeek().getTime() + 2 * DAY), 2000);
    // Wednesday of last week: only the week before last is complete.
    const early = await generateSalesDigests(prisma, new Date(lastWeek().getTime() + 2 * DAY + 3_600_000));
    expect(early.created).toBeGreaterThanOrEqual(1);
    let rows = await rowsFor(vendorId);
    expect(rows.map((r) => [r.periodStart.getTime(), Number(r.netSales)])).toEqual([[weekBefore().getTime(), 1000]]);
    // A retry of the same run: nothing new.
    await generateSalesDigests(prisma, new Date(lastWeek().getTime() + 2 * DAY + 7_200_000));
    expect((await rowsFor(vendorId)).length).toBe(1);
    // Next Monday: last week is complete too — one more row, the tail intact.
    await generateSalesDigests(prisma, new Date(thisMonday().getTime() + 3_600_000));
    rows = await rowsFor(vendorId);
    expect(rows.map((r) => [r.periodStart.getTime(), Number(r.netSales), r.sequence])).toEqual([[weekBefore().getTime(), 1000, 0], [lastWeek().getTime(), 2000, 0]]);
  });

  it('concurrent workers digest a period once', async () => {
    const vendorId = await makeVendor();
    await sale(vendorId, new Date(lastWeek().getTime() + DAY), 1500);
    await Promise.all([generateSalesDigests(prisma, new Date()), generateSalesDigests(prisma, new Date()), generateSalesDigests(prisma, new Date())]);
    const rows = await rowsFor(vendorId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.netSales)).toBe(1500);
  });

  it('the database itself refuses a second DIGEST row for one vendor and period', async () => {
    const vendorId = await makeVendor();
    const data = { vendorId, periodStart: lastWeek(), periodEnd: thisMonday(), kind: 'DIGEST', sequence: 0, totalOrders: 1, totalBase: 100, totalMarkup: 0, totalDiscount: 0, netSales: 100, status: 'PENDING' as const };
    await prisma.settlement.create({ data });
    await expect(prisma.settlement.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.settlement.count({ where: { vendorId } })).toBe(1);
  });

  it('a vendor suspended after selling still gets its record', async () => {
    const vendorId = await makeVendor('SUSPENDED');
    await sale(vendorId, new Date(lastWeek().getTime() + 3 * DAY), 800);
    await generateSalesDigests(prisma, new Date());
    const rows = await rowsFor(vendorId);
    expect(rows.map((r) => Number(r.netSales))).toEqual([800]);
  });

  it('the promo component: discounts are allocated and the net matches the ledger', async () => {
    const vendorId = await makeVendor();
    await sale(vendorId, new Date(lastWeek().getTime() + DAY), 3000, 500);
    await sale(vendorId, new Date(lastWeek().getTime() + 2 * DAY), 1000, 0);
    await generateSalesDigests(prisma, new Date());
    const [row] = await rowsFor(vendorId);
    expect({ orders: row!.totalOrders, base: Number(row!.totalBase), discount: Number(row!.totalDiscount), net: Number(row!.netSales) }).toEqual({ orders: 2, base: 4000, discount: 500, net: 3500 });
    expect(await computeDigest(prisma, vendorId, { periodStart: lastWeek(), periodEnd: thisMonday() })).toEqual({ totalOrders: 2, totalBase: 4000, totalMarkup: 0, totalDiscount: 500, netSales: 3500 });
  });
});

describe('[M-27] immutable adjustments and the ledger delta', () => {
  it('a correction is a later sequence recomputed from the ledger; the digest row never changes; the delta sweep finds a stale period first', async () => {
    const vendorId = await makeVendor();
    await sale(vendorId, new Date(lastWeek().getTime() + DAY), 2000);
    await generateSalesDigests(prisma, new Date());
    const [digest] = await rowsFor(vendorId);
    // A late-completed sale lands in the same period after the digest: the ledger moved.
    await sale(vendorId, new Date(lastWeek().getTime() + 5 * DAY), 700);
    const delta = await scanSalesDigestDelta(prisma, new Date(), 2);
    expect(delta.find((d) => d.settlementId === digest!.id)).toMatchObject({ stored: 2000, recomputed: 2700 });
    const adjusted = await adjustSalesDigest(prisma, digest!.id, 'late completion found in the ledger');
    expect(adjusted).toMatchObject({ sequence: 1, supersedesId: digest!.id, totals: { netSales: 2700, totalOrders: 2 } });
    const rows = await rowsFor(vendorId);
    expect(rows.map((r) => [r.kind, r.sequence, Number(r.netSales), r.supersedesId])).toEqual([['DIGEST', 0, 2000, null], ['ADJUSTMENT', 1, 2700, digest!.id]]);
    expect((await scanSalesDigestDelta(prisma, new Date(), 2)).find((d) => d.vendorId === vendorId)).toBeUndefined();
    // Another run changes nothing — the period is digested.
    await generateSalesDigests(prisma, new Date());
    expect((await rowsFor(vendorId)).length).toBe(2);
  });
});

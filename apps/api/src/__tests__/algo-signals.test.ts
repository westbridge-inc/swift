import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { percentile, vendorAckLatency, vendorPrepDuration, riderRates } from '../modules/algo/signals';

// ---------------------------------------------------------------------------
// [ALGO Band 0.4] The signal store reads history that already exists — and
// the one hazard the build order names is graded here: a vendor who never
// answers must never score better than one who answers slowly.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+59200655';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let app: FastifyInstance;
const userIds: string[] = [];
let vendorId: string;
let customerId: string;

async function purge() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await app.prisma.alertDelivery.deleteMany({ where: { recipientId: { in: ids } } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: ids } } });
  const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  await app.prisma.vendor.deleteMany({ where: { ownerId: { in: vos.map((v) => v.id) } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: vos.map((v) => v.id) } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
  await purge();
  const owner = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}01`, firstName: 'Signal', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
  userIds.push(owner.id);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  vendorId = (await app.prisma.vendor.create({ data: { ownerId: vo.id, name: 'Signal Kitchen', slug: `signal-kitchen-${nanoid(5)}`, vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}02`, addressLine1: '1 Signal St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE' } })).id;
  const customer = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}03`, firstName: 'Signal', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } } });
  userIds.push(customer.id);
  customerId = customer.id;
});

afterAll(async () => {
  await purge();
  await app.close();
});

describe('percentile is nearest-rank, and empty is null — never zero', () => {
  it('handles the shapes the store meets', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });
});

describe('vendor acknowledgement latency — survivorship is the hazard', () => {
  const now = new Date();
  async function ping(recipientId: string, sentMinutesAgo: number, answeredAfterMinutes: number | null) {
    const sentAt = new Date(now.getTime() - sentMinutesAgo * MINUTE);
    await app.prisma.alertDelivery.create({
      data: { kind: 'VENDOR_ORDER', subjectId: `o-${nanoid(6)}`, recipientId, sentAt, acknowledgedAt: answeredAfterMinutes == null ? null : new Date(sentAt.getTime() + answeredAfterMinutes * MINUTE) },
    });
  }

  it('a vendor who answers slowly has a latency; a vendor who never answers has NO better number', async () => {
    const slow = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}10`, firstName: 'Slow', lastName: 'Vendor', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    const silent = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}11`, firstName: 'Silent', lastName: 'Vendor', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    userIds.push(slow.id, silent.id);
    for (const m of [8, 9, 10, 12]) await ping(slow.id, 60, m);
    for (let i = 0; i < 4; i++) await ping(silent.id, 60, null);
    await ping(silent.id, 60, 1); // one fast answer, four ignored

    const s = await vendorAckLatency(app.prisma, slow.id, { now });
    expect(s).toMatchObject({ sentCount: 4, answeredCount: 4, coverage: 1, answeredP50Minutes: 9, answeredP90Minutes: 12, censoredP50Minutes: 9 });

    const q = await vendorAckLatency(app.prisma, silent.id, { now });
    expect(q.sentCount).toBe(5);
    expect(q.coverage).toBeCloseTo(0.2);
    // The optimistic number is a lie on its own: 1 minute, from the one ping answered.
    expect(q.answeredP50Minutes).toBe(1);
    // The censored median says what actually happened: most pings were never answered.
    expect(q.censoredP50Minutes).toBeNull();
    // And no consumer can rank "silent" above "slow" without ignoring both fields.
    expect(q.coverage).toBeLessThan(s.coverage);
  });

  it('only the window and only VENDOR_ORDER pings count', async () => {
    const v = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}12`, firstName: 'Window', lastName: 'Vendor', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    userIds.push(v.id);
    await ping(v.id, 30 * 24 * 60, 2); // 30 days ago — outside a 14-day window
    await app.prisma.alertDelivery.create({ data: { kind: 'MOVER_OFFER', subjectId: 'x', recipientId: v.id, sentAt: new Date(now.getTime() - MINUTE), acknowledgedAt: now } });
    await ping(v.id, 5, 3);
    const w = await vendorAckLatency(app.prisma, v.id, { now, days: 14 });
    expect(w).toMatchObject({ sentCount: 1, answeredCount: 1, answeredP50Minutes: 3 });
    expect((await vendorAckLatency(app.prisma, v.id, { now, days: 60 })).sentCount).toBe(2);
  });

  it('no pings at all is coverage 0 and null percentiles — not zero minutes', async () => {
    const none = await vendorAckLatency(app.prisma, 'nobody', { now });
    expect(none).toEqual({ sentCount: 0, answeredCount: 0, coverage: 0, answeredP50Minutes: null, answeredP90Minutes: null, censoredP50Minutes: null });
  });
});

describe('vendor prep duration — ACCEPTED → READY_FOR_PICKUP from the status log', () => {
  const now = new Date();
  async function orderWithPrep(prepMinutes: number | null, daysAgo = 1) {
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `SG-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, status: 'DELIVERED', fulfillment: 'DELIVERY',
        pickupAddress: 'Store', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'Home', deliveryLat: 6.81, deliveryLng: -58.16,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500, paymentMethod: 'CASH',
      },
    });
    const accepted = new Date(now.getTime() - daysAgo * DAY);
    await app.prisma.orderStatusLog.create({ data: { orderId: order.id, status: 'ACCEPTED', createdAt: accepted } });
    if (prepMinutes != null) {
      await app.prisma.orderStatusLog.create({ data: { orderId: order.id, status: 'READY_FOR_PICKUP', createdAt: new Date(accepted.getTime() + prepMinutes * MINUTE) } });
      // A second READY (a re-open) must not count twice.
      await app.prisma.orderStatusLog.create({ data: { orderId: order.id, status: 'READY_FOR_PICKUP', createdAt: new Date(accepted.getTime() + (prepMinutes + 40) * MINUTE) } });
    }
    return order;
  }

  it('pairs the first READY after ACCEPTED, once per order; an order never readied is not a sample', async () => {
    for (const m of [12, 18, 25, 31]) await orderWithPrep(m);
    await orderWithPrep(null);
    await orderWithPrep(90, 60); // outside a 28-day window
    const d = await vendorPrepDuration(app.prisma, vendorId, { now, days: 28 });
    expect(d).toEqual({ sampleSize: 4, p50Minutes: 18, p90Minutes: 31 });
  });

  it('a vendor with no history is null, never zero', async () => {
    expect(await vendorPrepDuration(app.prisma, 'no-such-vendor', { now })).toEqual({ sampleSize: 0, p50Minutes: null, p90Minutes: null });
  });
});

describe('rider rates come from the maintained columns', () => {
  it('reads the row, and null for an unknown rider', async () => {
    const u = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}20`, firstName: 'Rate', lastName: 'Rider', roles: ['RIDER'], activeRole: 'RIDER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    userIds.push(u.id);
    const r = await app.prisma.rider.create({ data: { userId: u.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', acceptanceRate: 87.5, completionRate: 99, averageRating: 4.6 } });
    expect(await riderRates(app.prisma, r.id)).toEqual({ acceptanceRate: 87.5, completionRate: 99, averageRating: 4.6 });
    expect(await riderRates(app.prisma, 'nope')).toBeNull();
  });
});

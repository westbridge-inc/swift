import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { authRoutes } from '../modules/auth/auth.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { loginWithOtp } from './helpers/otp';
import { syntheticLocationOwner } from './helpers/online-mover';

// ---------------------------------------------------------------------------
// DASH-06 — THE ADMIN REVENUE DAY IS A GUYANA DAY.
//
// `GET /admin/finance/revenue` grouped its daily series with `DATE("placedAt")`
// — the UTC day. Guyana is UTC-4 with no DST, so a UTC bucket actually spans
// Guyana 20:00 → 19:59 the NEXT day: every order taken in the last four hours
// of a Georgetown evening was credited to tomorrow. This is the number an
// operator reads to decide whether a day traded well.
//
// The order below is placed at Guyana 21:00 — the exact hour the old bucket
// got wrong. It must appear under ITS OWN day.
//
// The route also returns `SUM(numeric)` aggregates, which arrive from
// $queryRaw as Prisma `Decimal`s and JSON-serialise to STRINGS while the admin
// client types them `number`. Asserted here too — money is different.
//
// Phone prefix +5920063… is used by no other suite (checked).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adminToken: string;
let customerId: string;
let vendorId: string;
let vendorOwnerUserId: string;
const orderIds: string[] = [];

/** UTC instant of a given Guyana-local wall-clock time. Guyana = UTC-4, so
 *  21:00 local is 01:00 UTC the following calendar day — which is precisely
 *  why the UTC bucket was wrong. Written independently of the production
 *  helper so the test cannot inherit the helper's bug. */
function guyanaLocal(ymd: string, hour: number, minute = 0): Date {
  return new Date(`${ymd}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-04:00`);
}

async function makeCompletedOrder(placedAt: Date, deliveryFee: number) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `GYD-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      vendorId,
      status: 'DELIVERED',
      deliveryAddress: '1 Test St',
      deliveryLat: 6.8,
      deliveryLng: -58.15,
      subtotalBase: 1000,
      subtotalMarkup: 0,
      subtotalCustomer: 1000,
      deliveryFee,
      totalAmount: 1000 + deliveryFee,
      paymentMethod: 'CASH',
      placedAt,
    },
  });
  orderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  adminToken = (await loginWithOtp(app, '+5926001000')).json().data.tokens.accessToken; // seeded SUPER_ADMIN

  const owner = await app.prisma.user.create({
    data: {
      phone: '+5920063001', firstName: 'Day', lastName: 'Own',
      roles: ['VENDOR_OWNER'] as never[], activeRole: 'VENDOR_OWNER' as never, isPhoneVerified: true,
    },
  });
  vendorOwnerUserId = owner.id;
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Day ${nanoid(5)}`, slug: `day-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: '+5920063002', addressLine1: '1 Day St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE',
    },
  });
  vendorId = vendor.id;
  const cust = await app.prisma.user.create({
    data: {
      phone: '+5920063003', firstName: 'Day', lastName: 'Cust',
      roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never, isPhoneVerified: true,
    },
  });
  customerId = cust.id;
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: vendorOwnerUserId } });
  await app.prisma.user.deleteMany({ where: { id: { in: [vendorOwnerUserId, customerId] } } });
  await app.close();
});

type DailyRow = { date: string; markup: number; delivery_fees: number; total: number; order_count: number };

async function fetchDaily() {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/finance/revenue',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data as { dailyRevenue: DailyRow[]; summary: Record<string, number> };
}

/** The tenant's DB carries seed + other suites' orders, so assert on the DELTA
 *  this test causes, never on absolute totals — an absolute count would pass or
 *  fail on someone else's rows. */
async function dailySnapshot(): Promise<Map<string, DailyRow>> {
  const { dailyRevenue } = await fetchDaily();
  return new Map(dailyRevenue.map((r) => [r.date, r]));
}

function delta(before: Map<string, DailyRow>, after: Map<string, DailyRow>, day: string) {
  const b = before.get(day);
  const a = after.get(day);
  return {
    orders: (a?.order_count ?? 0) - (b?.order_count ?? 0),
    fees: Number(a?.delivery_fees ?? 0) - Number(b?.delivery_fees ?? 0),
  };
}

describe('admin daily revenue buckets by GUYANA day [DASH-06]', () => {
  it('an order placed at Guyana 21:00 belongs to THAT day, not the next', async () => {
    // Two days back, so the row sits comfortably inside the 30-day window and
    // never depends on "now".
    const target = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const placedAt = guyanaLocal(target, 21, 0);
    const utcDay = placedAt.toISOString().slice(0, 10);

    // Sanity: this instant really is the NEXT calendar day in UTC — i.e. the
    // exact case the UTC bucket mis-files. If this ever stops holding, the
    // assertions below would pass for the wrong reason.
    expect(utcDay).not.toBe(target);

    const before = await dailySnapshot();
    await makeCompletedOrder(placedAt, 500);
    const after = await dailySnapshot();

    // It landed on its own Guyana day...
    expect(delta(before, after, target)).toEqual({ orders: 1, fees: 500 });
    // ...and NOT on the UTC day that follows it. This is the whole finding:
    // pre-fix the 1 order and its 500 in fees appeared here instead.
    expect(delta(before, after, utcDay)).toEqual({ orders: 0, fees: 0 });

    // And the label is the Guyana calendar day as a plain YYYY-MM-DD string —
    // not a `date`, which JSON-serialises to a UTC-midnight instant the
    // browser then shifts a SECOND time in `toLocaleDateString()`.
    expect([...after.keys()].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
  });

  it('20:00 and 23:59 Guyana stay on their own day; 00:00 Guyana opens the next one', async () => {
    // 20:00 local is the first minute the old UTC bucket rolled over, and
    // 23:59 the last. Both belong to `target`; the 00:00 order belongs to the
    // day after and proves the boundary is a cut, not a blanket shift.
    const target = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    const nextDay = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);

    const before = await dailySnapshot();
    await makeCompletedOrder(guyanaLocal(target, 20, 0), 100);
    await makeCompletedOrder(guyanaLocal(target, 23, 59), 200);
    await makeCompletedOrder(guyanaLocal(nextDay, 0, 0), 400);
    const after = await dailySnapshot();

    expect(delta(before, after, target)).toEqual({ orders: 2, fees: 300 });
    expect(delta(before, after, nextDay)).toEqual({ orders: 1, fees: 400 });
  });

  it('every money field is a number, never a Decimal string', async () => {
    await makeCompletedOrder(guyanaLocal(new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10), 12), 750);
    const { dailyRevenue, summary } = await fetchDaily();

    expect(dailyRevenue.length).toBeGreaterThan(0);
    for (const row of dailyRevenue) {
      // Pre-fix: `SUM(numeric)` came back as a Prisma Decimal and JSON-serialised
      // to "750.00" — the admin type says number, so `a + b` concatenated.
      expect(typeof row.markup, `markup on ${row.date}`).toBe('number');
      expect(typeof row.delivery_fees, `delivery_fees on ${row.date}`).toBe('number');
      expect(typeof row.total, `total on ${row.date}`).toBe('number');
      expect(typeof row.order_count, `order_count on ${row.date}`).toBe('number');
    }

    // Pre-fix these used `|| 0` — a Decimal is TRUTHY, so the raw Decimal went
    // straight out as a string [SWIFT-119].
    expect(typeof summary['thirtyDayMarkup']).toBe('number');
    expect(typeof summary['thirtyDayDeliveryFees']).toBe('number');
    expect(Number.isFinite(summary['thirtyDayDeliveryFees'])).toBe(true);
  });
});

describe('admin list routes coerce Decimal money at the seam', () => {
  it('GET /orders returns numeric money, not Decimal strings', async () => {
    await makeCompletedOrder(guyanaLocal(new Date(Date.now() - 1 * 86_400_000).toISOString().slice(0, 10), 10), 325);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders?limit=50',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<Record<string, unknown>>;
    const mine = rows.filter((o) => orderIds.includes(o['id'] as string));
    expect(mine.length).toBeGreaterThan(0);
    for (const o of mine) {
      for (const field of ['subtotalBase', 'subtotalCustomer', 'deliveryFee', 'totalAmount', 'tipAmount'] as const) {
        expect(typeof o[field], `${field} on ${o['orderNumber']}`).toBe('number');
      }
      // A genuinely absent optional money column stays null — never an
      // invented 0. This order is not a ride, so it has no taxi fare.
      expect(o['taxiFareTotal']).toBeNull();
    }
  });

  it('GET /subscriptions returns numeric weeklyRate', async () => {
    const sub = await app.prisma.subscription.create({
      data: {
        vendorId, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 20000,
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * 86400000),
        nextBillingDate: new Date(Date.now() + 7 * 86400000),
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/subscriptions?limit=50',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const row = (res.json().data as Array<Record<string, unknown>>).find((s) => s['id'] === sub.id);
      expect(row, 'seeded subscription should be listed').toBeTruthy();
      expect(typeof row!['weeklyRate']).toBe('number');
      expect(row!['weeklyRate']).toBe(20000);
      expect(row!['customRate']).toBeNull(); // unset optional money stays null
    } finally {
      await app.prisma.subscription.deleteMany({ where: { id: sub.id } });
    }
  });

  it('GET /finance/settlements returns numeric totals', async () => {
    const settlement = await app.prisma.settlement.create({
      data: {
        vendorId, status: 'PENDING', totalOrders: 3, totalBase: 12000, totalMarkup: 0,
        periodStart: new Date(Date.now() - 7 * 86400000), periodEnd: new Date(),
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/finance/settlements?limit=50&status=PENDING',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const row = (res.json().data as Array<Record<string, unknown>>).find((s) => s['id'] === settlement.id);
      expect(row, 'seeded settlement should be listed').toBeTruthy();
      expect(typeof row!['totalBase']).toBe('number');
      expect(row!['totalBase']).toBe(12000);
      expect(typeof row!['totalMarkup']).toBe('number');
    } finally {
      await app.prisma.settlement.deleteMany({ where: { id: settlement.id } });
    }
  });
});

describe('live ops never emits a half position [OpsMap crash]', () => {
  it('a mover with a lat but no lng is excluded, not shipped to Leaflet', async () => {
    const riderUser = await app.prisma.user.create({
      data: {
        phone: '+5920063004', firstName: 'Half', lastName: 'Fix',
        roles: ['RIDER'] as never[], activeRole: 'RIDER' as never, isPhoneVerified: true,
      },
    });
    // currentLat/currentLng are two independent `Float?` columns with no
    // constraint tying them, so this row is representable in production.
    const rider = await app.prisma.rider.create({
      data: {
        userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE', isOnline: true, isAvailable: true, locationSessionId: syntheticLocationOwner('admin-rev'),
        currentLat: 6.8, currentLng: null,
      },
    });
    const wholeRiderUser = await app.prisma.user.create({
      data: {
        phone: '+5920063005', firstName: 'Whole', lastName: 'Fix',
        roles: ['RIDER'] as never[], activeRole: 'RIDER' as never, isPhoneVerified: true,
      },
    });
    const wholeRider = await app.prisma.rider.create({
      data: {
        userId: wholeRiderUser.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE', isOnline: true, isAvailable: true, locationSessionId: syntheticLocationOwner('admin-rev'),
        currentLat: 6.81, currentLng: -58.16,
      },
    });
    try {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/admin/ops/live',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const movers = res.json().data.movers as Array<{ id: string; lat: number | null; lng: number | null }>;

      // The half-positioned rider is gone...
      expect(movers.find((m) => m.id === rider.id)).toBeUndefined();
      // ...and the fully-positioned one is still there (the filter narrowed the
      // broken row, not the feature).
      expect(movers.find((m) => m.id === wholeRider.id)).toBeTruthy();
      // Nothing on the wire can crash `position={[m.lat, m.lng]}`.
      expect(movers.every((m) => typeof m.lat === 'number' && typeof m.lng === 'number')).toBe(true);
    } finally {
      await app.prisma.rider.deleteMany({ where: { id: { in: [rider.id, wholeRider.id] } } });
      await app.prisma.user.deleteMany({ where: { id: { in: [riderUser.id, wholeRiderUser.id] } } });
    }
  });
});

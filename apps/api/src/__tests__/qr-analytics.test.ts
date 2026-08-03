import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { qrResolverRoutes } from '../modules/qr/qr-resolver.routes';
import { attributionRoutes } from '../modules/qr/attribution.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { flushScanLog, resetScanLogForTests } from '../modules/qr/scan-log';

// ---------------------------------------------------------------------------
// QR analytics reconciliation (spec 12.5, the merge gate): a scripted scenario
// — 12 scans across 2 templates, 3 web orders, 1 attributed install, plus an
// INSTALL_TAP and a retention-era rollup row — then every endpoint total is
// asserted equal to a direct SQL/count over the same rows. A dashboard that
// lies is worse than none; this test is where lying becomes impossible.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Safari/604.1';

let app: FastifyInstance;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;
const phoneBase = 592_850_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeOwnerWithVendor() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Ana', lastName: `U${seq}`,
      roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'ana-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  const owner = await app.prisma.vendorOwner.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Ana Vendor ${seq}`, slug: `ana-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Funnel Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  return { userId: user.id, token, vendorId: vendor.id, slug: vendor.slug };
}

const scan = (code: string, query: string, ip: string) =>
  app.inject({ method: 'GET', url: `/s/${code}${query}`, remoteAddress: ip, headers: { 'user-agent': IOS_UA } });

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  registerErrorHandler(app);
  await app.register(qrResolverRoutes);
  await app.register(attributionRoutes, { prefix: '/api/v1/attribution' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  await app.prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "one_active_qr_per_entity" ON "qr_codes"("tenantId", "entityType", "entityId") WHERE status = 'ACTIVE'`,
  );
  resetScanLogForTests();
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await app.prisma.attributionClaim.deleteMany({ where: { installId: { startsWith: 'ana-' } } });
  await app.prisma.pendingAttribution.deleteMany({ where: { destinationPath: { startsWith: '/store/ana-vendor-' } } });
  await app.prisma.scanEvent.deleteMany({ where: { qrCode: { entityId: { in: createdVendorIds } } } });
  await app.prisma.scanDailyRollup.deleteMany({ where: { qrCodeId: { in: (await app.prisma.qrCode.findMany({ where: { entityId: { in: createdVendorIds } }, select: { id: true } })).map((q) => q.id) } } });
  await app.prisma.qrCode.deleteMany({ where: { entityId: { in: createdVendorIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('the scripted reconciliation scenario', () => {
  it('endpoint totals === direct SQL, per total; ranges, byDay, byTemplate, funnel all reconcile', async () => {
    const ctx = await makeOwnerWithVendor();
    const auth = { authorization: `Bearer ${ctx.token}` };

    const qrRes = await app.inject({ method: 'GET', url: '/api/v1/vendor/qr', headers: auth });
    const code = qrRes.json().data.shortCode as string;
    const qr = await app.prisma.qrCode.findUniqueOrThrow({ where: { shortCode: code } });

    // 12 scans through the REAL resolver: 7 ?t=card, 5 ?t=flyer, 3 distinct
    // IPs (so unique-scanner math has structure: 3 uniques today).
    const ips = ['198.51.100.201', '198.51.100.202', '198.51.100.203'];
    for (let i = 0; i < 7; i += 1) await scan(code, '?t=card', ips[i % 2]!);
    for (let i = 0; i < 5; i += 1) await scan(code, '?t=flyer', ips[2 - (i % 2)]!);
    await flushScanLog();

    // Two of those scans happened "10 days ago" (range partitioning).
    const oldScans = await app.prisma.scanEvent.findMany({
      where: { qrCodeId: qr.id, decision: 'WEB_RENDER' }, take: 2, orderBy: { id: 'asc' },
    });
    await app.prisma.scanEvent.updateMany({
      where: { id: { in: oldScans.map((s) => s.id) } },
      data: { occurredAt: new Date(Date.now() - 10 * DAY) },
    });

    // A retention-era rollup row (the 90-day sweep already folded these):
    // 4 card scans, 100 days ago. Totals for range=all must include them.
    await app.prisma.scanDailyRollup.create({
      data: {
        tenantId: qr.tenantId, qrCodeId: qr.id, date: new Date(Date.now() - 100 * DAY),
        decision: 'WEB_RENDER', osFamily: 'ios', template: 'card', count: 4,
      },
    });

    // 1 attributed install: web tap → candidate → first-launch claim.
    const tapIp = '198.51.100.204';
    await app.inject({
      method: 'POST', url: '/api/v1/attribution/intent',
      payload: { shortCode: code }, remoteAddress: tapIp, headers: { 'user-agent': IOS_UA },
    });
    await app.inject({
      method: 'POST', url: '/api/v1/attribution/claim',
      payload: { installId: `ana-${nanoid(10)}`, platform: 'ios' }, remoteAddress: tapIp, headers: { 'user-agent': IOS_UA },
    });
    await flushScanLog(); // the INSTALL_TAP funnel event

    // 3 web orders that arrived through this QR (the web checkout stamps
    // these fields; rows created directly here — the math is what's under test).
    for (let i = 0; i < 3; i += 1) {
      const order = await app.prisma.order.create({
        data: {
          orderNumber: `QA-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
          customerId: ctx.userId, vendorId: ctx.vendorId, status: 'DELIVERED',
          deliveryAddress: 'reconcile', deliveryLat: 6.8, deliveryLng: -58.15,
          subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
          deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
          channel: 'WEB', attributionQrCodeId: qr.id,
        },
      });
      createdOrderIds.push(order.id);
    }
    // A NON-attributed mobile order must stay out of webOrders.
    const noise = await app.prisma.order.create({
      data: {
        orderNumber: `QA-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
        customerId: ctx.userId, vendorId: ctx.vendorId, status: 'DELIVERED',
        deliveryAddress: 'noise', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 500, subtotalMarkup: 0, subtotalCustomer: 500,
        deliveryFee: 0, totalAmount: 500, paymentMethod: 'CASH',
      },
    });
    createdOrderIds.push(noise.id);

    // ---- range=all ----
    const all = (await app.inject({ method: 'GET', url: '/api/v1/vendor/qr/analytics?range=all', headers: auth })).json().data;

    const sqlScansRaw = await app.prisma.scanEvent.count({
      where: { qrCodeId: qr.id, decision: { in: ['WEB_RENDER', 'APP_OPEN_ASSUMED', 'RETIRED_PAGE', 'UNAVAILABLE_PAGE'] } },
    });
    expect(sqlScansRaw).toBe(12);
    expect(all.totals.scans).toBe(sqlScansRaw + 4); // raw + the rollup row
    expect(all.totals.installTaps).toBe(await app.prisma.scanEvent.count({ where: { qrCodeId: qr.id, decision: 'INSTALL_TAP' } }));
    expect(all.totals.installTaps).toBe(1);
    expect(all.totals.installsAttributed).toBe(await app.prisma.attributionClaim.count({ where: { qrCodeId: qr.id, destinationPath: { not: null } } }));
    expect(all.totals.installsAttributed).toBe(1);
    expect(all.totals.webOrders).toBe(await app.prisma.order.count({ where: { attributionQrCodeId: qr.id, channel: 'WEB' } }));
    expect(all.totals.webOrders).toBe(3);
    expect(all.totals.storeViews).toBe(0); // no writer yet — a real zero
    expect(all.totals.appOpens).toBe(0);

    // Unique scanners: 3 IPs today + 10-days-ago rows re-count their IPs on
    // that day (per-day distinct by design). SQL mirror:
    const uniq = await app.prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(DISTINCT to_char("occurredAt" AT TIME ZONE 'UTC','YYYY-MM-DD') || '|' || COALESCE("ipHash",'')) AS n
       FROM "scan_events" WHERE "qrCodeId" = $1 AND "decision" IN ('WEB_RENDER','APP_OPEN_ASSUMED','RETIRED_PAGE','UNAVAILABLE_PAGE')`,
      qr.id,
    );
    expect(all.totals.approxUniqueScanners).toBe(Number(uniq[0]!.n));

    // byTemplate: 7 card + 4 rolled-up card = 11; 5 flyer.
    expect(all.byTemplate).toEqual([
      { template: 'card', scans: 11 },
      { template: 'flyer', scans: 5 },
    ]);

    // byDay: today (10 live scans), 10 days ago (2), 100 days ago (4 rollup);
    // 3 web orders today.
    expect(all.byDay).toHaveLength(3);
    const today = all.byDay[2];
    expect(today.scans).toBe(10);
    expect(today.webOrders).toBe(3);
    expect(all.byDay[1].scans).toBe(2);
    expect(all.byDay[0].scans).toBe(4);

    // funnel mirrors totals, stage for stage.
    expect(all.funnel).toEqual([
      { stage: 'SCAN', count: all.totals.scans },
      { stage: 'STORE_VIEW', count: 0 },
      { stage: 'WEB_ORDER', count: 3 },
      { stage: 'INSTALL_TAP', count: 1 },
      { stage: 'INSTALL_ATTRIBUTED', count: 1 },
      { stage: 'ATTRIBUTED_FIRST_ORDER', count: 0 },
    ]);

    // ---- range=7d excludes the old raw rows AND the ancient rollup ----
    const week = (await app.inject({ method: 'GET', url: '/api/v1/vendor/qr/analytics?range=7d', headers: auth })).json().data;
    expect(week.totals.scans).toBe(10);
    expect(week.byDay).toHaveLength(1);

    // ---- a vendor with no code reads honest zeros ----
    const bare = await makeOwnerWithVendor();
    const empty = (await app.inject({ method: 'GET', url: '/api/v1/vendor/qr/analytics', headers: { authorization: `Bearer ${bare.token}` } })).json().data;
    expect(empty.totals.scans).toBe(0);
    expect(empty.byDay).toEqual([]);
  });
});

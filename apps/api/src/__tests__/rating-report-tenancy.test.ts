import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { ratingReportTenancyCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [R048-002] A rating report resolves to exactly one tenant — its reporter, its
// review (through the review's order or author), and its resolution actor —
// or it is nothing: two tenants, two admins, two reviews, two reports, plus a
// malformed report whose review sits in the other tenant. Tenant A's queue
// holds only A's; every A request against B's or the malformed id is
// indistinguishable from not-found and changes zero rows; filing a report on
// a foreign review is refused as not-found.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const DEFAULT_TENANT = 'swift-default';
const TENANT_B = `tenant-rr-b-${nanoid(6).toLowerCase()}`;
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdOrderIds: string[] = [];
const createdRatingIds: string[] = [];
const createdReportIds: string[] = [];
let seq = 0;
const phoneBase = 592_740_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[], tenantId: string) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'RR', lastName: `U${seq}`, roles, activeRole: roles[0]!, isPhoneVerified: true, tenantId,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  // authMethod OTP: an ADMIN session without privileged assurance is logged out on first use (session-assurance.ts)
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'rr', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

/** A rated order inside ONE tenant: vendor, customer, order and a public review. */
async function makeReview(tenantId: string) {
  const owner = await makeUser(['VENDOR_OWNER'], tenantId);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `RR Vendor ${seq}`, slug: `rr-vendor-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Report Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true, tenantId,
    },
  });
  createdVendorIds.push(vendor.id);
  const customer = await makeUser(['CUSTOMER'], tenantId);
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `RR-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', customerId: customer.userId, vendorId: vendor.id, status: 'DELIVERED',
      deliveryAddress: 'rr', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: 900, subtotalMarkup: 0, subtotalCustomer: 900, deliveryFee: 0, totalAmount: 900, paymentMethod: 'CASH', tenantId,
    },
  });
  createdOrderIds.push(order.id);
  const rating = await app.prisma.rating.create({
    data: { orderId: order.id, raterId: customer.userId, vendorId: vendor.id, type: 'CUSTOMER_TO_VENDOR', score: 2, comment: 'a report-worthy review', isPublic: true, state: 'ACTIVE' },
  });
  createdRatingIds.push(rating.id);
  return { vendor, customer, order, rating };
}

async function makeReport(tenantId: string, ratingId: string, reporterId: string) {
  const report = await app.prisma.ratingReport.create({ data: { tenantId, ratingId, reporterId, reason: 'SPAM', note: `note-${tenantId}` } });
  createdReportIds.push(report.id);
  return report;
}

const inject = (method: 'GET' | 'POST', url: string, token: string, payload?: unknown) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
const count = async (outcome: string) => (await ratingReportTenancyCounter.get()).values.find((v) => v.labels['outcome'] === outcome)?.value ?? 0;

let adminA: { userId: string; token: string };
let adminB: { userId: string; token: string };
let a: Awaited<ReturnType<typeof makeReview>>;
let b: Awaited<ReturnType<typeof makeReview>>;
let reportA: { id: string };
let reportB: { id: string };
let malformed: { id: string };

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  await app.prisma.tenant.upsert({ where: { id: TENANT_B }, create: { id: TENANT_B, name: 'Tenant B (rating reports)', slug: TENANT_B }, update: {} });
  adminA = await makeUser(['ADMIN'], DEFAULT_TENANT);
  adminB = await makeUser(['ADMIN'], TENANT_B);
  a = await makeReview(DEFAULT_TENANT);
  b = await makeReview(TENANT_B);
  reportA = await makeReport(DEFAULT_TENANT, a.rating.id, a.customer.userId);
  reportB = await makeReport(TENANT_B, b.rating.id, b.customer.userId);
  // the malformed leg: a report stamped in A whose review lives in B
  malformed = await makeReport(DEFAULT_TENANT, b.rating.id, a.customer.userId);
});
afterAll(async () => {
  // Namespace-owned cleanup, in dependency order, and the tenant is deactivated FIRST so that even a
  // failed delete can never leave a second ACTIVE tenant behind for the public surfaces to trip over.
  // Under runWithoutTenant: the last request's enterWith() leaves THIS async context bound to tenant A,
  // and a scoped deleteMany would silently skip B's rows — cleanup runs as named, unscoped system work.
  await runWithoutTenant(async () => {
    await app.prisma.tenant.updateMany({ where: { id: TENANT_B }, data: { isActive: false } }).catch(() => {});
    await app.prisma.ratingReport.deleteMany({ where: { OR: [{ id: { in: createdReportIds } }, { tenantId: TENANT_B }] } }).catch(() => {});
    await app.prisma.rating.deleteMany({ where: { id: { in: createdRatingIds } } }).catch(() => {});
    await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => {});
    await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: createdUserIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    await app.prisma.tenant.deleteMany({ where: { id: TENANT_B } }).catch(() => {});
  }, 'test-cleanup:rating-report-tenancy');
  await app.close();
});

describe('[R048-002] the moderation queue is one tenant’s', () => {
  it('tenant A’s queue holds only A’s report; the malformed A-report on B’s review is quarantined, never shown; B sees only B', async () => {
    const before = await count('quarantined_in_queue');
    const qa = await inject('GET', '/api/v1/admin/ratings/moderation', adminA.token);
    expect(qa.statusCode).toBe(200);
    const idsA = (qa.json().data.reports as Array<{ id: string; rating: unknown }>).map((r) => r.id);
    expect(idsA).toContain(reportA.id);
    expect(idsA).not.toContain(reportB.id);
    expect(idsA).not.toContain(malformed.id);
    expect(qa.json().data.quarantined).toBeGreaterThanOrEqual(1);
    expect(await count('quarantined_in_queue')).toBeGreaterThan(before);
    for (const r of qa.json().data.reports as Array<{ rating: unknown }>) expect(r.rating).not.toBeNull();
    const qb = await inject('GET', '/api/v1/admin/ratings/moderation', adminB.token);
    const idsB = (qb.json().data.reports as Array<{ id: string }>).map((r) => r.id);
    expect(idsB).toContain(reportB.id);
    expect(idsB).not.toContain(reportA.id);
    expect(idsB).not.toContain(malformed.id);
  });
});

describe('[R048-002] resolution resolves every leg to the request tenant, or changes nothing', () => {
  it('A resolving B’s report id, and A resolving the malformed report, are not-found and leave both rows PENDING', async () => {
    const before = await count('resolve_refused');
    for (const id of [reportB.id, malformed.id]) {
      const res = await inject('POST', `/api/v1/admin/rating-reports/${id}/resolve`, adminA.token, { action: 'uphold' });
      expect(res.statusCode, id).toBe(404);
    }
    expect(await count('resolve_refused')).toBeGreaterThanOrEqual(before + 1);
    const rows = await app.prisma.ratingReport.findMany({ where: { id: { in: [reportB.id, malformed.id] } }, select: { id: true, status: true, resolvedBy: true } });
    for (const row of rows) { expect(row.status, row.id).toBe('PENDING'); expect(row.resolvedBy, row.id).toBeNull(); }
    const bRating = await app.prisma.rating.findUniqueOrThrow({ where: { id: b.rating.id }, select: { state: true } });
    expect(bRating.state).toBe('ACTIVE');
  });

  it('A resolving A’s own report works exactly once; a second resolution is refused', async () => {
    const ok = await inject('POST', `/api/v1/admin/rating-reports/${reportA.id}/resolve`, adminA.token, { action: 'dismiss' });
    expect(ok.statusCode).toBe(200);
    const row = await app.prisma.ratingReport.findUniqueOrThrow({ where: { id: reportA.id } });
    expect(row).toMatchObject({ status: 'DISMISSED', resolvedBy: adminA.userId });
    const again = await inject('POST', `/api/v1/admin/rating-reports/${reportA.id}/resolve`, adminA.token, { action: 'uphold' });
    expect(again.statusCode).toBe(400);
  });
});

describe('[R048-002] resolution is one conditional write', () => {
  it('six admins racing to resolve the same report resolve it exactly once — one 200, the rest refused, one resolver on the row', async () => {
    const reporter = await makeUser(['CUSTOMER'], DEFAULT_TENANT);
    const fresh = await makeReport(DEFAULT_TENANT, a.rating.id, reporter.userId);
    const racers = await Promise.all(Array.from({ length: 6 }, () => makeUser(['ADMIN'], DEFAULT_TENANT)));
    const before = await count('resolve_race');
    const results = await Promise.all(racers.map((admin) => inject('POST', `/api/v1/admin/rating-reports/${fresh.id}/resolve`, admin.token, { action: 'dismiss' })));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    for (const c of codes) expect([200, 400, 409]).toContain(c);
    const row = await app.prisma.ratingReport.findUniqueOrThrow({ where: { id: fresh.id }, select: { status: true, resolvedBy: true } });
    expect(row.status).toBe('DISMISSED');
    expect(racers.map((r) => r.userId)).toContain(row.resolvedBy);
    // the losers that reached the write are counted as the race they lost
    expect((await count('resolve_race')) - before).toBe(codes.filter((c) => c === 409).length);
  });
});

describe('[R048-002] filing a report is inside one tenant', () => {
  it('a customer in A reporting B’s review is not-found and files nothing; reporting A’s own review files exactly one report', async () => {
    const before = await count('report_refused_foreign_rating');
    // the malformed fixture already pairs this reporter with B's review — so the proof is a DELTA of zero, not an absolute
    const rowsBefore = await app.prisma.ratingReport.count({ where: { ratingId: b.rating.id, reporterId: a.customer.userId } });
    const foreign = await inject('POST', `/api/v1/customer/ratings/${b.rating.id}/report`, a.customer.token, { reason: 'SPAM' });
    expect(foreign.statusCode).toBe(404);
    expect(await count('report_refused_foreign_rating')).toBe(before + 1);
    expect(await app.prisma.ratingReport.count({ where: { ratingId: b.rating.id, reporterId: a.customer.userId } })).toBe(rowsBefore);
    const reporter = await makeUser(['CUSTOMER'], DEFAULT_TENANT);
    const own = await inject('POST', `/api/v1/customer/ratings/${a.rating.id}/report`, reporter.token, { reason: 'OFFENSIVE' });
    expect(own.statusCode).toBe(200);
    createdReportIds.push(own.json().data.id as string);
    const filed = await app.prisma.ratingReport.findUniqueOrThrow({ where: { id: own.json().data.id as string } });
    expect(filed).toMatchObject({ tenantId: DEFAULT_TENANT, ratingId: a.rating.id, reporterId: reporter.userId });
  });
});

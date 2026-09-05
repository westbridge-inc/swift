import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { refusalName, refuseAuditWhere, allowAuditAgain as allowAuditAgainShared, dropAuditRefusal } from './helpers/audit-refusal';
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';

// ---------------------------------------------------------------------------
// [ADM-002] THE ARC: A HELPER THAT OWNS ITS TRANSACTION TAKES THE AUDIT IN.
//
// 23 of the 40 money routes do not own their write — `writePricingConfig`,
// `updatePromoTerms`, `confirmDeposit` and their kin open their own
// `$transaction`. A route cannot hand `auditWithin` a transaction it does not
// hold, and threading `tx` through every caller would rewrite who owns it.
// The contract instead: the helper accepts `onAudit?: OnAudit` and invokes it
// as the LAST statement inside the transaction it already owns, passing the
// facts only it knows (the version it recorded). The route supplies the
// callback. This file is the reference for the other 21: the price book.
//
// The proof that matters: an audit row the database refuses must roll back
// the helper's OWN writes — the column AND the version row — not just the
// audit. That is the difference between "the route audited" and "the helper
// cannot act unaudited".
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const ZY = 'ZY';
const userIds: string[] = [];
let token = '';
const REASON = 'Fuel surcharge review, board minute 2026-09-05, ticket GY-6001';

const call = (m: string, u: string, p?: unknown) => injectWithApproval(app, {
  method: m as never, url: u,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
  ...(p === undefined ? {} : { payload: p as Record<string, unknown> }) });

const rows = () => runWithoutTenant(() => app.prisma.auditLog.findMany({
  where: { userId: userIds[0]!, entityId: ZY }, orderBy: { createdAt: 'asc' } }), 'read');
const versions = () => app.prisma.pricingConfigVersion.count({ where: { countryCode: ZY, kind: 'TAXI_RATES' } });
const taxiRates = async () => (await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: ZY } })).taxiRates;

const REFUSAL = refusalName('arc');
const refuseAuditFor = (entityId: string) => refuseAuditWhere(app, REFUSAL, { entityId });
const allowAuditAgain = () => allowAuditAgainShared(app, REFUSAL);

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await app.prisma.pricingConfigVersion.deleteMany({ where: { countryCode: ZY } });
  await app.prisma.countryConfig.deleteMany({ where: { code: ZY } });
  await app.prisma.countryConfig.create({ data: {
    code: ZY, name: 'Zed-Y Test Market', currencyCode: 'ZYD', currencySymbol: 'Y$', usdExchangeRate: 100, isActive: false,
    subscriptionTiers: { mover: 1000, smallVendor: 2000, largeVendor: 5000 }, documentChecklists: {} } });
  const admin = await app.prisma.user.create({ data: {
    phone: `+59274${String(Math.floor(Math.random() * 90000) + 10000)}`,
    firstName: 'Arc', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
    activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } } } });
  userIds.push(admin.id);
  token = app.jwt.sign({ userId: admin.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: admin.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
    deviceId: 'arc', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
});

afterAll(async () => {
  await dropAuditRefusal(app, REFUSAL);
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await app.prisma.pricingConfigVersion.deleteMany({ where: { countryCode: ZY } }).catch(() => {});
    await app.prisma.countryConfig.deleteMany({ where: { code: ZY } }).catch(() => {});
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'arc').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'arc').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'arc');
  await app.close();
});

describe('[ADM-002] the price book takes the audit into its own transaction', () => {
  it('a write records the country and the facts only the helper knows — kind and version', async () => {
    const res = await call('PUT', `/api/v1/admin/countries/${ZY}/pricing/TAXI_RATES`, { base: 2000, minimum: 2500 });
    expect(res.statusCode, res.body).toBe(200);
    const r = await rows();
    expect(r.length, 'one inline row').toBe(1);
    const changes = r[0]!.changes as Record<string, unknown>;
    expect(changes['kind']).toBe('TAXI_RATES');
    expect(changes['version'], 'the version the helper recorded travels as a fact').toBe(1);
    expect(r[0]!.entity, 'the resource, not the mount prefix').toBe('countries');
    expect(r.some((x) => x.action === 'UPDATE_PRICING_CONFIG'), 'the legacy row is retired').toBe(false);
  });

  it('a rollback records what it restored from', async () => {
    const v2 = await call('PUT', `/api/v1/admin/countries/${ZY}/pricing/TAXI_RATES`, { base: 3000, minimum: 4000 });
    expect(v2.statusCode, v2.body).toBe(200);
    const back = await call('POST', `/api/v1/admin/countries/${ZY}/pricing/TAXI_RATES/rollback`, {});
    expect(back.statusCode, back.body).toBe(200);
    const r = await rows();
    const last = r[r.length - 1]!.changes as Record<string, unknown>;
    expect(last['rollback']).toBe(true);
    expect(last['restoredFrom']).toBe(1);
    expect(last['version']).toBe(3);
  });

  it("THE CONTRACT: a refused audit row rolls back the helper's OWN writes — the column and the version", async () => {
    const before = await taxiRates();
    const versionsBefore = await versions();
    await refuseAuditFor(ZY);
    try {
      const res = await call('PUT', `/api/v1/admin/countries/${ZY}/pricing/TAXI_RATES`, { base: 9999, minimum: 9999 });
      expect(res.statusCode, 'a price change whose audit was refused must not report success').not.toBe(200);
      // and it was the AUDIT that refused it — not the payload, not the guard.
      // A 400 on the body would leave the column unchanged too, and prove nothing.
      expect(res.statusCode, res.body).toBe(500);
    } finally { await allowAuditAgain(); }
    expect(await taxiRates(), 'the column is as it was').toEqual(before);
    expect(await versions(), 'and no version row was appended').toBe(versionsBefore);
  });
});

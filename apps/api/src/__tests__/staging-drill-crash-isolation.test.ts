import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { drillFixturesMain } from '../modules/ops/drills/cli';
import { createCrashFixtures, crashTenantId, type CrashScope } from '../modules/ops/drills/crash-fixtures';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { registrationProofFor } from './helpers/otp';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const db = new PrismaClient();
const runId = `isolation-${nanoid(12)}`;
const environment = { ...process.env, SWIFT_STAGING_DRILLS: '1', SYSTEM_DATABASE_URL: undefined, TENANT_RLS_BIND: undefined };
let app: FastifyInstance;
let scope: CrashScope;
let outsiderId = '';
let outsiderRider = '';
let outsiderToken = '';
let priorIdentity = false;
const orders: string[] = [];
const tokens = new Map<string, string>();
let dispatch: DispatchService;
let queued: ReturnType<typeof recordDispatchQueue>;
const point = { latitude: 6.8013, longitude: -58.1551 };

async function entry(mode: string, selectedRun = runId) {
  const lines: string[] = [], errors: string[] = [];
  const code = await drillFixturesMain([mode, '--run-id', selectedRun], environment, { out: (s) => lines.push(s), err: (s) => errors.push(s) }, { client: async () => db });
  return { code, value: lines[0] ? JSON.parse(lines[0]) : null, errors };
}
async function session(userId: string) {
  const token = app.jwt.sign({ userId, role: 'MOVER', jti: nanoid() });
  await db.session.create({ data: { userId, token, refreshToken: nanoid(48), deviceId: 'crash-isolation-test', deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } });
  tokens.set(userId, token);
  return token;
}
async function goOnline(token: string) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/rider/go-online', headers: { authorization: `Bearer ${token}`, 'x-tenant-id': scope.tenantId }, payload: { ...point, tenantId: scope.tenantId } });
  expect(r.statusCode, r.body).toBe(200);
}
async function order() {
  const o = await db.order.create({ data: { tenantId: scope.tenantId, orderNumber: `CR-${nanoid(12)}`, customerId: scope.customer.userId, vendorId: scope.store.vendorId, orderType: 'FOOD_DELIVERY', status: 'ACCEPTED', fulfillment: 'DELIVERY', pickupAddress: 'Synthetic pickup', pickupLat: point.latitude, pickupLng: point.longitude, deliveryAddress: 'Synthetic delivery', deliveryLat: point.latitude + 0.001, deliveryLng: point.longitude + 0.001, subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 500, totalAmount: 2000, paymentMethod: 'CASH' } });
  orders.push(o.id);
  return o;
}
async function noOutsideOffer(orderId: string) {
  expect(await app.redis.get(`dispatch:mover-offer:${outsiderRider}`)).toBeNull();
  expect(await db.alertDelivery.count({ where: { subjectId: orderId, recipientId: outsiderId } })).toBe(0);
  expect(await db.notification.count({ where: { userId: outsiderId, data: { path: ['orderId'], equals: orderId } } })).toBe(0);
}

beforeAll(async () => {
  priorIdentity = !!await db.deploymentIdentity.findUnique({ where: { id: 'singleton' } });
  if (!priorIdentity) await db.deploymentIdentity.create({ data: { id: 'singleton', deploymentId: 'staging-drills-test', environment: 'test' } });
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  queued = recordDispatchQueue(app);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();
  dispatch = new DispatchService(db, app.redis, app.io, new HaversineMapsProvider(), async () => undefined);
});
afterAll(async () => {
  // Only this suite's synthetic graph; no shared pool mutation or Redis flush.
  await entry('crash-cleanup', `${runId}-wall`);
  if (scope && await db.tenant.findUnique({ where: { id: scope.tenantId } })) {
    const ids = [scope.admin, scope.customer, scope.storeOwner, ...scope.riders].map((a) => a.userId);
    await db.algoDecision.deleteMany({ where: { subjectId: { in: orders } } });
    await db.order.deleteMany({ where: { id: { in: orders } } });
    await db.vendor.deleteMany({ where: { id: scope.store.vendorId } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.tenant.update({ where: { id: scope.tenantId }, data: { purgeProtected: false } });
    await db.tenant.delete({ where: { id: scope.tenantId } });
  }
  if (outsiderId) {
    await db.identityKey.deleteMany({ where: { accountId: outsiderId } });
    await db.identityClusterMember.deleteMany({ where: { accountId: outsiderId } });
    await db.user.deleteMany({ where: { id: outsiderId } });
  }
  if (!priorIdentity) await db.deploymentIdentity.deleteMany({ where: { id: 'singleton', deploymentId: 'staging-drills-test' } });
  await db.$disconnect();
  await app.close();
});

describe('[AX387] crash lifetime isolation on the real admission and dispatch paths', () => {
  it('creates a protected run-only synthetic tenant; its printed manifest is the runner contract', async () => {
    const created = await entry('crash-create');
    expect(created.code, created.errors.join('\n')).toBe(0);
    scope = created.value;
    expect(scope.tenantId).toBe(crashTenantId(runId));
    const parser = await import(pathToFileURL(join(process.cwd(), '../../scripts/livetest/crash-scope.ts')).href);
    expect(parser.parseCrashScope(scope, runId, scope.target)).toEqual(scope);
    expect(await db.tenant.findUnique({ where: { id: scope.tenantId } })).toMatchObject({ kind: 'CRAWLER', purgeProtected: true });
    expect((await entry('crash-create')).value).toEqual(scope);
  });

  it('refuses before minting a tenant when the wall cannot be attested', async () => {
    const otherRun = `${runId}-wall`;
    const target = { ...scope.target, posture: 'test' as const, host: 'localhost', port: '5434' };
    const unavailableWall = { $queryRaw: async () => { throw new Error('wall attestation unavailable'); } } as unknown as PrismaClient;
    await expect(createCrashFixtures(db, otherRun, target, unavailableWall)).rejects.toThrow('wall attestation unavailable');
    expect(await db.tenant.findUnique({ where: { id: crashTenantId(otherRun) } })).toBeNull();
  });

  it('refuses an existing run tenant after its provenance changes, with every actor untouched', async () => {
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: scope.tenantId } });
    await db.tenant.update({ where: { id: scope.tenantId }, data: { name: 'Another tenant operator' } });
    const before = JSON.stringify(await db.user.findMany({ where: { tenantId: scope.tenantId }, orderBy: { id: 'asc' } }));
    try {
      const retry = await entry('crash-create');
      expect(retry.code).toBe(1);
      expect(retry.errors.join(' ')).toContain('CRASH_ISOLATION_REQUIRED');
      expect(JSON.stringify(await db.user.findMany({ where: { tenantId: scope.tenantId }, orderBy: { id: 'asc' } }))).toBe(before);
    } finally {
      await db.tenant.update({ where: { id: scope.tenantId }, data: { name: tenant.name } });
    }
  });

  it('ordinary signup and partner activation cannot select the crash tenant through body or headers', async () => {
    const phone = `+592041${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    const registrationProof = await registrationProofFor(app, phone);
    const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { 'x-tenant-id': scope.tenantId }, payload: { phone, firstName: 'Synthetic', lastName: 'Outside crash', role: 'CUSTOMER', acceptTerms: true, registrationProof, tenantId: scope.tenantId } });
    expect(registered.statusCode, registered.body).toBe(201);
    outsiderId = registered.json().data.user.id;
    outsiderToken = registered.json().data.tokens.accessToken;
    const joined = await app.inject({ method: 'POST', url: '/api/v1/partner/become', headers: { authorization: `Bearer ${outsiderToken}`, 'x-tenant-id': scope.tenantId }, payload: { role: 'MOVER', vehicleType: 'MOTORCYCLE', acceptAgreement: true, tenantId: scope.tenantId } });
    expect(joined.statusCode, joined.body).toBe(201);
    expect((await db.user.findUniqueOrThrow({ where: { id: outsiderId } })).tenantId).toBe('swift-default');
    const rider = await db.rider.findUniqueOrThrow({ where: { userId: outsiderId } });
    outsiderRider = rider.id;
    await db.user.update({ where: { id: outsiderId }, data: { selfieCapturedAt: new Date() } });
    await db.rider.update({ where: { id: rider.id }, data: { documentsVerified: true, floatLimit: 1_000_000 } });
    expect((await entry('crash-read')).code).toBe(0);
  });

  it('an outside rider going online after preflight receives no initial or failure-recovery offer', async () => {
    expect((await entry('crash-read')).code).toBe(0);
    await goOnline(outsiderToken);
    for (const rider of scope.riders) await goOnline(await session(rider.userId));
    const o = await order();
    const eligible = await dispatch.findCandidates(o.id, { lat: point.latitude, lng: point.longitude }, 3, 'RIDER', 0, null, 'swift-default');
    expect(eligible.map((r) => r.riderId)).toContain(outsiderRider);
    const sent = await dispatch.dispatchOrder(o.id);
    expect(scope.riders.map((r) => r.riderId)).toContain(sent.offered);
    await noOutsideOffer(o.id);
    // Setup failure/process exit cannot remove the tenant boundary. Drive the
    // actual timeout/recovery path after the first synthetic offer is declined.
    const first = scope.riders.find((r) => r.riderId === sent.offered)!;
    await dispatch.declineOffer(o.id, first.userId);
    await dispatch.dispatchOrder(o.id);
    await noOutsideOffer(o.id);
  });

  it('a non-roster rider coming online after a real handback still cannot receive the queued redispatch', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/rider/go-offline', headers: { authorization: `Bearer ${outsiderToken}` }, payload: {} });
    const o = await order();
    const sent = await dispatch.dispatchOrder(o.id);
    const winner = scope.riders.find((r) => r.riderId === sent.offered)!;
    expect(winner).toBeDefined();
    await dispatch.acceptOffer(o.id, winner.userId);
    const handed = await app.inject({ method: 'POST', url: `/api/v1/rider/orders/${o.id}/handback`, headers: { authorization: `Bearer ${tokens.get(winner.userId)}` }, payload: { reason: 'Synthetic drill handback before pickup' } });
    expect(handed.statusCode, handed.body).toBe(200);
    for (const rider of scope.riders) {
      const off = await app.inject({ method: 'POST', url: '/api/v1/rider/go-offline', headers: { authorization: `Bearer ${tokens.get(rider.userId)}` }, payload: {} });
      expect(off.statusCode, off.body).toBe(200);
    }
    await goOnline(outsiderToken);
    const job = queued.find((j) => j.name === 'dispatch-order' && j.data.orderId === o.id);
    expect(job).toBeDefined();
    await dispatch.dispatchOrder(o.id, job!.data.tenantId);
    await noOutsideOffer(o.id);
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).tenantId).toBe(scope.tenantId);
  });
  it('cleanup retains live recovery in its tenant, then removes only terminal fixtures atomically', async () => {
    const before = JSON.stringify(await db.user.findMany({ where: { tenantId: scope.tenantId }, orderBy: { id: 'asc' } }));
    const held = await entry('crash-cleanup');
    expect(held.code, held.errors.join(' ')).toBe(0);
    expect(held.value).toMatchObject({ tenant: 'kept', kept: [expect.stringContaining('nonterminal')] });
    expect(JSON.stringify(await db.user.findMany({ where: { tenantId: scope.tenantId }, orderBy: { id: 'asc' } }))).toBe(before);
    await db.order.updateMany({ where: { id: { in: orders } }, data: { status: 'CANCELLED' } });
    const done = await entry('crash-cleanup');
    expect(done.code, done.errors.join(' ')).toBe(0);
    expect(done.value).toMatchObject({ tenant: 'removed', removed: { users: 6, stores: 1, orders: 2 } });
    expect(await db.user.findUnique({ where: { id: outsiderId } })).not.toBeNull();
    expect((await entry('crash-cleanup')).value.tenant).toBe('absent');
  });

});

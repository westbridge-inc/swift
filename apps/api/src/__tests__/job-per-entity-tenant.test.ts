import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { PrismaClient, UserRole } from '@prisma/client';
import { createScopedProcessClient, prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { getTenantContext, runAsSystem, runWithoutTenant } from '../plugins/tenant-context';
import { inTenantOf } from '../jobs/queue';
import { algoConfig, invalidateAlgoConfig } from '../modules/algo/algo-config';
import { syntheticLocationOwner } from './helpers/online-mover';
import { grantSuiteCapability } from '../lib/test-target-lock';

grantSuiteCapability('unscoped-mutation');

// ---------------------------------------------------------------------------
// [L01 · tenant wall · job PR-2] A job that works for ONE tenant's object runs
// AS that tenant.
//
// The seven per-entity jobs (an order's auto-cancel/auto-complete, dispatch,
// offer timeout, route match, the vendor alert escalation, a vendor's search
// sync) ran with no tenant at all. Their tenant-owned reads and writes then
// depended on each caller passing the right tenant by hand; anything that
// relied on the ambient tenant (the dispatch candidate query among them) saw
// EVERY operator. Each now reads its object's tenant first and runs bound to
// it.
// ---------------------------------------------------------------------------

const SPOT = { lat: 6.71, lng: -57.61 }; // remote: no other suite's movers here
const PHONE = `+5920031${String(Math.floor(Math.random() * 900) + 100)}`;
const QUEUE_SRC = readFileSync(join(__dirname, '..', 'jobs', 'queue.ts'), 'utf8');
let app: FastifyInstance;
let dispatch: DispatchService;
let seq = 0;
const userIds: string[] = [];
const orderIds: string[] = [];
const algoRowIds: string[] = [];
let tenantB = '';
let vendorId = '';
let customerId = '';

async function makeRider(tenantId?: string) {
  seq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: `${PHONE}${String(seq).padStart(3, '0')}`, firstName: 'Job', lastName: `R${seq}`,
    roles: ['RIDER' as UserRole, 'CUSTOMER' as UserRole], activeRole: 'RIDER' as UserRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
    ...(tenantId ? { tenantId } : {}),
  } });
  userIds.push(user.id);
  const rider = await app.prisma.rider.create({ data: {
    userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit: 1_000_000,
    isOnline: true, isAvailable: true, locationSessionId: syntheticLocationOwner('job-tenant'),
    currentLat: SPOT.lat, currentLng: SPOT.lng, lastLocationUpdate: new Date(), averageRating: 5, acceptanceRate: 100,
  } });
  return rider.id;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  dispatch = new DispatchService(app.prisma, app.redis, app.io, new HaversineMapsProvider(), async () => {});
  await runWithoutTenant(async () => {
    const t = await app.prisma.tenant.create({ data: { name: 'Job Op B', slug: `job-b-${nanoid(6).toLowerCase()}` } });
    tenantB = t.id;
    seq += 1;
    const owner = await app.prisma.user.create({ data: { phone: `${PHONE}${String(seq).padStart(3, '0')}`, firstName: 'O', lastName: 'V', roles: ['VENDOR_OWNER' as UserRole], activeRole: 'VENDOR_OWNER' as UserRole } });
    userIds.push(owner.id);
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
    vendorId = (await app.prisma.vendor.create({ data: {
      ownerId: vo.id, name: `Job V ${nanoid(4)}`, slug: `job-v-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `${PHONE}999`,
      addressLine1: '1 Job St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: SPOT.lat, longitude: SPOT.lng,
    } })).id;
    seq += 1;
    customerId = (await app.prisma.user.create({ data: { phone: `${PHONE}${String(seq).padStart(3, '0')}`, firstName: 'C', lastName: 'J', roles: ['CUSTOMER' as UserRole], activeRole: 'CUSTOMER' as UserRole } })).id;
    userIds.push(customerId);
  });
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.algoConfig.deleteMany({ where: { id: { in: algoRowIds } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.prisma.tenant.deleteMany({ where: { id: tenantB } });
  });
  await app.close();
});

async function orderIn(tenantId?: string) {
  const o = await runWithoutTenant(() => app.prisma.order.create({ data: {
    orderNumber: `JOB-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, status: 'ACCEPTED',
    deliveryAddress: 'x', deliveryLat: SPOT.lat, deliveryLng: SPOT.lng, pickupLat: SPOT.lat, pickupLng: SPOT.lng, pickupAddress: 'v',
    subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
    ...(tenantId ? { tenantId } : {}),
  } }));
  orderIds.push(o.id);
  return o;
}

describe('[L01 · job PR-2] per-entity jobs run as their object’s tenant', () => {
  it('a job for an order runs bound to THAT order’s tenant; a vendor job to the vendor’s; a vanished object stays named system work', async () => {
    const a = await orderIn();
    const b = await orderIn(tenantB);
    const inside = (entity: Parameters<typeof inTenantOf>[1]) =>
      runAsSystem('job:test:per-entity', () => inTenantOf(app.prisma, entity, async () => getTenantContext()));
    expect(await inside({ order: a.id })).toMatchObject({ tenantId: 'swift-default', mode: 'request' });
    expect(await inside({ order: b.id })).toMatchObject({ tenantId: tenantB, mode: 'request' });
    expect(await inside({ vendor: vendorId })).toMatchObject({ tenantId: 'swift-default', mode: 'request' });
    expect(await inside({ order: `gone-${nanoid(6)}` })).toMatchObject({ tenantId: null, mode: 'system', capability: 'job:test:per-entity' });
  });

  it('a dispatch for tenant B’s order never reads tenant A’s movers — even where the candidate query relies on the ambient tenant', async () => {
    const riderA = await makeRider();
    const riderB = await makeRider(tenantB);
    const orderB = await orderIn(tenantB);
    const orderA = await orderIn();
    // The candidate query with the tenant left to the ambient context (the
    // default argument): bound by the job to the order's tenant.
    const ambient = (orderId: string) => runAsSystem('job:dispatch-jobs:dispatch-order', () =>
      inTenantOf(app.prisma, { order: orderId }, () => dispatch.findCandidates(orderId, SPOT, 5, 'RIDER', 0, null)));
    const forB = (await ambient(orderB.id)).map((c) => c.riderId);
    expect(forB).toContain(riderB);
    expect(forB).not.toContain(riderA);
    const forA = (await ambient(orderA.id)).map((c) => c.riderId);
    expect(forA).toContain(riderA);
    expect(forA).not.toContain(riderB);
    await runWithoutTenant(() => app.prisma.rider.updateMany({ where: { id: { in: [riderA, riderB] } }, data: { isOnline: false, isAvailable: false } }));
  });

  it('in the dedicated worker process too: on the worker’s own client the binding walls every tenant-owned read, not only the candidate query', async () => {
    // [DS704 S1] The binding is async-context state; only a client built with
    // the tenant scoping obeys it. The standalone worker builds its client with
    // createScopedProcessClient (master075 pins worker.ts to exactly that
    // construction), so the per-entity binding is graded on such a client: a
    // read that relies on the AMBIENT tenant (no tenantId of its own, like the
    // dispatch safety exclusions) sees only the object's tenant.
    const worker = createScopedProcessClient({ datasourceUrl: process.env['DATABASE_URL'] }) as PrismaClient;
    try {
      const workerDispatch = new DispatchService(worker, app.redis, app.io, new HaversineMapsProvider(), async () => {});
      const riderA = await makeRider();
      const riderB = await makeRider(tenantB);
      const orderA = await orderIn();
      const orderB = await orderIn(tenantB);
      const asJob = <T>(orderId: string, fn: () => Promise<T>) =>
        runAsSystem('job:dispatch-jobs:dispatch-order', () => inTenantOf(worker, { order: orderId }, fn));
      const ordersSeen = await asJob(orderB.id, () => worker.order.findMany({ where: { id: { in: [orderA.id, orderB.id] } }, select: { id: true } }));
      expect(ordersSeen.map((o) => o.id)).toEqual([orderB.id]);
      const moverUsers = await runWithoutTenant(() => app.prisma.rider.findMany({ where: { id: { in: [riderA, riderB] } }, select: { id: true, userId: true } }));
      const userOf = (riderId: string) => moverUsers.find((r) => r.id === riderId)!.userId;
      const usersSeen = await asJob(orderB.id, () => worker.user.findMany({ where: { id: { in: [userOf(riderA), userOf(riderB)] } }, select: { id: true } }));
      expect(usersSeen.map((u) => u.id)).toEqual([userOf(riderB)]);
      const forB = (await asJob(orderB.id, () => workerDispatch.findCandidates(orderB.id, SPOT, 5, 'RIDER', 0, null))).map((c) => c.riderId);
      expect(forB).toContain(riderB);
      expect(forB).not.toContain(riderA);
      await runWithoutTenant(() => app.prisma.rider.updateMany({ where: { id: { in: [riderA, riderB] } }, data: { isOnline: false, isAvailable: false } }));
    } finally {
      await worker.$disconnect();
    }
  });

  it('a tunable read inside a bound job resolves the tenant it NAMES, and the cache never holds another tenant’s value under that name', async () => {
    // [DS704 S3] algoConfig takes its tenant explicitly ("a tunable silently
    // resolving to the wrong operator's value is worse than one that cannot be
    // read"). Inside a job bound to its object's tenant, the ambient tenant must
    // not replace the named one — nor be cached under the named one's key.
    const named = `job-algo-named-${nanoid(6)}`;
    const key = 'fairness.band' as const;
    const rows = await runWithoutTenant(() => Promise.all([
      app.prisma.algoConfig.create({ data: { tenantId: named, key, value: 7, version: 1, updatedBy: 'job-per-entity-tenant.test' } }),
      app.prisma.algoConfig.create({ data: { tenantId: tenantB, key, value: 3, version: 1, updatedBy: 'job-per-entity-tenant.test' } }),
    ]));
    algoRowIds.push(...rows.map((r) => r.id));
    invalidateAlgoConfig(named, key);
    invalidateAlgoConfig(tenantB, key);
    const orderB = await orderIn(tenantB);
    try {
      const inJob = await runAsSystem('job:dispatch-jobs:dispatch-order', () =>
        inTenantOf(app.prisma, { order: orderB.id }, () => algoConfig(app.prisma, key, named)));
      expect(inJob).toMatchObject({ value: 7, version: 1, source: 'config' });
      // what the job cached under the named tenant is the named tenant's value
      expect(await runAsSystem('job:test:per-entity', () => algoConfig(app.prisma, key, named))).toMatchObject({ value: 7, source: 'config' });
      // and the bound tenant's own dial is still its own
      expect(await runAsSystem('job:test:per-entity', () => algoConfig(app.prisma, key, tenantB))).toMatchObject({ value: 3, source: 'config' });
    } finally {
      invalidateAlgoConfig(named, key);
      invalidateAlgoConfig(tenantB, key);
    }
  });

  it('every per-entity job has exactly one handler site, and no per-entity handler is called unbound', () => {
    // [DS704 S4] The census below reads the FIRST site of each job name; a
    // second, unwrapped site for the same name must not hide behind it.
    const count = (re: RegExp) => (QUEUE_SRC.match(new RegExp(re.source, 'g')) ?? []).length;
    for (const anchor of [/case 'auto-cancel':/, /case 'auto-complete':/, /job\.name === 'dispatch-order'/, /job\.name === 'offer-timeout'/,
      /job\.name === 'route-match'/, /job\.name !== 'vendor-alert-escalate'/, /job\.name !== 'sync-vendor'/]) {
      expect(count(anchor), String(anchor)).toBe(1);
    }
    for (const call of ['autoCancelUnresponsiveOrder\\(ctx,', 'autoCompleteDeliveredOrder\\(ctx,', 'dispatch\\.dispatchOrder\\(', 'dispatch\\.handleOfferTimeout\\(',
      'matchOrderRoute\\(', 'escalateVendorAlert\\(']) {
      const all = count(new RegExp(call));
      expect(all, call).toBeGreaterThan(0);
      expect(count(new RegExp(`\\(\\) =>\\s*${call}`)), `${call} is called only inside inTenantOf`).toBe(all);
    }
  });

  it('every per-entity job handler is bound through inTenantOf', () => {
    const block = (from: RegExp, len = 900) => { const i = QUEUE_SRC.search(from); expect(i, String(from)).toBeGreaterThan(-1); return QUEUE_SRC.slice(i, i + len); };
    expect(block(/case 'auto-cancel':/, 200)).toMatch(/inTenantOf\(ctx\.prisma, \{ order: job\.data\.orderId \}, \(\) => autoCancelUnresponsiveOrder/);
    expect(block(/case 'auto-complete':/, 200)).toMatch(/inTenantOf\(ctx\.prisma, \{ order: job\.data\.orderId \}, \(\) => autoCompleteDeliveredOrder/);
    expect(block(/job\.name === 'dispatch-order'/)).toMatch(/inTenantOf\(ctx\.prisma, \{ order: job\.data\.orderId \}, \(\) =>\s+dispatch\.dispatchOrder/);
    expect(block(/job\.name === 'offer-timeout'/, 300)).toMatch(/inTenantOf\(ctx\.prisma, \{ order: job\.data\.orderId \}, \(\) => dispatch\.handleOfferTimeout/);
    expect(block(/job\.name === 'route-match'/)).toMatch(/inTenantOf\(ctx\.prisma, \{ order: routeOrderId \}, \(\) => matchOrderRoute/);
    expect(block(/job\.name !== 'vendor-alert-escalate'/, 600)).toMatch(/inTenantOf\(ctx\.prisma, \{ order: orderId \}, \(\) => escalateVendorAlert/);
    expect(block(/job\.name !== 'sync-vendor'/, 600)).toMatch(/inTenantOf\(ctx\.prisma, \{ vendor: vendorId \}/);
  });
});

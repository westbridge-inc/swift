import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { getTenantContext, runAsSystem, runWithoutTenant } from '../plugins/tenant-context';
import { inTenantOf } from '../jobs/queue';
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

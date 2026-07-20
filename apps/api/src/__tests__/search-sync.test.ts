import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { createQueues } from '../jobs/queue';

// ---------------------------------------------------------------------------
// SWIFT-UG-SRCH-01 — search synced only at boot / manual admin reindex, so a
// new or edited or 86'd item drifted out of truth until a restart. Catalog
// writes now schedule a DEBOUNCED per-vendor sync job (BullMQ jobId is the
// debounce). These tests pin the scheduling seam — no worker is started, so
// nothing touches Meilisearch (which CI doesn't run).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let queues: ReturnType<typeof createQueues>;
let token: string;
let vendorId: string;
let ownerUserId: string;
let categoryId: string;

const jobId = () => `search-sync-${vendorId}`;

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });

  // Real BullMQ queues on the test redis; NO workers — jobs sit delayed where
  // the assertions can see them. Decorate BEFORE ready (Fastify forbids after).
  await app.after(async () => {
    queues = createQueues(app.redis);
    app.decorate('queues', queues);
  });
  await app.ready();

  const owner = await app.prisma.user.create({
    data: {
      phone: '+5920079101', firstName: 'Sync', lastName: 'Owner',
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  ownerUserId = owner.id;
  token = app.jwt.sign({ userId: owner.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: owner.id, token, refreshToken: nanoid(48), deviceId: 'search-sync', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) },
  });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Sync Diner', slug: `sync-diner-${nanoid(6)}`,
      vendorType: 'RESTAURANT', phone: '+5920079101', addressLine1: '1 Sync St',
      city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
  const category = await app.prisma.category.create({
    data: { vendorId, name: 'Sync Mains', sortOrder: 0 },
  });
  categoryId = category.id;
});

afterAll(async () => {
  // Every predicate is guarded: a beforeAll failure must never leave an
  // undefined in a where-clause (deleteMany({vendorId: undefined}) means ALL).
  if (queues) {
    if (vendorId) await queues.searchQueue.remove(jobId()).catch(() => {});
    await Promise.all(Object.values(queues).map((q) => q.close()));
  }
  if (vendorId) {
    await app.prisma.item.deleteMany({ where: { vendorId } });
    await app.prisma.category.deleteMany({ where: { vendorId } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  }
  if (ownerUserId) {
    await app.prisma.vendorOwner.deleteMany({ where: { userId: ownerUserId } });
    await app.prisma.session.deleteMany({ where: { userId: ownerUserId } });
    await app.prisma.user.deleteMany({ where: { id: ownerUserId } });
  }
  await app.close();
});

function createItem(name: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/vendor/items',
    payload: { categoryId, name, basePrice: 1500 },
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
}

describe('on-write search sync scheduling [SWIFT-UG-SRCH-01]', () => {
  it('an item write schedules the debounced per-vendor sync job', async () => {
    const res = await createItem('Sync Pepperpot');
    expect([200, 201]).toContain(res.statusCode);

    const job = await queues.searchQueue.getJob(jobId());
    expect(job).toBeTruthy();
    expect(job!.name).toBe('sync-vendor');
    expect(job!.data).toMatchObject({ vendorId });
  });

  it('a burst of writes collapses to ONE delayed job (jobId debounce)', async () => {
    await createItem('Sync Cook-Up');
    await createItem('Sync Roti');
    await createItem('Sync Chowmein');

    const delayed = await queues.searchQueue.getDelayed();
    const mine = delayed.filter((j) => j.id === jobId());
    expect(mine).toHaveLength(1); // the CSV-import / rapid-edit case
  });

  it('item update and delete schedule too (delete also drops its own doc inline)', async () => {
    const created = await createItem('Sync Bake');
    const itemId = created.json().data?.id ?? created.json().data?.item?.id;
    expect(itemId).toBeTruthy();

    // Clear the pending job so each write's scheduling is provable.
    await queues.searchQueue.remove(jobId()).catch(() => {});

    const upd = await app.inject({
      method: 'PUT',
      url: `/api/v1/vendor/items/${itemId}`,
      payload: { isAvailable: false },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    expect(upd.statusCode).toBe(200);
    expect(await queues.searchQueue.getJob(jobId())).toBeTruthy();

    await queues.searchQueue.remove(jobId()).catch(() => {});
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/vendor/items/${itemId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(200);
    expect(await queues.searchQueue.getJob(jobId())).toBeTruthy();
  });
});

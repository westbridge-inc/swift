import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RatingService } from '../modules/rating/rating.service';
import { RatingStatsService } from '../modules/rating/rating-stats.service';
import { scheduleVendorSearchSync } from '../modules/search/search-sync';
import { registerErrorHandler } from '../middleware/error-handler';
import { createQueues } from '../jobs/queue';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';

// ---------------------------------------------------------------------------
// E26 (S2, the rating half): a new rating moves vendor.averageRating /
// totalRatings in the database, but the search index kept the old stars — the
// only catalog write with no scheduleVendorSearchSync after it. A rating that
// re-levels a VENDOR aggregate must schedule the debounced per-vendor sync
// through the same seam the other search-sync tests pin (real BullMQ queues,
// NO workers — jobs sit delayed where getJob can see them). A mover-only
// rating has no search document and must schedule nothing. The same contract
// is pinned here for the other two E26 writers: the admin moderate/exclude
// path (admin.routes.ts) and the flag-ratings outbox STATS replay (queue.ts).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let queues: ReturnType<typeof createQueues>;
let token: string;
let adminToken: string;
let customerId: string;
let ownerUserId: string;
let ownerId: string;
let vendorId: string;
let riderUserId: string;
let riderId: string;

const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
const createdVendorIds: string[] = [];
let seq = 0;
// Unique prefix: grepped the monorepo — `592_605` appears nowhere else and is
// not the live +592600 Digicel range.
const phoneBase = 592_605_000_000 + Math.floor(Math.random() * 90_000_000);

const jobId = () => `search-sync-${vendorId}`;

async function mkUser(first: string, roles: Array<'CUSTOMER' | 'VENDOR_OWNER' | 'RIDER' | 'ADMIN'>) {
  seq += 1;
  const u = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: first, lastName: `Sync${seq}`,
      roles, activeRole: roles[0]!, isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(u.id);
  return u;
}

async function tokenFor(userId: string, role: 'CUSTOMER' | 'VENDOR_OWNER' | 'RIDER' | 'ADMIN') {
  const t = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { authMethod: 'OTP', userId, token: t, refreshToken: nanoid(48), deviceId: 'e26-search-sync', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return t;
}

async function mkOrder(customer: string, vendor: string | undefined, rider: string | undefined) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `E26-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
      customerId: customer,
      ...(vendor ? { vendorId: vendor } : {}),
      ...(rider ? { riderId: rider } : {}),
      status: 'DELIVERED', deliveredAt: new Date(),
      deliveryAddress: '1 E26 St', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

async function mkVendor(name: string) {
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId, name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${nanoid(6)}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + ++seq}`,
      addressLine1: '1 E26 St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  return vendor;
}

function rate(orderId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/customer/orders/${orderId}/rate`,
    payload,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
}

/** scheduleVendorSearchSync is fire-and-forget, so poll the same seam the
 *  other search-sync tests read instead of racing the BullMQ add(). */
async function waitForJob(id: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await queues.searchQueue.getJob(id);
    if (job) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });

  // Real BullMQ queues on the test redis; NO workers — jobs sit delayed where
  // the assertions can see them. Decorate BEFORE ready (Fastify forbids after).
  await app.after(async () => {
    queues = createQueues(app.redis);
    app.decorate('queues', queues);
  });
  await app.ready();

  const owner = await mkUser('E26 Owner', ['VENDOR_OWNER']);
  ownerUserId = owner.id;
  const vo = await app.prisma.vendorOwner.upsert({ where: { userId: owner.id }, create: { userId: owner.id }, update: {} });
  ownerId = vo.id;
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'E26 Diner', slug: `e26-diner-${nanoid(6)}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + ++seq}`,
      addressLine1: '1 E26 St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorId = vendor.id;

  const customer = await mkUser('E26 Customer', ['CUSTOMER']);
  customerId = customer.id;
  token = await tokenFor(customer.id, 'CUSTOMER');

  const admin = await mkUser('E26 Admin', ['ADMIN']);
  adminToken = await tokenFor(admin.id, 'ADMIN');

  const riderUser = await mkUser('E26 Rider', ['RIDER']);
  riderUserId = riderUser.id;
  const rider = await app.prisma.rider.create({
    data: { userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true },
  });
  riderId = rider.id;
});

afterAll(async () => {
  // A beforeAll failure before prismaPlugin decorates app.prisma must not
  // turn the cleanup into a TypeError — guard the whole tail (sibling-suites
  // pattern), then close whatever booted.
  if (!app?.prisma) { await app?.close(); return; }
  // Every predicate is guarded: a beforeAll failure must never leave an
  // undefined in a where-clause (deleteMany({vendorId: undefined}) means ALL).
  if (queues) {
    if (vendorId) await queues.searchQueue.remove(jobId()).catch(() => {});
    for (const id of createdVendorIds) await queues.searchQueue.remove(`search-sync-${id}`).catch(() => {});
    await Promise.all(Object.values(queues).map((q) => q.close()));
  }
  const ratings = await app.prisma.rating.findMany({ where: { orderId: { in: createdOrderIds } }, select: { id: true } });
  await app.prisma.ratingOutbox.deleteMany({ where: { ratingId: { in: ratings.map((r) => r.id) } } }).catch(() => {});
  await app.prisma.rating.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
  await app.prisma.actorRatingStat.deleteMany({ where: { subjectId: { in: [vendorId, riderUserId, ...createdVendorIds, ...createdUserIds].filter((id): id is string => Boolean(id)) } } }).catch(() => {});
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => {});
  if (riderId) await app.prisma.rider.deleteMany({ where: { id: riderId } }).catch(() => {});
  if (vendorId) await app.prisma.vendor.deleteMany({ where: { id: vendorId } }).catch(() => {});
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } }).catch(() => {});
  if (ownerUserId) await app.prisma.vendorOwner.deleteMany({ where: { userId: ownerUserId } }).catch(() => {});
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
  await app.prisma.identityKey.deleteMany({ where: { accountId: { in: createdUserIds } } }).catch(() => {});
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
  await app.close();
});

describe('a rating that moves a vendor aggregate re-syncs the vendor [E26]', () => {
  it('a customer-to-vendor rating updates the store stars AND schedules the vendor sync', async () => {
    const order = await mkOrder(customerId, vendorId, undefined);
    const res = await rate(order.id, { vendorScore: 4 });
    expect(res.statusCode).toBe(200);

    // Durable state first: the write really moved the vendor aggregate.
    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
    expect(vendor.totalRatings).toBe(1);
    expect(vendor.averageRating).toBe(4);

    // Same seam as search-sync.test.ts: the debounced per-vendor job exists.
    const job = await waitForJob(jobId());
    expect(job).toBeTruthy();
    expect(job!.name).toBe('sync-vendor');
    expect(job!.data).toMatchObject({ vendorId });
  });

  it('a mover-only rating on the same store schedules nothing for the vendor', async () => {
    // Clear the vendor's pending sync so a new schedule is provable.
    await queues.searchQueue.remove(jobId()).catch(() => {});
    const vendorBefore = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });

    const order = await mkOrder(customerId, vendorId, riderId);
    const res = await rate(order.id, { riderScore: 3 });
    expect(res.statusCode).toBe(200);

    // The rider aggregate moved — the write really happened…
    const rider = await app.prisma.rider.findUniqueOrThrow({ where: { id: riderId } });
    expect(rider.totalRatings).toBe(1);
    expect(rider.averageRating).toBe(3);

    // …and the vendor aggregate did not move, so no vendor re-sync was scheduled.
    const vendorAfter = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
    expect(vendorAfter.totalRatings).toBe(vendorBefore.totalRatings);
    expect(vendorAfter.averageRating).toBe(vendorBefore.averageRating);

    // Give any (incorrect) schedule a beat to land, then prove none did.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await queues.searchQueue.getJob(jobId())).toBeUndefined(); // BullMQ answers undefined for a missing job
  });

  it('an admin exclusion of a VENDOR rating re-levels the store AND schedules its sync', async () => {
    const vendor = await mkVendor('E26 Admin Diner');
    const order = await mkOrder(customerId, vendor.id, undefined);
    const res = await rate(order.id, { vendorScore: 2 });
    expect(res.statusCode).toBe(200);
    const rating = await app.prisma.rating.findFirstOrThrow({ where: { orderId: order.id, type: 'CUSTOMER_TO_VENDOR' } });

    // The HTTP path scheduled its own debounced job; clear it so the admin
    // exclusion's schedule is the one this assertion sees.
    await queues.searchQueue.remove(`search-sync-${vendor.id}`).catch(() => {});
    const before = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(before.totalRatings).toBe(1);
    expect(before.averageRating).toBe(2);

    const mod = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/ratings/${rating.id}/moderate`,
      headers: { 'content-type': 'application/json', 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}` },
      payload: { action: 'exclude', category: 'MODERATION' },
    });
    expect(mod.statusCode).toBe(200);
    expect(mod.json().data).toMatchObject({ action: 'exclude' });

    // The exclusion re-levels the store's stars — ACTIVE rows only — back to
    // the unrated 5.0 prior with zero ratings.
    const after = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(after.totalRatings).toBe(0);
    expect(after.averageRating).toBe(5);

    // …and the same debounced seam every other vendor write uses fires.
    const job = await waitForJob(`search-sync-${vendor.id}`);
    expect(job).toBeTruthy();
    expect(job!.name).toBe('sync-vendor');
    expect(job!.data).toMatchObject({ vendorId: vendor.id });
  });

  it('the flag-ratings outbox sweep STATS replay re-levels the store AND schedules its sync', async () => {
    const vendor = await mkVendor('E26 Outbox Diner');
    const order = await mkOrder(customerId, vendor.id, undefined);
    // Write the rating row and its still-owed STATS command directly — the
    // outbox exists for exactly this process-died-first case, which is what
    // the flag-ratings sweep in queue.ts replays.
    const rating = await app.prisma.rating.create({
      data: { orderId: order.id, raterId: customerId, vendorId: vendor.id, type: 'CUSTOMER_TO_VENDOR', score: 3 },
    });
    await app.prisma.ratingOutbox.create({ data: { ratingId: rating.id, command: 'STATS' } });

    // Same construction as the queue.ts flag-ratings handler: RatingService
    // builds RatingStatsService with the { queues, log } callback, and the
    // STATS replay re-levels the vendor then schedules its sync. Scoped to
    // this rating to stay hermetic; the sweep's per-row path is identical.
    const svc = new RatingService(
      app.prisma,
      app.io,
      (movedVendorId) => scheduleVendorSearchSync({ queues, log: app.log }, movedVendorId),
    );
    const outbox = await svc.processRatingOutbox({ ratingId: rating.id });
    expect(outbox).toMatchObject({ processed: 1, failed: 0 });

    const vendorAfter = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(vendorAfter.totalRatings).toBe(1);
    expect(vendorAfter.averageRating).toBe(3);

    const job = await waitForJob(`search-sync-${vendor.id}`);
    expect(job).toBeTruthy();
    expect(job!.name).toBe('sync-vendor');
    expect(job!.data).toMatchObject({ vendorId: vendor.id });
  });

  it('the nightly sweep re-syncs a store whose stars drifted, and then leaves the in-sync store alone', async () => {
    const vendor = await mkVendor('E26 Nightly Diner');
    const order = await mkOrder(customerId, vendor.id, undefined);
    expect((await rate(order.id, { vendorScore: 4 })).statusCode).toBe(200);
    // Drift: the stored stars no longer match the ACTIVE rows, the exact case
    // the nightly healer exists for.
    await app.prisma.vendor.update({ where: { id: vendor.id }, data: { averageRating: 1, totalRatings: 9 } });
    await queues.searchQueue.remove(`search-sync-${vendor.id}`).catch(() => {});

    // Same construction as the queue.ts 'rating-stats-recompute' handler.
    const nightly = () => new RatingStatsService(
      app.prisma,
      (movedVendorId) => scheduleVendorSearchSync({ queues, log: app.log }, movedVendorId),
    ).recomputeAll();

    await nightly();
    const healed = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(healed.totalRatings).toBe(1);
    expect(healed.averageRating).toBe(4);
    const job = await waitForJob(`search-sync-${vendor.id}`);
    expect(job).toBeTruthy();
    expect(job!.data).toMatchObject({ vendorId: vendor.id });

    // In sync now: a second sweep re-writes nothing and schedules nothing for
    // this store, so the nightly run is not a per-store queue flood.
    const touched = healed.updatedAt.getTime();
    await queues.searchQueue.remove(`search-sync-${vendor.id}`).catch(() => {});
    await nightly();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await queues.searchQueue.getJob(`search-sync-${vendor.id}`)).toBeUndefined(); // BullMQ answers undefined for a missing job
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).updatedAt.getTime()).toBe(touched);
  });
});

describe('[E26] queue.ts wires the search callback into both rating sweeps', () => {
  // The two sweeps run inside createWorkers closures (booting real workers is
  // out of scope for a unit suite), so their wiring is read as source: each
  // constructs its rating service with the per-vendor search schedule.
  const src = readFileSync(join(__dirname, '../jobs/queue.ts'), 'utf8');
  const CALLBACK = /\(vendorId\) => scheduleVendorSearchSync\(\{ queues, log: ctx\.log \}, vendorId\)/;

  it('the flag-ratings outbox replay constructs RatingService with the search callback', () => {
    const replay = src.slice(src.indexOf('const outbox = await new RatingService('), src.indexOf('const outbox = await new RatingService(') + 300);
    expect(replay).toMatch(CALLBACK);
  });

  it('the nightly rating-stats-recompute constructs RatingStatsService with the search callback', () => {
    const nightly = src.slice(src.indexOf("job.name === 'rating-stats-recompute'"), src.indexOf("job.name === 'rating-actor-fold'"));
    expect(nightly).toMatch(/new RatingStatsService\(\s*ctx\.prisma,/);
    expect(nightly).toMatch(CALLBACK);
  });
});

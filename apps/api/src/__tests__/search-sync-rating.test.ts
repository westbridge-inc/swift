import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { createQueues } from '../jobs/queue';

// ---------------------------------------------------------------------------
// E26 (S2, the rating half): a new rating moves vendor.averageRating /
// totalRatings in the database, but the search index kept the old stars — the
// only catalog write with no scheduleVendorSearchSync after it. A rating that
// re-levels a VENDOR aggregate must schedule the debounced per-vendor sync
// through the same seam the other search-sync tests pin (real BullMQ queues,
// NO workers — jobs sit delayed where getJob can see them). A mover-only
// rating has no search document and must schedule nothing.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let queues: ReturnType<typeof createQueues>;
let token: string;
let customerId: string;
let ownerUserId: string;
let vendorId: string;
let riderUserId: string;
let riderId: string;

const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;
// Unique prefix: grepped the monorepo — `592_605` appears nowhere else and is
// not the live +592600 Digicel range.
const phoneBase = 592_605_000_000 + Math.floor(Math.random() * 90_000_000);

const jobId = () => `search-sync-${vendorId}`;

async function mkUser(first: string, roles: Array<'CUSTOMER' | 'VENDOR_OWNER' | 'RIDER'>) {
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

async function tokenFor(userId: string, role: 'CUSTOMER' | 'VENDOR_OWNER' | 'RIDER') {
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

  const riderUser = await mkUser('E26 Rider', ['RIDER']);
  riderUserId = riderUser.id;
  const rider = await app.prisma.rider.create({
    data: { userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true },
  });
  riderId = rider.id;
});

afterAll(async () => {
  // Every predicate is guarded: a beforeAll failure must never leave an
  // undefined in a where-clause (deleteMany({vendorId: undefined}) means ALL).
  if (queues) {
    if (vendorId) await queues.searchQueue.remove(jobId()).catch(() => {});
    await Promise.all(Object.values(queues).map((q) => q.close()));
  }
  const ratings = await app.prisma.rating.findMany({ where: { orderId: { in: createdOrderIds } }, select: { id: true } });
  await app.prisma.ratingOutbox.deleteMany({ where: { ratingId: { in: ratings.map((r) => r.id) } } }).catch(() => {});
  await app.prisma.rating.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => {});
  await app.prisma.actorRatingStat.deleteMany({ where: { subjectId: { in: [vendorId, riderUserId, ...createdUserIds].filter((id): id is string => Boolean(id)) } } }).catch(() => {});
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => {});
  if (riderId) await app.prisma.rider.deleteMany({ where: { id: riderId } }).catch(() => {});
  if (vendorId) await app.prisma.vendor.deleteMany({ where: { id: vendorId } }).catch(() => {});
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
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { registerErrorHandler } from '../middleware/error-handler';
import { reconcileStuckDispatch } from '../modules/dispatch/dispatch.service';

// ---------------------------------------------------------------------------
// C1 (CRITICAL from the pre-launch audit): the dispatch offer key + the delayed
// BullMQ timeout job both live only in Redis. A Redis restart erases them and
// NOTHING else re-drives the order — a customer's accepted order silently never
// gets a mover. reconcileStuckDispatch is the self-heal. These tests prove it
// recovers genuinely-stranded orders and leaves healthy ones untouched.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdOrderIds: string[] = [];
let customerId: string;
let vendorId: string;

async function makeStuckOrder(status: OrderStatus, opts: { orderType?: string; fulfillment?: string; riderId?: string | null; driverId?: string | null } = {}) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `RC-${nanoid(10)}`,
      orderType: (opts.orderType as never) ?? 'FOOD_DELIVERY',
      customerId,
      ...(opts.orderType === 'TAXI' ? {} : { vendorId }),
      status,
      fulfillment: (opts.fulfillment as never) ?? 'DELIVERY',
      pickupAddress: 'x', pickupLat: 6.8, pickupLng: -58.15,
      deliveryAddress: 'y', deliveryLat: 6.81, deliveryLng: -58.16,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 500, totalAmount: 1500, paymentMethod: 'CASH',
      ...(opts.riderId ? { riderId: opts.riderId } : {}),
      ...(opts.driverId ? { driverId: opts.driverId } : {}),
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

const collector = () => {
  const enqueued: string[] = [];
  return { enqueue: async (id: string) => { enqueued.push(id); }, enqueued };
};

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.ready();

  const customer = await app.prisma.user.create({
    data: { phone: `+59247${String(Math.floor(Math.random() * 9e6) + 1e6)}`, firstName: 'Rc', lastName: 'Cust', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } },
  });
  customerId = customer.id;
  const ownerUser = await app.prisma.user.create({
    data: { phone: `+59247${String(Math.floor(Math.random() * 9e6) + 1e6)}`, firstName: 'Rc', lastName: 'Vend', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({
    data: { ownerId: owner.id, name: 'Rc Diner', slug: `rc-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+59247${nanoid(6)}`, addressLine1: '1 Rc', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE' },
  });
  vendorId = vendor.id;
  (createdOrderIds as string[]).push(); // noop to keep ref
  (app as any).__cleanupUsers = [customer.id, ownerUser.id];
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: (app as any).__cleanupUsers ?? [] } } });
  await app.close();
});

beforeEach(async () => {
  // clear any dispatch:* keys this suite may have set
  const keys = await app.redis.keys('dispatch:*');
  if (keys.length) await app.redis.del(...keys);
});

describe('reconcileStuckDispatch', () => {
  // negative stuckMinutes -> cutoff in the future -> any just-created order qualifies by time
  const NOW_STUCK = -1;

  it('re-enqueues a delivery order stranded with no rider and no offer key', async () => {
    const order = await makeStuckOrder('ACCEPTED');
    const { enqueue, enqueued } = collector();
    const res = await reconcileStuckDispatch(app.prisma, app.redis, enqueue, NOW_STUCK);
    expect(res.recovered).toContain(order.id);
    expect(enqueued).toContain(order.id);
    // a cooldown marker is set so it won't be re-driven immediately
    expect(await app.redis.get(`dispatch:reconciled:${order.id}`)).toBe('1');
  });

  it('re-enqueues a stranded TAXI (PENDING, no driver)', async () => {
    const ride = await makeStuckOrder('PENDING', { orderType: 'TAXI' });
    const { enqueue, enqueued } = collector();
    await reconcileStuckDispatch(app.prisma, app.redis, enqueue, NOW_STUCK);
    expect(enqueued).toContain(ride.id);
  });

  it('SKIPS an order that still has a live offer key (mid-cascade)', async () => {
    const order = await makeStuckOrder('PREPARING');
    await app.redis.set(`dispatch:offer:${order.id}`, 'some-rider', 'EX', 30);
    const { enqueue, enqueued } = collector();
    await reconcileStuckDispatch(app.prisma, app.redis, enqueue, NOW_STUCK);
    expect(enqueued).not.toContain(order.id);
  });

  it('SKIPS an order deliberately exhausted (awaiting vendor retry)', async () => {
    const order = await makeStuckOrder('READY_FOR_PICKUP');
    await app.redis.set(`dispatch:exhausts:${order.id}`, '2', 'EX', 3600);
    const { enqueue, enqueued } = collector();
    await reconcileStuckDispatch(app.prisma, app.redis, enqueue, NOW_STUCK);
    expect(enqueued).not.toContain(order.id);
  });

  it('two overlapping sweeps repair a stranded order exactly ONCE [REPORT-014 F-014-06]', async () => {
    const order = await makeStuckOrder('ACCEPTED');
    const { enqueue, enqueued } = collector();
    const [a, b] = await Promise.all([
      reconcileStuckDispatch(app.prisma, app.redis, enqueue, NOW_STUCK),
      reconcileStuckDispatch(app.prisma, app.redis, enqueue, NOW_STUCK),
    ]);
    expect(enqueued.filter((id) => id === order.id)).toHaveLength(1);
    expect([...a.recovered, ...b.recovered].filter((id) => id === order.id)).toHaveLength(1);
  });

  it('an enqueue failure releases the cooldown claim so the NEXT sweep can repair [REPORT-014 F-014-06]', async () => {
    const order = await makeStuckOrder('PREPARING');
    const broken = async () => { throw new Error('queue down'); };
    const r1 = await reconcileStuckDispatch(app.prisma, app.redis, broken, NOW_STUCK);
    expect(r1.recovered).not.toContain(order.id);
    // The claim was released — a dead queue must not suppress repair for 600s.
    expect(await app.redis.get(`dispatch:reconciled:${order.id}`)).toBeNull();

    const { enqueue, enqueued } = collector();
    const r2 = await reconcileStuckDispatch(app.prisma, app.redis, enqueue, NOW_STUCK);
    expect(enqueued).toContain(order.id);
    expect(r2.recovered).toContain(order.id);
  });

  it('SKIPS an order reconciled within the cooldown window', async () => {
    const order = await makeStuckOrder('ACCEPTED');
    await app.redis.set(`dispatch:reconciled:${order.id}`, '1', 'EX', 600);
    const { enqueue, enqueued } = collector();
    await reconcileStuckDispatch(app.prisma, app.redis, enqueue, NOW_STUCK);
    expect(enqueued).not.toContain(order.id);
  });

  it('SKIPS an already-assigned order, a PICKUP takeaway, and a fresh (not-yet-stuck) order', async () => {
    const assigned = await makeStuckOrder('RIDER_ASSIGNED', { riderId: null }); // status alone excludes it
    const takeaway = await makeStuckOrder('READY_FOR_PICKUP', { fulfillment: 'PICKUP' });
    const fresh = await makeStuckOrder('ACCEPTED');
    const { enqueue, enqueued } = collector();
    // positive threshold: `fresh` (updatedAt≈now) is NOT older than 60min, so skipped
    await reconcileStuckDispatch(app.prisma, app.redis, enqueue, 60);
    expect(enqueued).not.toContain(assigned.id);
    expect(enqueued).not.toContain(takeaway.id);
    expect(enqueued).not.toContain(fresh.id);
  });
});

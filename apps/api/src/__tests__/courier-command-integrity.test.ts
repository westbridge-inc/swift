import { randomBytes } from 'node:crypto';
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { riderRoutes } from '../modules/rider/rider.routes';
import { OrderService, holdReleaseObserver, TERMINAL_ORDER_STATUSES } from '../modules/order/order.service';
import * as outbox from '../modules/order/checkout-outbox';
import { releaseHeldOrdersJob } from '../jobs/queue';
import { resetKeyProviderForTests } from '../providers/storage/envelope';

// Real HTTP, database transactions and a private BullMQ queue. No worker runs:
// its accepted jobs are inspected so duplicate publication cannot hide.
let app: FastifyInstance;
let queue: Queue;
const users: string[] = [];
const marker = `courier-command-${nanoid(8)}`;
const queues = () => ({ dispatchQueue: queue, orderQueue: queue, notificationQueue: queue });
const body = {
  pickup: { lat: 6.8013, lng: -58.1551 }, dropoff: { lat: 6.8149, lng: -58.1631 },
  pickupAddress: 'Synthetic pickup', dropoffAddress: 'Synthetic recipient address',
  recipientName: 'Synthetic recipient', recipientPhone: '0000000',
  packageSize: 'MEDIUM', speed: 'STANDARD', payer: 'SENDER',
};
type Actor = { userId: string; token: string };
async function actor(mover = false): Promise<Actor> {
  const user = await app.prisma.user.create({ data: {
    phone: `+592${Date.now()}${users.length}`, firstName: 'Synthetic', lastName: 'Courier',
    syntheticRunId: marker, roles: mover ? ['MOVER', 'CUSTOMER'] : ['CUSTOMER'],
    activeRole: mover ? 'MOVER' : 'CUSTOMER', trustLevel: 'L2',
    isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} },
  } });
  users.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: mover ? 'MOVER' : 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: marker, deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
  return { userId: user.id, token };
}
const post = (a: Actor, key?: string, payload: unknown = body) => app.inject({ method: 'POST', url: '/api/v1/courier/order', headers: { authorization: `Bearer ${a.token}`, ...(key === undefined ? {} : { 'idempotency-key': key }) }, payload: payload as Record<string, unknown> });
const read = (url: string, a?: Actor) => app.inject({ method: 'GET', url, headers: a ? { authorization: `Bearer ${a.token}` } : {} });
const rows = (orderId: string) => app.prisma.orderOutbox.findMany({ where: { orderId } });
async function due(orderId: string) {
  // Use the database clock: the host clock can lead it by milliseconds.
  await app.prisma.$executeRaw`UPDATE order_outbox SET "availableAt" = CURRENT_TIMESTAMP - INTERVAL '1 second', "claimedAt" = NULL WHERE "orderId" = ${orderId}`;
}
const drain = (orderId: string) => outbox.drainCheckoutOutbox({ prisma: app.prisma, queues: queues(), log: app.log }, { orderIds: [orderId] });
const jobsFor = async (orderId: string) => (await queue.getJobs(['waiting', 'delayed', 'prioritized'])).filter((j) => j.data.orderId === orderId);

beforeAll(async () => {
  vi.stubEnv('MAPS_PROVIDER', 'osrm'); vi.stubEnv('OSRM_URL', 'http://osrm.test');
  vi.stubEnv('LIFECYCLE_V2', '0');
  vi.stubEnv('MASTER_KEK', randomBytes(32).toString('base64')); resetKeyProviderForTests();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 8100, duration: 900 }] }))));
  const { default: courierRoutes } = await import('../modules/courier/courier.routes');
  app = Fastify({ logger: false }); registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  queue = new Queue(marker, { connection: app.redis.duplicate() as unknown as import('bullmq').ConnectionOptions });
  app.decorate('dispatchQueue', queue); app.decorate('queues', queues() as never);
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' }); await app.ready();
});
afterEach(async () => {
  vi.restoreAllMocks(); delete holdReleaseObserver.afterRelease;
  vi.stubEnv('LIFECYCLE_V2', '0');
  // Keep immutable order history, remove only this run's live competition.
  await app.prisma.order.updateMany({ where: { customerId: { in: users }, status: { notIn: TERMINAL_ORDER_STATUSES } }, data: { status: 'CANCELLED', holdExpiresAt: null } });
});
afterAll(async () => {
  await queue.obliterate({ force: true }); await queue.close();
  await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
  await app.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetKeyProviderForTests();
});

describe('courier creation is one durable command', () => {
  it('same key sequentially returns the identical answer, one order and one queue job', async () => {
    const a = await actor(); const key = nanoid(); const first = await post(a, key);
    expect(first.statusCode, first.body).toBe(201);
    const again = await post(a, key, { ...body, pickup: { lng: body.pickup.lng, lat: body.pickup.lat } });
    expect(again.statusCode, again.body).toBe(201); expect(again.body).toBe(first.body);
    expect(await app.prisma.order.count({ where: { customerId: a.userId } })).toBe(1);
    const id = first.json().data.orderId; await due(id); await drain(id);
    expect(await jobsFor(id)).toHaveLength(1);
    expect((await jobsFor(id))[0]!.opts.priority).toBe(5);
    const receipts = await app.prisma.checkoutReceipt.findMany({ where: { userId: a.userId } });
    expect(receipts).toHaveLength(1);
    expect(JSON.stringify(receipts)).not.toContain(first.json().data.trackingToken);
    expect(JSON.stringify(receipts)).not.toContain(body.recipientName);
  });
  it('concurrent same-key requests serialize to one committed result', async () => {
    const a = await actor(); const key = nanoid();
    const replies = await Promise.all([post(a, key), post(a, key), post(a, key)]);
    expect(replies.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    expect(new Set(replies.map((r) => r.body)).size).toBe(1);
    expect(await app.prisma.order.count({ where: { customerId: a.userId } })).toBe(1);
  });
  it('a changed nested coordinate under the same key refuses before another job', async () => {
    const a = await actor(); const key = nanoid(); expect((await post(a, key)).statusCode).toBe(201);
    const changed = await post(a, key, { ...body, dropoff: { ...body.dropoff, lat: body.dropoff.lat + 0.01 } });
    expect(changed.statusCode).toBe(422); expect(changed.json().error.code).toBe('IDEMPOTENCY_MISMATCH');
    expect(await app.prisma.order.count({ where: { customerId: a.userId } })).toBe(1);
  });
  it('keys are scoped to the sender and legacy unkeyed creation still works', async () => {
    const a = await actor(); const b = await actor(); const key = nanoid();
    const first = await post(a, key); const other = await post(b, key); const legacy = await post(a);
    expect([first.statusCode, other.statusCode, legacy.statusCode]).toEqual([201, 201, 201]);
    expect(new Set([first, other, legacy].map((r) => r.json().data.orderId)).size).toBe(3);
  });
  it.each(['', 'bad key', 'x'.repeat(201)])('rejects malformed key %j without a write', async (key) => {
    const a = await actor(); const res = await post(a, key);
    expect(res.statusCode).toBe(400); expect(await app.prisma.order.count({ where: { customerId: a.userId } })).toBe(0);
  });
  it('a sealed answer cannot be transplanted into another sender receipt', async () => {
    const a = await actor(); const b = await actor(); const key = nanoid();
    expect((await post(a, key)).statusCode).toBe(201); expect((await post(b, key)).statusCode).toBe(201);
    const first = await app.prisma.checkoutReceipt.findFirstOrThrow({ where: { userId: a.userId } });
    const second = await app.prisma.checkoutReceipt.findFirstOrThrow({ where: { userId: b.userId } });
    await app.prisma.checkoutReceipt.update({ where: { id: second.id }, data: { result: first.result! } });
    const res = await post(b, key); expect(res.statusCode).toBe(503);
    expect(await app.prisma.order.count({ where: { customerId: b.userId } })).toBe(1);
  });
  it('keyed creation without the envelope key refuses and writes nothing', async () => {
    const a = await actor(); vi.stubEnv('MASTER_KEK', ''); resetKeyProviderForTests();
    try {
      const res = await post(a, nanoid()); expect(res.statusCode).toBe(503);
      expect(await app.prisma.order.count({ where: { customerId: a.userId } })).toBe(0);
    } finally { vi.stubEnv('MASTER_KEK', randomBytes(32).toString('base64')); resetKeyProviderForTests(); }
  });
  it('an unrecordable receipt rolls the order and outbox back together', async () => {
    const a = await actor();
    let attemptedOrderId = ''; let commandsBeforeFailure = -1;
    vi.spyOn(outbox, 'persistCheckoutReceiptInTransaction').mockImplementationOnce(async (tx, input) => {
      attemptedOrderId = input.orderIds[0]!;
      commandsBeforeFailure = await tx.orderOutbox.count({ where: { orderId: attemptedOrderId } });
      throw new Error('synthetic receipt failure');
    });
    expect((await post(a, nanoid())).statusCode).toBe(500);
    expect(await app.prisma.order.count({ where: { customerId: a.userId } })).toBe(0);
    expect(attemptedOrderId).not.toBe(''); expect(commandsBeforeFailure).toBe(1);
    expect(await app.prisma.orderOutbox.count({ where: { orderId: attemptedOrderId } })).toBe(0);
  });
  it('queue outage after commit answers success; sweep and retry publish the same job', async () => {
    const a = await actor(); const key = nanoid(); const add = vi.spyOn(queue, 'add').mockRejectedValue(new Error('synthetic queue outage'));
    const first = await post(a, key); expect(first.statusCode, first.body).toBe(201);
    const id = first.json().data.orderId;
    expect(await rows(id)).toMatchObject([{ kind: 'dispatch-order', processedAt: null }]);
    add.mockRestore(); await due(id); expect(await drain(id)).toEqual({ processed: 1, failed: 0 });
    expect((await post(a, key)).body).toBe(first.body);
    // Crash after queue accepted but before marking the row: republish same ID.
    await app.prisma.orderOutbox.updateMany({ where: { orderId: id }, data: { processedAt: null } });
    await due(id); await drain(id); expect(await jobsFor(id)).toHaveLength(1);
  });
  it('replay uses the receipt without re-quoting and never restores revoked tracking', async () => {
    const a = await actor(); const key = nanoid(); const first = await post(a, key);
    expect(first.statusCode).toBe(201); const id = first.json().data.orderId;
    const revoked = await app.inject({ method: 'DELETE', url: `/api/v1/courier/order/${id}/tracking`, headers: { authorization: `Bearer ${a.token}` } });
    expect(revoked.statusCode).toBe(200);
    vi.mocked(fetch).mockClear(); expect((await post(a, key)).body).toBe(first.body); expect(fetch).not.toHaveBeenCalled();
    expect((await read(`/api/v1/courier/track/${first.json().data.trackingToken}`)).statusCode).toBe(404);
  });
});

describe('held courier dispatch survives release crashes', () => {
  it('commit then crash at release is recovered by the existing outbox sweep', async () => {
    vi.stubEnv('LIFECYCLE_V2', '1'); const a = await actor(); const created = await post(a, nanoid());
    expect(created.statusCode, created.body).toBe(201); const id = created.json().data.orderId;
    expect(await rows(id)).toHaveLength(0); expect(await jobsFor(id)).toHaveLength(0);
    await app.prisma.order.update({ where: { id }, data: { holdExpiresAt: new Date(Date.now() - 10000) } });
    holdReleaseObserver.afterRelease = async ({ orderId }) => { if (orderId === id) throw new Error('synthetic crash after release commit'); };
    const service = new OrderService(app.prisma, app.io, undefined, undefined, app.redis);
    await expect(service.releaseDueHeldOrders(async () => {})).rejects.toThrow('synthetic crash');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id } })).holdExpiresAt).toBeNull();
    expect(await rows(id)).toMatchObject([{ kind: 'dispatch-order', processedAt: null }]);
    delete holdReleaseObserver.afterRelease; await due(id); expect(await drain(id)).toEqual({ processed: 1, failed: 0 });
    await service.releaseDueHeldOrders(async () => {}); await drain(id); expect(await jobsFor(id)).toHaveLength(1);
  });
  it('worker fast publication and its outbox drain use one job ID', async () => {
    vi.stubEnv('LIFECYCLE_V2', '1'); const a = await actor(); const created = await post(a, nanoid());
    expect(created.statusCode).toBe(201); const id = created.json().data.orderId;
    await app.prisma.order.update({ where: { id }, data: { holdExpiresAt: new Date(Date.now() - 10000) } });
    await releaseHeldOrdersJob({ prisma: app.prisma, io: app.io, redis: app.redis, log: app.log }, queues() as never);
    await due(id); await drain(id); expect(await rows(id)).toHaveLength(1); expect(await jobsFor(id)).toHaveLength(1);
  });
});

describe('courier cash admission', () => {
  it('refuses an L1 sender with restriction-level strikes, before writes', async () => {
    const a = await actor(); await app.prisma.user.update({ where: { id: a.userId }, data: { trustLevel: 'L1' } });
    await app.prisma.strike.createMany({ data: Array.from({ length: 2 }, () => ({ userId: a.userId, reason: 'synthetic failed cash' })) });
    const res = await post(a, nanoid()); expect(res.statusCode, res.body).toBe(403); expect(res.json().error.code).toBe('ACCOUNT_RESTRICTED');
    expect(await app.prisma.order.count({ where: { customerId: a.userId } })).toBe(0);
  });
  it('refuses a suspended sender with an existing session', async () => {
    const a = await actor(); await app.prisma.user.update({ where: { id: a.userId }, data: { status: 'SUSPENDED' } });
    const res = await post(a, nanoid()); expect(res.statusCode).toBe(401);
    expect(await app.prisma.order.count({ where: { customerId: a.userId } })).toBe(0);
  });
  it('rechecks restriction that appeared while routing, inside creation', async () => {
    const a = await actor(); await app.prisma.user.update({ where: { id: a.userId }, data: { trustLevel: 'L1' } });
    vi.mocked(fetch).mockImplementationOnce(async () => {
      await app.prisma.strike.createMany({ data: Array.from({ length: 2 }, () => ({ userId: a.userId, reason: 'synthetic concurrent strike' })) });
      return new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 8100, duration: 900 }] }));
    });
    const res = await post(a, nanoid()); expect(res.statusCode, res.body).toBe(403);
    expect(await app.prisma.order.count({ where: { customerId: a.userId } })).toBe(0);
  });
});

describe('terminal recipient minimisation', () => {
  it.each(TERMINAL_ORDER_STATUSES)('terminal %s removes recipient from mover and public projections', async (status) => {
    const a = await actor(); const m = await actor(true); const res = await post(a);
    expect(res.statusCode).toBe(201); const id = res.json().data.orderId;
    const rider = await app.prisma.rider.create({ data: { userId: m.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', currentOrderId: id } });
    await app.prisma.order.update({ where: { id }, data: { riderId: rider.id, status, deliveredAt: new Date() } });
    for (const url of ['/api/v1/rider/orders', '/api/v1/rider/orders/active', '/api/v1/rider/orders/active-legs', `/api/v1/courier/track/${res.json().data.trackingToken}`]) {
      const response = await read(url, url.includes('/rider/') ? m : undefined); expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain(body.recipientName); expect(response.body).not.toContain(body.recipientPhone); expect(response.body).not.toContain(body.dropoffAddress);
    }
    expect((await read('/api/v1/rider/orders/active', m)).json().data).toBeNull();
  });
  it('a stale pointer to another mover job conveys no recipient authority', async () => {
    const a = await actor(); const wrong = await actor(true); const assigned = await actor(true);
    const res = await post(a); expect(res.statusCode).toBe(201); const id = res.json().data.orderId;
    const rider = await app.prisma.rider.create({ data: { userId: assigned.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', currentOrderId: id } });
    await app.prisma.rider.create({ data: { userId: wrong.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', currentOrderId: id } });
    await app.prisma.order.update({ where: { id }, data: { riderId: rider.id, status: 'PICKED_UP' } });
    const response = await read('/api/v1/rider/orders/active', wrong);
    expect(response.statusCode, response.body).toBe(200); expect(response.json().data).toBeNull();
    expect(response.body).not.toContain(body.recipientName);
  });
  it('an assigned live mover still sees the recipient needed for handover', async () => {
    const a = await actor(); const m = await actor(true); const res = await post(a); const id = res.json().data.orderId;
    const rider = await app.prisma.rider.create({ data: { userId: m.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', currentOrderId: id } });
    await app.prisma.order.update({ where: { id }, data: { riderId: rider.id, status: 'PICKED_UP' } });
    const response = await read('/api/v1/rider/orders/active', m); expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ courierRecipientName: body.recipientName, courierRecipientPhone: body.recipientPhone, deliveryAddress: body.dropoffAddress });
  });
});

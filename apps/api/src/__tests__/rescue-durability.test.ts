import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// The ops page is spied through a partial module mock so one case can make it
// fail; everything else in the module is real (the same seam rescue.test.ts uses).
vi.mock('../modules/notification/notification.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../modules/notification/notification.service')>();
  return { ...mod, notifyAdmins: vi.fn(mod.notifyAdmins) };
});
// The generic publisher is spied the same way so one case can make the first
// drain of the checkout-outbox sweep fail on infrastructure.
vi.mock('../modules/order/checkout-outbox', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../modules/order/checkout-outbox')>();
  return { ...mod, drainCheckoutOutbox: vi.fn(mod.drainCheckoutOutbox) };
});
import { nanoid } from 'nanoid';
import { QueueEvents } from 'bullmq';
import type { PrismaClient, OrderType } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { NotificationService, notifyAdmins } from '../modules/notification/notification.service';
import * as rescue from '../modules/dispatch/rescue';
import { settleTooOldOrder, sweepFoodAge, SWEEP_PAGE, FOOD_TOO_OLD_REASON } from '../modules/dispatch/rescue';
import * as checkoutOutbox from '../modules/order/checkout-outbox';
import { drainCheckoutOutbox } from '../modules/order/checkout-outbox';
import { invalidateAlgoConfig } from '../modules/algo/algo-config';
import { bullConnectionOpts, createQueues, createWorkers } from '../jobs/queue';

// ---------------------------------------------------------------------------
// [RESCUE S1 · AUD-CX04-001 / AUD-CX05-001] The food-age cutoff's record and
// notices are durable, and its sweep reaches every waiting order.
//
//   CX04  When the system cancels an order that waited too long for a rider,
//         the cancellation, its status-log line, its decision row and the
//         obligation to tell the customer, the store and operations commit
//         as ONE transaction. A refused record rolls the cancellation back; a
//         crash after the commit leaves the notices owed, and the outbox
//         drain delivers them — once.
//   CX05  The sweep walks its population on a (time, id) cursor, so orders
//         that share a timestamp can no longer hide behind the first page,
//         and one order that fails is skipped for the pass instead of
//         stopping the tick.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+59200682';
const MIN = 60_000;
const PICKUP = { lat: 6.8, lng: -58.15 };
/** Older than anything any other suite writes, so these rows open a fresh pass. */
const ANCIENT = new Date('2001-01-01T00:00:00.000Z');

let app: FastifyInstance;
let customerId: string;
let vendorId: string;
let vendorOwnerUserId: string;
let adminUserId: string;
const orderIds: string[] = [];

type Drain = (deps: rescue.RescueDeps, options?: { limit?: number }) => Promise<{ delivered: number; owed: number; failed: number }>;
/** Looked up, not imported: before the fix the drain does not exist, and each
 *  case that needs it must fail on its own assertion, not take the file down. */
const drainRescueNotices = (rescue as Record<string, unknown>)['drainRescueNotices'] as Drain | undefined;
const RESCUE_KIND = 'rescue-notice';

const deps = (prisma: PrismaClient = app.prisma, notifications = new NotificationService(app.prisma, app.io)): rescue.RescueDeps => ({
  prisma, redis: app.redis, io: app.io, notifications,
});

async function purge() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  const orders = await app.prisma.order.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
  const oids = orders.map((o) => o.id);
  for (const o of oids) await app.redis.del(`ops_page:food_too_old:${o}`, `ops_page:food_too_old_paid:${o}`);
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: oids } } });
  await app.prisma.algoDecision.deleteMany({ where: { algo: 'ALG-06', subjectId: { in: oids } } });
  await app.prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, ...oids.map((o) => ({ dedupeKey: `food-too-old:ops:${o}` }))] } });
  await app.prisma.order.deleteMany({ where: { id: { in: oids } } });
  const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  await app.prisma.vendor.deleteMany({ where: { ownerId: { in: vos.map((v) => v.id) } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: vos.map((v) => v.id) } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function makeOrder(opts: { orderType?: OrderType; readyAt?: Date; paymentMethod?: 'CASH' | 'MOBILE_MONEY'; paymentStatus?: 'PENDING' | 'CAPTURED'; heldAt?: Date } = {}) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `RSD-${nanoid(8)}`, orderType: opts.orderType ?? 'FOOD_DELIVERY', customerId, vendorId,
      status: 'READY_FOR_PICKUP', fulfillment: 'DELIVERY', readyAt: opts.readyAt ?? new Date(Date.now() - 120 * MIN),
      ...(opts.heldAt ? { foodAgeHeldAt: opts.heldAt } : {}),
      pickupAddress: 'Store', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng, deliveryAddress: 'Home', deliveryLat: PICKUP.lat + 0.01, deliveryLng: PICKUP.lng + 0.01,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, paymentMethod: opts.paymentMethod ?? 'CASH',
      ...(opts.paymentStatus ? { paymentStatus: opts.paymentStatus } : {}),
    },
  });
  orderIds.push(order.id);
  return order;
}

const full = (id: string) => app.prisma.order.findUniqueOrThrow({
  where: { id }, include: { vendor: { select: { name: true, owner: { select: { userId: true } } } } },
});

async function record(orderId: string) {
  return {
    logs: await app.prisma.orderStatusLog.count({ where: { orderId, status: 'CANCELLED' } }),
    decisions: await app.prisma.algoDecision.count({ where: { algo: 'ALG-06', subjectId: orderId, outcome: 'FOOD_TOO_OLD' } }),
    obligations: await app.prisma.orderOutbox.count({ where: { orderId, kind: RESCUE_KIND } }),
  };
}
const owed = (orderId: string) => app.prisma.orderOutbox.count({ where: { orderId, kind: RESCUE_KIND, processedAt: null } });
const customerNotices = (orderId: string, held = false) =>
  app.prisma.notification.count({ where: { userId: customerId, dedupeKey: `${held ? 'food-too-old-paid' : 'food-too-old'}:customer:${orderId}` } });
const vendorNotices = (orderId: string) => app.prisma.notification.count({ where: { userId: vendorOwnerUserId, dedupeKey: `food-too-old:vendor:${orderId}` } });
const opsInbox = (orderId: string) => app.prisma.notification.count({ where: { userId: adminUserId, dedupeKey: `food-too-old:ops:${orderId}` } });

/** A client whose `<Model>.<operation>` refuses ONCE, after the statement ran:
 *  the failure lands mid-transaction, where only a rollback can undo it. */
function refusing(point: string) {
  let fired = false;
  const client = app.prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const result = await query(args);
          if (!fired && `${model}.${operation}` === point) {
            fired = true;
            throw new Error(`refused: ${point}`);
          }
          return result;
        },
      },
    },
  }) as unknown as PrismaClient;
  return { client, fired: () => fired };
}

/** Run ONE job through the production dispatch worker (the consumer of the
 *  checkout-outbox sweep), with real BullMQ and Redis: the job's outcome. */
async function runDispatchJob(name: string): Promise<'completed' | Error> {
  const queues = createQueues(app.redis);
  const workers = await createWorkers({ prisma: app.prisma, redis: app.redis, io: app.io, log: app.log }, queues);
  const events = new QueueEvents(queues.dispatchQueue.name, { connection: bullConnectionOpts(app.redis) });
  let loop: Promise<void> | undefined;
  try {
    await workers.waitUntilReady();
    await events.waitUntilReady();
    loop = workers.dispatchWorker.run();
    const job = await queues.dispatchQueue.add(name, {}, { jobId: `rescue-durability-${nanoid(10)}`, attempts: 1, removeOnComplete: true, removeOnFail: true });
    return await job.waitUntilFinished(events, 30_000).then(() => 'completed' as const, (err: unknown) => err as Error);
  } finally {
    await workers.cleanup();
    await loop?.catch(() => undefined);
    await events.close();
    for (const q of Object.values(queues)) await q.close();
  }
}

/** Start both passes from the top, wherever this DB's cursors were left. */
async function resetCursors() {
  await app.redis.del('rescue:cursor:retire', 'rescue:cursor:holds');
  await app.prisma.sweepCursor.deleteMany({ where: { workType: { startsWith: 'rescue.' } } });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  await purge();
  invalidateAlgoConfig();
  const user = (n: string, role: 'CUSTOMER' | 'VENDOR_OWNER' | 'ADMIN') => app.prisma.user.create({
    data: { phone: `${PHONE_PREFIX}${n}`, firstName: 'Durable', lastName: role, roles: [role], activeRole: role, isPhoneVerified: true, selfieCapturedAt: new Date() },
  });
  customerId = (await user('01', 'CUSTOMER')).id;
  const owner = await user('02', 'VENDOR_OWNER');
  vendorOwnerUserId = owner.id;
  adminUserId = (await user('03', 'ADMIN')).id;
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  vendorId = (await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Durable Kitchen', slug: `durable-kitchen-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}04`,
      addressLine1: '1 Durable St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: PICKUP.lat, longitude: PICKUP.lng,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  })).id;
});

afterAll(async () => {
  await resetCursors();
  await purge();
  await app.close();
});

// ---------------------------------------------------------------------------

describe('[CX04] the cancellation and its record are one transaction', () => {
  it.each(['OrderStatusLog.create', 'AlgoDecision.create', 'OrderOutbox.create'])(
    'a refused %s rolls the cancellation back with it — and the next attempt lands the whole record',
    async (point) => {
      const order = await makeOrder();
      const refuse = refusing(point);
      await expect(settleTooOldOrder(deps(refuse.client), await full(order.id), 120, 45)).rejects.toThrow();
      expect(refuse.fired(), `${point} is written inside the cutoff`).toBe(true);
      const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect({ status: after.status, cancelledAt: after.cancelledAt }).toEqual({ status: 'READY_FOR_PICKUP', cancelledAt: null });
      expect(await record(order.id)).toEqual({ logs: 0, decisions: 0, obligations: 0 });
      expect(await customerNotices(order.id)).toBe(0);

      expect(await settleTooOldOrder(deps(), await full(order.id), 120, 45)).toBe('RETIRED');
      const retired = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect({ status: retired.status, reason: retired.cancellationReason }).toEqual({ status: 'CANCELLED', reason: FOOD_TOO_OLD_REASON });
      expect(await record(order.id)).toEqual({ logs: 1, decisions: 1, obligations: 1 });
      expect(await owed(order.id)).toBe(0);
      expect(await customerNotices(order.id)).toBe(1);
      expect(await vendorNotices(order.id)).toBe(1);
      expect(await opsInbox(order.id)).toBe(1);
    },
  );

  it('a crash after the commit loses nothing: the notices stay owed and the outbox drain delivers them, once', async () => {
    const order = await makeOrder({ paymentMethod: 'MOBILE_MONEY' });
    const dying = new NotificationService(app.prisma, app.io);
    // The process dies right after the commit: no notice it would send lands.
    vi.spyOn(dying, 'send').mockRejectedValue(new Error('worker process died'));
    const outcome = await settleTooOldOrder(deps(app.prisma, dying), await full(order.id), 120, 45).catch((err: unknown) => err);
    expect(outcome, 'the cancellation committed; a notice cannot undo it').toBe('RETIRED');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
    expect(await record(order.id)).toEqual({ logs: 1, decisions: 1, obligations: 1 });
    expect(await owed(order.id), 'the obligation outlives the process').toBe(1);
    expect(await customerNotices(order.id)).toBe(0);
    expect(await vendorNotices(order.id)).toBe(0);
    expect(await opsInbox(order.id)).toBe(0);

    // The sweep cannot find it any more — it is CANCELLED — so the outbox is the only way back.
    expect(drainRescueNotices, 'the rescue obligations have their own drain').toBeTypeOf('function');
    expect(await drainRescueNotices!(deps())).toMatchObject({ delivered: 1, owed: 0, failed: 0 });
    expect(await owed(order.id)).toBe(0);
    expect(await customerNotices(order.id)).toBe(1);
    expect(await vendorNotices(order.id)).toBe(1);
    expect(await opsInbox(order.id)).toBe(1);
    const toCustomer = await app.prisma.notification.findFirstOrThrow({ where: { userId: customerId, dedupeKey: `food-too-old:customer:${order.id}` } });
    expect(toCustomer.body).toContain('the store refunds you');
    expect(toCustomer.body).not.toMatch(/Swift (will )?refund/i);

    // A second drain, or a replay, adds nothing.
    expect(await drainRescueNotices!(deps())).toMatchObject({ delivered: 0 });
    expect(await customerNotices(order.id)).toBe(1);
    expect(await vendorNotices(order.id)).toBe(1);
    expect(await opsInbox(order.id)).toBe(1);
  });

  it('an ops page that reaches nobody stays owed, and the drain pages again until someone holds it', async () => {
    const order = await makeOrder();
    vi.mocked(notifyAdmins).mockRejectedValueOnce(new Error('admin notice incomplete'));
    expect(await settleTooOldOrder(deps(), await full(order.id), 120, 45)).toBe('RETIRED');
    expect(await customerNotices(order.id)).toBe(1);
    expect(await owed(order.id), 'the customer and the store were told; operations were not').toBe(1);
    const pagesBefore = vi.mocked(notifyAdmins).mock.calls.filter((c) => (c[2]?.data as Record<string, unknown> | undefined)?.['orderId'] === order.id).length;

    expect(drainRescueNotices, 'the rescue obligations have their own drain').toBeTypeOf('function');
    expect(await drainRescueNotices!(deps())).toMatchObject({ delivered: 1 });
    const pagesAfter = vi.mocked(notifyAdmins).mock.calls.filter((c) => (c[2]?.data as Record<string, unknown> | undefined)?.['orderId'] === order.id).length;
    expect(pagesAfter).toBeGreaterThan(pagesBefore);
    expect(await owed(order.id)).toBe(0);
    expect(await opsInbox(order.id)).toBe(1);
    expect(await customerNotices(order.id), 'the retry never re-sends what already landed').toBe(1);
  });

  it('a page that misses one operator is not a delivered page: it stays owed until every operator holds it', async () => {
    const order = await makeOrder();
    const flaky = new NotificationService(app.prisma, app.io);
    const realSend = flaky.send.bind(flaky);
    let refused = false;
    vi.spyOn(flaky, 'send').mockImplementation(async (payload) => {
      // This suite's operator's inbox write fails once ('' = not persisted).
      if (!refused && payload.userId === adminUserId && payload.dedupeKey === `food-too-old:ops:${order.id}`) {
        refused = true;
        return '';
      }
      return realSend(payload);
    });
    expect(await settleTooOldOrder(deps(app.prisma, flaky), await full(order.id), 120, 45)).toBe('RETIRED');
    expect(refused).toBe(true);
    expect(await opsInbox(order.id)).toBe(0);
    expect(await owed(order.id)).toBe(1);
    expect(drainRescueNotices, 'the rescue obligations have their own drain').toBeTypeOf('function');
    expect(await drainRescueNotices!(deps())).toMatchObject({ delivered: 1 });
    expect(await opsInbox(order.id)).toBe(1);
    expect(await owed(order.id)).toBe(0);
  });

  it('the drain keeps an obligation it could not finish: backed off, with its reason, and delivered on a later sweep', async () => {
    const order = await makeOrder();
    const down = new NotificationService(app.prisma, app.io);
    vi.spyOn(down, 'send').mockResolvedValue('');
    expect(await settleTooOldOrder(deps(app.prisma, down), await full(order.id), 120, 45)).toBe('RETIRED');
    expect(drainRescueNotices, 'the rescue obligations have their own drain').toBeTypeOf('function');
    expect(await drainRescueNotices!(deps(app.prisma, down))).toMatchObject({ delivered: 0, owed: 1 });
    const row = await app.prisma.orderOutbox.findFirstOrThrow({ where: { orderId: order.id, kind: RESCUE_KIND } });
    expect(row.processedAt).toBeNull();
    expect(row.claimedAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/incomplete/);
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
    // Not due yet: an immediate sweep leaves it alone.
    expect(await drainRescueNotices!(deps())).toMatchObject({ delivered: 0 });
    // Due later: delivered, once — and two overlapping sweeps never both take it.
    const later = { ...deps(), now: () => new Date(Date.now() + 60 * MIN) };
    const [a, b] = await Promise.all([drainRescueNotices!(later), drainRescueNotices!(later)]);
    expect(a.delivered + b.delivered).toBe(1);
    expect(await owed(order.id)).toBe(0);
    expect(await customerNotices(order.id)).toBe(1);
    expect(await vendorNotices(order.id)).toBe(1);
    expect(await opsInbox(order.id)).toBe(1);
  });

  it('overlapping cutoffs have one winner: one record, one obligation, one notice each', async () => {
    const order = await makeOrder();
    const row = await full(order.id);
    const outcomes = await Promise.all([1, 2, 3].map(() => settleTooOldOrder(deps(), row, 120, 45)));
    expect(outcomes.filter((o) => o === 'RETIRED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'UNTOUCHED')).toHaveLength(2);
    expect(await record(order.id)).toEqual({ logs: 1, decisions: 1, obligations: 1 });
    expect(await customerNotices(order.id)).toBe(1);
    expect(await vendorNotices(order.id)).toBe(1);
  });

  it('the generic outbox publisher never consumes a rescue obligation; the checkout-outbox sweep drains it in process', async () => {
    const order = await makeOrder();
    const dying = new NotificationService(app.prisma, app.io);
    vi.spyOn(dying, 'send').mockRejectedValueOnce(new Error('worker process died'));
    await settleTooOldOrder(deps(app.prisma, dying), await full(order.id), 120, 45).catch(() => undefined);
    expect(await owed(order.id)).toBe(1);
    const add = vi.fn(async () => ({}));
    const published = await drainCheckoutOutbox(
      { prisma: app.prisma, queues: { orderQueue: { add }, notificationQueue: { add }, dispatchQueue: { add } } as never, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
      { orderIds: [order.id] },
    );
    expect(published.processed).toBe(0);
    expect(add).not.toHaveBeenCalled();
    expect(await owed(order.id), 'publishing would close it the moment a queue took it').toBe(1);
    expect(checkoutOutbox.IN_PROCESS_OUTBOX_KINDS).toContain(RESCUE_KIND);
    expect((rescue as Record<string, unknown>)['RESCUE_NOTICE_KIND'], 'one name on both sides').toBe(RESCUE_KIND);

    // The production worker's checkout-outbox job drains it.
    expect(await runDispatchJob('checkout-outbox')).toBe('completed');
    expect(await owed(order.id), 'the sweep the worker runs every 10 s closes the obligation').toBe(0);
    expect(await customerNotices(order.id)).toBe(1);
  });

  it('one drain failing on infrastructure does not skip the rescue drain; the job still reports the failure', async () => {
    const order = await makeOrder();
    const dying = new NotificationService(app.prisma, app.io);
    vi.spyOn(dying, 'send').mockRejectedValue(new Error('worker process died'));
    await settleTooOldOrder(deps(app.prisma, dying), await full(order.id), 120, 45);
    expect(await owed(order.id)).toBe(1);
    vi.mocked(drainCheckoutOutbox).mockRejectedValueOnce(new Error('order queue unreachable'));
    const outcome = await runDispatchJob('checkout-outbox');
    expect(outcome, 'the dead-letter alarm still sees the failing drain').toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('order queue unreachable');
    expect(await owed(order.id), 'the rescue drain ran anyway').toBe(0);
    expect(await customerNotices(order.id)).toBe(1);
  });

  it('a cutoff cancellation moved on to REFUNDED before its notices were drained still gets them', async () => {
    const order = await makeOrder();
    const dying = new NotificationService(app.prisma, app.io);
    vi.spyOn(dying, 'send').mockRejectedValue(new Error('worker process died'));
    await settleTooOldOrder(deps(app.prisma, dying), await full(order.id), 120, 45);
    expect(await owed(order.id)).toBe(1);
    // CANCELLED → REFUNDED is a declared edge (an operator's refund record).
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
    expect(drainRescueNotices, 'the rescue obligations have their own drain').toBeTypeOf('function');
    expect(await drainRescueNotices!(deps())).toMatchObject({ delivered: 1 });
    expect(await customerNotices(order.id)).toBe(1);
    expect(await vendorNotices(order.id)).toBe(1);
    expect(await opsInbox(order.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('[CX05] the sweep reaches every waiting order, whatever their timestamps', () => {
  it('orders that share a ready time cannot hide behind the first page: a food order tied with two no-cutoff courier jobs is retired', async () => {
    // Two courier jobs (no cutoff: never retired) and one food order, all with
    // the SAME readyAt — the oldest in the table, so they open a fresh pass.
    await makeOrder({ orderType: 'COURIER', readyAt: ANCIENT });
    await makeOrder({ orderType: 'COURIER', readyAt: ANCIENT });
    const food = await makeOrder({ readyAt: ANCIENT });
    const saved = SWEEP_PAGE.retire;
    SWEEP_PAGE.retire = 2;
    try {
      await resetCursors();
      for (let tick = 0; tick < 6; tick += 1) {
        await sweepFoodAge(deps());
        if ((await app.prisma.order.findUniqueOrThrow({ where: { id: food.id } })).status === 'CANCELLED') break;
      }
    } finally {
      SWEEP_PAGE.retire = saved;
      await resetCursors();
    }
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: food.id } });
    expect({ status: after.status, reason: after.cancellationReason }).toEqual({ status: 'CANCELLED', reason: FOOD_TOO_OLD_REASON });
  });

  it('holds that share a held time are all served: five holds, one timestamp, a page of two', async () => {
    const heldAt = new Date(ANCIENT.getTime() + 60 * MIN);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push((await makeOrder({ readyAt: ANCIENT, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', heldAt })).id);
    }
    const saved = SWEEP_PAGE.holds;
    SWEEP_PAGE.holds = 2;
    try {
      await resetCursors();
      for (let tick = 0; tick < 6; tick += 1) await sweepFoodAge(deps());
    } finally {
      SWEEP_PAGE.holds = saved;
      await resetCursors();
    }
    for (const id of ids) expect(await customerNotices(id, true), `hold ${id} was never visited`).toBe(1);
  });

  it('one order that fails is skipped for the pass; the rest of the page is still served this tick', async () => {
    const heldAt = new Date(ANCIENT.getTime() + 120 * MIN);
    const failing = await makeOrder({ readyAt: ANCIENT, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', heldAt });
    const healthy = await makeOrder({ readyAt: ANCIENT, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', heldAt });
    const notifications = new NotificationService(app.prisma, app.io);
    const realSend = notifications.send.bind(notifications);
    vi.spyOn(notifications, 'send').mockImplementation(async (payload) => {
      if (payload.userId === customerId && (payload.data as Record<string, unknown> | undefined)?.['orderId'] === failing.id) {
        throw new Error('this one order cannot be served right now');
      }
      return realSend(payload);
    });
    try {
      await resetCursors();
      await expect(sweepFoodAge(deps(app.prisma, notifications))).resolves.toBeDefined();
    } finally {
      await resetCursors();
    }
    expect(await customerNotices(healthy.id, true)).toBe(1);
    expect(await customerNotices(failing.id, true)).toBe(0);
    // The failing order stays eligible: the next pass serves it.
    await sweepFoodAge(deps());
    expect(await customerNotices(failing.id, true)).toBe(1);
  });
});

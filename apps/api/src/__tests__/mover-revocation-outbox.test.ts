import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { AuthService } from '../modules/auth/auth.service';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import {
  emptyMoverSessionRevocationCleanup,
  retireMoverSessionAuthorityInTransaction,
  transitionUserStatusAuthority,
} from '../modules/mover-authority';
import {
  persistMoverRevocationOutboxInTransaction,
  processMoverRevocationOutboxBatch,
  type MoverRevocationDispatchEffects,
} from '../modules/mover-revocation-outbox';
import { closeOnlineSession } from '../modules/rider/online-hours';
import { startOfDayGY } from '../utils/time-gy';
import { ExpoPushProvider } from '../providers/notifications/channels';

const DAY_MS = 24 * 60 * 60 * 1000;
const userIds: string[] = [];
const orderIds: string[] = [];
const redisKeys = new Set<string>();
const phoneBase = 592_780_000_000 + Math.floor(Math.random() * 100_000_000);
let sequence = 0;
let app: FastifyInstance;

async function makeUser(role: 'CUSTOMER' | 'MOVER' | 'SUPER_ADMIN' = 'CUSTOMER') {
  sequence += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + sequence}`,
      firstName: 'Outbox',
      lastName: `User${sequence}`,
      roles: role === 'MOVER' ? ['MOVER', 'CUSTOMER'] : [role],
      activeRole: role,
      status: 'ACTIVE',
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const session = await app.prisma.session.create({
    data: {
      userId: user.id,
      token: `outbox-access-${nanoid(24)}`,
      refreshToken: `outbox-refresh-${nanoid(32)}`,
      deviceId: `outbox-device-${sequence}`,
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY_MS),
    },
  });
  return { user, session };
}

async function makeRider(userId: string, sessionId: string) {
  return app.prisma.rider.create({
    data: {
      userId,
      riderType: 'DELIVERY',
      vehicleType: 'MOTORCYCLE',
      documentsVerified: true,
      isOnline: true,
      isAvailable: false,
      locationSessionId: sessionId,
    },
  });
}

async function makeOrder(customerId: string, riderId: string, status: 'RIDER_ASSIGNED' | 'PICKED_UP') {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `MRO-${nanoid(12)}`,
      orderType: 'COURIER',
      customerId,
      riderId,
      status,
      fulfillment: 'DELIVERY',
      pickupAddress: '1 Water Street',
      pickupLat: 6.801,
      pickupLng: -58.155,
      deliveryAddress: '2 Main Street',
      deliveryLat: 6.812,
      deliveryLng: -58.164,
      subtotalBase: 1_000,
      subtotalMarkup: 0,
      subtotalCustomer: 1_000,
      deliveryFee: 500,
      totalAmount: 1_500,
      paymentMethod: 'CASH',
      acceptedAt: new Date(),
    },
  });
  orderIds.push(order.id);
  await app.prisma.rider.update({ where: { id: riderId }, data: { currentOrderId: order.id } });
  return order;
}


/** [task #25 flake-harden] The outbox table is shared across parallel test
 *  files; an unscoped batch can claim ANOTHER file's rows (starving this
 *  file's counts) or burn this file's single-shot mocks on foreign rows.
 *  Every batch call here scopes the claim to this file's own users. */
function processMoverRevocationOutboxBatch_SCOPED(rt: ReturnType<typeof runtime>) {
  return processMoverRevocationOutboxBatch(rt, 25, { onlyUserIds: [...userIds] });
}

function runtime(dispatch: MoverRevocationDispatchEffects) {
  return {
    prisma: app.prisma,
    redis: app.redis,
    io: app.io,
    log: app.log,
    dispatch,
  };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['JWT_SECRET'] = process.env['JWT_SECRET'] || 'mover-outbox-test-secret-at-least-32-bytes';
  process.env['MOVER_REVOCATION_RETRY_BASE_MS'] = '100';

  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  await makeUser('SUPER_ADMIN');
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['PUSH_PROVIDER'];
  delete process.env['MOVER_REVOCATION_EFFECT_TIMEOUT_MS'];
  delete process.env['MOVER_REVOCATION_IMMEDIATE_BUDGET_MS'];
});

afterAll(async () => {
  if (redisKeys.size > 0) await app.redis.del(...redisKeys);
  // Table janitor: every mover-session LOGOUT anywhere in the suite persists a
  // `session:<id>` outbox row (auth.service revokeLockedSession), and most
  // files clean only their OWN userIds — so foreign settled rows accumulate on
  // the shared test DB and eventually poison THIS file's whole-table batch
  // assertions. This file owns the outbox subject, so it sweeps the settled
  // backlog here (after its own tests — never disturbing them). Live in-flight
  // rows (unprocessed, not yet due) are left for their owner.
  await app.prisma.moverRevocationOutbox.deleteMany({
    where: { OR: [{ processedAt: { not: null } }, { availableAt: { lt: new Date(Date.now() - 60_000) } }] },
  });
  if (userIds.length > 0) {
    const cases = await app.prisma.incidentCase.findMany({
      where: { subjectUserId: { in: userIds } },
      select: { id: true },
    });
    if (cases.length > 0) {
      await app.prisma.evidenceBundle.deleteMany({
        where: { caseId: { in: cases.map((kase) => kase.id) } },
      });
    }
    await app.prisma.moverRevocationOutbox.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.alertDelivery.deleteMany({ where: { recipientId: { in: userIds } } });
    await app.prisma.incidentCase.deleteMany({ where: { subjectUserId: { in: userIds } } });
  }
  if (orderIds.length > 0) {
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  if (userIds.length > 0) {
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  delete process.env['MOVER_REVOCATION_RETRY_BASE_MS'];
  await app.close();
});

describe('durable mover revocation outbox', () => {
  it('reclaims a crashed claim and never duplicates durable custody evidence', async () => {
    const customer = await makeUser();
    const mover = await makeUser('MOVER');
    const rider = await makeRider(mover.user.id, mover.session.id);
    const order = await makeOrder(customer.user.id, rider.id, 'PICKED_UP');

    // This is the exact AuthService transaction core, intentionally stopped
    // before its immediate post-commit accelerator to model process death.
    const committed = await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${mover.user.id} FOR UPDATE`;
      const cleanup = await retireMoverSessionAuthorityInTransaction(tx, mover.user.id, mover.session.id);
      const outboxId = await persistMoverRevocationOutboxInTransaction(tx, {
        dedupeKey: `session:${mover.session.id}`,
        userId: mover.user.id,
        cleanup,
      });
      await tx.session.delete({ where: { id: mover.session.id } });
      return { ...cleanup, outboxId };
    });

    expect(committed.outboxId).not.toBeNull();
    const [session, noticeCount, incidentCount, opsNoticeCount] = await Promise.all([
      app.prisma.session.findUnique({ where: { id: mover.session.id } }),
      app.prisma.notification.count({
        where: {
          userId: customer.user.id,
          data: { path: ['eventId'], string_starts_with: committed.outboxId! },
        },
      }),
      app.prisma.incidentCase.count({
        where: { subjectUserId: mover.user.id, orderId: order.id, category: 'MOVER_SESSION_LOST_IN_CUSTODY' },
      }),
      app.prisma.notification.count({
        where: { data: { path: ['kind'], equals: `ops_mover_session_ended:${order.id}` } },
      }),
    ]);
    expect(session).toBeNull();
    expect({ noticeCount, incidentCount }).toEqual({ noticeCount: 1, incidentCount: 1 });
    expect(opsNoticeCount).toBeGreaterThanOrEqual(1);
    const [incident, suspendedRider, subjectNoticeCount] = await Promise.all([
      app.prisma.incidentCase.findFirstOrThrow({
        where: { subjectUserId: mover.user.id, orderId: order.id },
      }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } }),
      app.prisma.notification.count({
        where: {
          userId: mover.user.id,
          data: { path: ['kind'], equals: 'incident_interim_suspension' },
        },
      }),
    ]);
    expect(incident).toMatchObject({
      severity: 'S1',
      interimAction: 'SUSPENDED_PENDING_REVIEW',
      category: 'MOVER_SESSION_LOST_IN_CUSTODY',
    });
    expect(suspendedRider.safetySuspendedAt).not.toBeNull();
    expect(subjectNoticeCount).toBe(1);

    // Simulate death after SELECT ... SKIP LOCKED claimed the row. A live lease
    // is not stolen; once stale, the next worker reclaims it.
    await app.prisma.moverRevocationOutbox.update({
      where: { id: committed.outboxId! },
      data: { claimedAt: new Date(), attempts: 1 },
    });
    const releaseHeldOffer = vi.fn().mockResolvedValue(undefined);
    const retryDispatch = vi.fn().mockResolvedValue({});
    await expect(processMoverRevocationOutboxBatch_SCOPED(runtime({ releaseHeldOffer, retryDispatch })))
      .resolves.toEqual({ processed: 0, failed: 0 });
    expect(releaseHeldOffer).not.toHaveBeenCalled();

    await app.prisma.moverRevocationOutbox.update({
      where: { id: committed.outboxId! },
      data: { claimedAt: new Date(Date.now() - 2 * 60_000), availableAt: new Date(0) },
    });
    await expect(processMoverRevocationOutboxBatch_SCOPED(runtime({ releaseHeldOffer, retryDispatch })))
      .resolves.toEqual({ processed: 1, failed: 0 });
    expect(releaseHeldOffer).toHaveBeenCalledTimes(1);
    expect(retryDispatch).not.toHaveBeenCalled();
    const evidence = await app.prisma.evidenceBundle.findUniqueOrThrow({
      where: { caseId: incident.id },
      include: { items: { select: { kind: true } } },
    });
    expect(evidence.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['INCIDENT_CASE', 'ORDER_SNAPSHOT']),
    );

    // A repeated sweep is a no-op, and database facts remain exactly-once.
    await expect(processMoverRevocationOutboxBatch_SCOPED(runtime({ releaseHeldOffer, retryDispatch })))
      .resolves.toEqual({ processed: 0, failed: 0 });
    const [finalNoticeCount, finalIncidentCount] = await Promise.all([
      app.prisma.notification.count({
        where: {
          userId: customer.user.id,
          data: { path: ['eventId'], string_starts_with: committed.outboxId! },
        },
      }),
      app.prisma.incidentCase.count({
        where: { subjectUserId: mover.user.id, orderId: order.id, category: 'MOVER_SESSION_LOST_IN_CUSTODY' },
      }),
    ]);
    expect({ finalNoticeCount, finalIncidentCount }).toEqual({ finalNoticeCount: 1, finalIncidentCount: 1 });
  });

  it('fans out the persisted S0 severity when a repeat custody loss is pattern-escalated', async () => {
    const customer = await makeUser();
    const mover = await makeUser('MOVER');
    const rider = await makeRider(mover.user.id, mover.session.id);
    const order = await makeOrder(customer.user.id, rider.id, 'PICKED_UP');
    const now = new Date();
    await app.prisma.incidentCase.create({
      data: {
        caseNumber: `INC-PRIOR-${nanoid(8).toUpperCase()}`,
        severity: 'S1',
        category: 'SAFETY_THREAT',
        intake: 'SYSTEM_AUTO',
        subjectUserId: mover.user.id,
        summary: 'Prior high-severity case for pattern escalation',
        slaAckBy: new Date(now.getTime() + 60 * 60_000),
        slaDecideBy: new Date(now.getTime() + 48 * 60 * 60_000),
      },
    });
    const outboxId = await app.prisma.$transaction((tx) => persistMoverRevocationOutboxInTransaction(tx, {
      dedupeKey: `repeat-custody:${order.id}`,
      userId: mover.user.id,
      cleanup: {
        riderId: null,
        driverId: null,
        orders: [{
          orderId: order.id,
          orderNumber: order.orderNumber,
          customerId: customer.user.id,
          pool: 'RIDER',
          status: 'PICKED_UP',
          action: 'ESCALATE',
        }],
      },
      now,
    }));
    const emits: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
    const io = {
      to: (room: string) => ({
        emit: (event: string, payload: Record<string, unknown>) => {
          emits.push({ room, event, payload });
          return true;
        },
      }),
    };

    await expect(processMoverRevocationOutboxBatch({
      ...runtime({
        releaseHeldOffer: vi.fn().mockResolvedValue(undefined),
        retryDispatch: vi.fn().mockResolvedValue({}),
      }),
      io: io as never,
    })).resolves.toEqual({ processed: 1, failed: 0 });

    const incident = await app.prisma.incidentCase.findFirstOrThrow({
      where: { subjectUserId: mover.user.id, orderId: order.id, category: 'MOVER_SESSION_LOST_IN_CUSTODY' },
    });
    expect(incident.severity).toBe('S0');
    expect(emits.find((entry) => entry.room === 'ops:war-room' && entry.event === 'incident:new')?.payload)
      .toMatchObject({ caseId: incident.id, orderId: order.id, severity: 'S0' });
    expect((await app.prisma.moverRevocationOutbox.findUniqueOrThrow({ where: { id: outboxId! } })).processedAt)
      .not.toBeNull();
  });

  it('keeps logout successful through transient redispatch failure and retries from PostgreSQL', async () => {
    const customer = await makeUser();
    const mover = await makeUser('MOVER');
    const rider = await makeRider(mover.user.id, mover.session.id);
    const order = await makeOrder(customer.user.id, rider.id, 'RIDER_ASSIGNED');
    vi.spyOn(DispatchService.prototype, 'retryDispatch').mockRejectedValueOnce(new Error('transient Redis dispatch outage'));

    await expect(new AuthService(app).logout(mover.session.id, mover.user.id)).resolves.toBeUndefined();

    const outbox = await app.prisma.moverRevocationOutbox.findFirstOrThrow({
      where: { userId: mover.user.id },
    });
    expect(await app.prisma.session.findUnique({ where: { id: mover.session.id } })).toBeNull();
    expect({ processedAt: outbox.processedAt, attempts: outbox.attempts }).toEqual({ processedAt: null, attempts: 1 });
    expect(outbox.lastError).toContain('transient Redis dispatch outage');
    expect(await app.prisma.notification.count({
      where: { userId: customer.user.id, data: { path: ['eventId'], string_starts_with: outbox.id } },
    })).toBe(1);

    await app.prisma.moverRevocationOutbox.update({
      where: { id: outbox.id },
      data: { availableAt: new Date(0) },
    });
    const releaseHeldOffer = vi.fn().mockResolvedValue(undefined);
    const retryDispatch = vi.fn().mockResolvedValue({});
    await expect(processMoverRevocationOutboxBatch_SCOPED(runtime({ releaseHeldOffer, retryDispatch })))
      .resolves.toEqual({ processed: 1, failed: 0 });
    expect(retryDispatch).toHaveBeenCalledExactlyOnceWith(order.id);
    expect((await app.prisma.moverRevocationOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).processedAt)
      .not.toBeNull();
    expect(await app.prisma.notification.count({
      where: { userId: customer.user.id, data: { path: ['eventId'], string_starts_with: outbox.id } },
    })).toBe(1);
  });

  it('backs off a transient held-offer Redis failure and later completes it', async () => {
    const mover = await makeUser('MOVER');
    const outboxId = await app.prisma.$transaction((tx) => persistMoverRevocationOutboxInTransaction(tx, {
      dedupeKey: `redis-failure:${mover.user.id}`,
      userId: mover.user.id,
      cleanup: {
        riderId: `rider-${nanoid(8)}`,
        driverId: null,
        orders: [],
      },
    }));
    expect(outboxId).not.toBeNull();

    const redisFailure = vi.fn().mockRejectedValueOnce(new Error('transient Redis unavailable'));
    const retryDispatch = vi.fn().mockResolvedValue({});
    await expect(processMoverRevocationOutboxBatch_SCOPED(runtime({
      releaseHeldOffer: redisFailure,
      retryDispatch,
    }))).resolves.toEqual({ processed: 0, failed: 1 });

    const failed = await app.prisma.moverRevocationOutbox.findUniqueOrThrow({ where: { id: outboxId! } });
    expect({ attempts: failed.attempts, processedAt: failed.processedAt }).toEqual({ attempts: 1, processedAt: null });
    expect(failed.lastError).toContain('transient Redis unavailable');

    await app.prisma.moverRevocationOutbox.update({
      where: { id: outboxId! },
      data: { availableAt: new Date(0) },
    });
    const releaseHeldOffer = vi.fn().mockResolvedValue(undefined);
    await expect(processMoverRevocationOutboxBatch_SCOPED(runtime({ releaseHeldOffer, retryDispatch })))
      .resolves.toEqual({ processed: 1, failed: 0 });
    expect(releaseHeldOffer).toHaveBeenCalledTimes(1);
    expect((await app.prisma.moverRevocationOutbox.findUniqueOrThrow({ where: { id: outboxId! } })).processedAt)
      .not.toBeNull();
  });

  it('returns logout within its request budget and fences a hung push from concurrent retry', async () => {
    const customer = await makeUser();
    const mover = await makeUser('MOVER');
    const rider = await makeRider(mover.user.id, mover.session.id);
    await makeOrder(customer.user.id, rider.id, 'RIDER_ASSIGNED');
    await app.prisma.deviceToken.create({
      data: {
        userId: customer.user.id,
        token: `outbox-hung-push-${nanoid(24)}`,
        platform: 'ios',
        isActive: true,
      },
    });
    process.env['PUSH_PROVIDER'] = 'expo';
    process.env['MOVER_REVOCATION_IMMEDIATE_BUDGET_MS'] = '50';
    process.env['MOVER_REVOCATION_EFFECT_TIMEOUT_MS'] = '150';
    const sendPush = vi.spyOn(ExpoPushProvider.prototype, 'sendPush')
      .mockImplementation(() => new Promise(() => undefined));

    const startedAt = Date.now();
    await expect(new AuthService(app).logout(mover.session.id, mover.user.id))
      .resolves.toBeUndefined();
    // Bounded-return semantics: with a NEVER-resolving push, logout must come
    // back in bounded time (vs hanging). 5s ceiling absorbs saturated-runner
    // event-loop stalls that broke the old 1s assert under parallel load.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(await app.prisma.session.findUnique({ where: { id: mover.session.id } })).toBeNull();

    // Wait on the CONDITION, not the clock: the 150ms effect-timeout must
    // fire AND its lease-preserving UPDATE must commit. A fixed 250ms sleep
    // left ~100ms of slack, which a loaded CI runner blows through — the row
    // was then read mid-flight (claimed, not yet re-armed) and the fence
    // assertion below lost by the enqueue→claim clock gap.
    const deadline = Date.now() + 15_000;
    let outbox = await app.prisma.moverRevocationOutbox.findFirstOrThrow({
      where: { userId: mover.user.id },
    });
    while (outbox.lastError === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      outbox = await app.prisma.moverRevocationOutbox.findFirstOrThrow({
        where: { userId: mover.user.id },
      });
    }
    expect(outbox).toMatchObject({ processedAt: null, attempts: 1 });
    expect(outbox.claimedAt).not.toBeNull();
    expect(outbox.availableAt.getTime()).toBeGreaterThan(outbox.claimedAt!.getTime());
    expect(outbox.lastError).toContain('timed out after 150ms');

    const retryDispatch = vi.fn().mockResolvedValue({});
    await expect(processMoverRevocationOutboxBatch_SCOPED(runtime({
      releaseHeldOffer: vi.fn().mockResolvedValue(undefined),
      retryDispatch,
    }))).resolves.toEqual({ processed: 0, failed: 0 });
    expect(retryDispatch).not.toHaveBeenCalled();
    expect(sendPush).toHaveBeenCalledTimes(1);
    await app.prisma.moverRevocationOutbox.delete({ where: { id: outbox.id } });
  });

  it('finalizes the original claim when a timed-out push later succeeds', async () => {
    const customer = await makeUser();
    const mover = await makeUser('MOVER');
    const rider = await makeRider(mover.user.id, mover.session.id);
    const order = await makeOrder(customer.user.id, rider.id, 'RIDER_ASSIGNED');
    await app.prisma.deviceToken.create({
      data: {
        userId: customer.user.id,
        token: `outbox-late-push-${nanoid(24)}`,
        platform: 'ios',
        isActive: true,
      },
    });
    const outboxId = await app.prisma.$transaction((tx) => persistMoverRevocationOutboxInTransaction(tx, {
      dedupeKey: `late-push:${order.id}`,
      userId: mover.user.id,
      cleanup: {
        riderId: null,
        driverId: null,
        orders: [{
          orderId: order.id,
          orderNumber: order.orderNumber,
          customerId: customer.user.id,
          pool: 'RIDER',
          status: 'READY_FOR_PICKUP',
          action: 'REDISPATCH',
        }],
      },
    }));
    let completePush: ((result: { sent: number }) => void) | undefined;
    const push = vi.fn().mockImplementation(() => new Promise<{ sent: number }>((resolve) => {
      completePush = resolve;
    }));
    const retryDispatch = vi.fn().mockResolvedValue({});
    const withDeferredPush = {
      ...runtime({ releaseHeldOffer: vi.fn().mockResolvedValue(undefined), retryDispatch }),
      channels: { push: { sendPush: push } },
    };
    process.env['MOVER_REVOCATION_EFFECT_TIMEOUT_MS'] = '50';

    await expect(processMoverRevocationOutboxBatch(withDeferredPush))
      .resolves.toEqual({ processed: 0, failed: 1 });
    const timedOut = await app.prisma.moverRevocationOutbox.findUniqueOrThrow({ where: { id: outboxId! } });
    expect(timedOut.claimedAt).not.toBeNull();

    await expect(processMoverRevocationOutboxBatch(withDeferredPush))
      .resolves.toEqual({ processed: 0, failed: 0 });
    expect(retryDispatch).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);

    completePush?.({ sent: 1 });
    await vi.waitFor(async () => {
      const completed = await app.prisma.moverRevocationOutbox.findUniqueOrThrow({ where: { id: outboxId! } });
      expect(completed.processedAt).not.toBeNull();
      expect(completed.claimedAt).toBeNull();
      expect(completed.lastError).toBeNull();
    });
    expect(retryDispatch).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('makes repeated logout-all a no-op after the first custody revocation', async () => {
    const customer = await makeUser();
    const mover = await makeUser('MOVER');
    const rider = await makeRider(mover.user.id, mover.session.id);
    const order = await makeOrder(customer.user.id, rider.id, 'PICKED_UP');
    const auth = new AuthService(app);

    await auth.logoutAll(mover.user.id);
    await auth.logoutAll(mover.user.id);

    const [outboxCount, noticeCount, incidentCount] = await Promise.all([
      app.prisma.moverRevocationOutbox.count({ where: { userId: mover.user.id } }),
      app.prisma.notification.count({
        where: {
          userId: customer.user.id,
          data: { path: ['kind'], equals: 'mover_session_revocation' },
          AND: { data: { path: ['orderId'], equals: order.id } },
        },
      }),
      app.prisma.incidentCase.count({
        where: { subjectUserId: mover.user.id, orderId: order.id, category: 'MOVER_SESSION_LOST_IN_CUSTODY' },
      }),
    ]);
    expect({ outboxCount, noticeCount, incidentCount })
      .toEqual({ outboxCount: 1, noticeCount: 1, incidentCount: 1 });
  });

  it('retries failed live push fanout without inserting a second inbox notice', async () => {
    const customer = await makeUser();
    const mover = await makeUser('MOVER');
    const rider = await makeRider(mover.user.id, mover.session.id);
    const order = await makeOrder(customer.user.id, rider.id, 'RIDER_ASSIGNED');
    const token = `outbox-push-${nanoid(24)}`;
    await app.prisma.deviceToken.create({
      data: { userId: customer.user.id, token, platform: 'ios', isActive: true },
    });
    const outboxId = await app.prisma.$transaction((tx) => persistMoverRevocationOutboxInTransaction(tx, {
      dedupeKey: `push-failure:${order.id}`,
      userId: mover.user.id,
      cleanup: {
        riderId: null,
        driverId: null,
        orders: [{
          orderId: order.id,
          orderNumber: order.orderNumber,
          customerId: customer.user.id,
          pool: 'RIDER',
          status: 'READY_FOR_PICKUP',
          action: 'REDISPATCH',
        }],
      },
    }));
    const push = vi.fn()
      .mockRejectedValueOnce(new Error('transient push outage'))
      .mockResolvedValue({ sent: 1 });
    const dispatch = {
      releaseHeldOffer: vi.fn().mockResolvedValue(undefined),
      retryDispatch: vi.fn().mockResolvedValue({}),
    };
    const withPush = { ...runtime(dispatch), channels: { push: { sendPush: push } } };

    await expect(processMoverRevocationOutboxBatch(withPush))
      .resolves.toEqual({ processed: 0, failed: 1 });
    expect(await app.prisma.notification.count({
      where: { userId: customer.user.id, data: { path: ['eventId'], string_starts_with: outboxId! } },
    })).toBe(1);

    await app.prisma.moverRevocationOutbox.update({
      where: { id: outboxId! },
      data: { availableAt: new Date(0) },
    });
    await expect(processMoverRevocationOutboxBatch(withPush))
      .resolves.toEqual({ processed: 1, failed: 0 });
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[0]?.[3]).toMatchObject({
      eventId: `${outboxId}:${order.id}`,
      notificationId: expect.stringMatching(/^mro_notice_/),
    });
    expect(await app.prisma.notification.count({
      where: { userId: customer.user.id, data: { path: ['eventId'], string_starts_with: outboxId! } },
    })).toBe(1);
  });

  it('folds online hours atomically, making a retry a true no-op', async () => {
    const moverId = `outbox-online-${nanoid(8)}`;
    const sinceKey = `rider:online_since:${moverId}`;
    const bucketKey = `rider:online_ms:${moverId}:${startOfDayGY().toISOString().slice(0, 10)}`;
    redisKeys.add(sinceKey);
    redisKeys.add(bucketKey);
    const now = Date.now();
    await app.redis.set(sinceKey, String(now - 1_500));

    await closeOnlineSession(app.redis, moverId, now);
    const first = await app.redis.get(bucketKey);
    await closeOnlineSession(app.redis, moverId, now + 1_000);
    const second = await app.redis.get(bucketKey);

    expect(Number(first)).toBe(1_500);
    expect(second).toBe(first);
    expect(await app.redis.get(sinceKey)).toBeNull();
  });

  it('deactivates every device token in the same commit as a ban', async () => {
    const account = await makeUser();
    const token = `outbox-ban-${nanoid(24)}`;
    await app.prisma.deviceToken.create({
      data: { userId: account.user.id, token, platform: 'ios', isActive: true },
    });

    await transitionUserStatusAuthority(app, account.user.id, 'BANNED');

    const [freshToken, sessionCount] = await Promise.all([
      app.prisma.deviceToken.findUniqueOrThrow({ where: { token } }),
      app.prisma.session.count({ where: { userId: account.user.id } }),
    ]);
    expect(freshToken.isActive).toBe(false);
    expect(sessionCount).toBe(0);
  });

  it('does not create an outbox row when no mover authority changed', async () => {
    const account = await makeUser();
    const id = await app.prisma.$transaction((tx) => persistMoverRevocationOutboxInTransaction(tx, {
      dedupeKey: `empty:${account.user.id}`,
      userId: account.user.id,
      cleanup: emptyMoverSessionRevocationCleanup(),
    }));
    expect(id).toBeNull();
  });
});

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { syntheticLocationOwner } from './helpers/online-mover';
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';

// ---------------------------------------------------------------------------
// [PROD-PATH] MMG fully OFF (MMG_DRIVER=disabled), the owner's ruling for a
// production launch before the live merchant keys arrive. The weekly fee on
// the MMG rail is then DEFERRED, exactly like a card while the card rail is
// off: no payment row, no request, no failure, no dunning, no period moved.
// And the poller, which would ask MMG about every in-flight row, leaves each
// one exactly as it was — an UNKNOWN stays UNKNOWN, a PENDING stays PENDING —
// so nothing a live MMG once accepted is ever judged without MMG's answer.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
let billing: BillingService;
const userIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const PHONE_PREFIX = retainedPhonePrefix('18');

async function makeMoverWithMmgSub(due: Date) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Off', lastName: `U${seq}`,
      roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const rider = await app.prisma.rider.create({
    data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true, locationSessionId: syntheticLocationOwner('billing-mmg-off') },
  });
  const sub = await app.prisma.subscription.create({
    data: {
      riderId: rider.id,
      type: 'DELIVERY_RIDER',
      status: 'ACTIVE',
      weeklyRate: 12000,
      billingMethod: 'MOBILE_MONEY',
      mmgPayerMsisdn: `6091${String(seq).padStart(3, '0')}`,
      currentPeriodStart: new Date(due.getTime() - 7 * DAY),
      currentPeriodEnd: due,
      nextBillingDate: due,
    },
  });
  subIds.push(sub.id);
  return sub.id;
}

async function subWithRelations(subId: string) {
  return app.prisma.subscription.findUniqueOrThrow({
    where: { id: subId },
    include: {
      rider: { select: { userId: true } },
      driver: { select: { userId: true } },
      vendor: { select: { id: true, owner: { select: { userId: true } } } },
    },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

afterAll(async () => {
  vi.unstubAllEnvs();
  try {
    await app.prisma.$transaction(async (tx) => {
      const kept = await retainedCohort(tx, { subscriptionIds: subIds });
      const goneSubs = without(subIds, kept.subscriptionIds);
      const goneUsers = without(userIds, kept.userIds);
      await tx.billingEvent.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.subscription.deleteMany({ where: { id: { in: goneSubs } } });
      await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
      await tx.rider.deleteMany({ where: { userId: { in: goneUsers } } });
      await tx.user.deleteMany({ where: { id: { in: goneUsers } } });
      await retireKeptScaffolding(tx, kept);
    }, { timeout: 60_000 });
  } finally {
    await app.close();
  }
});

describe('[PROD-PATH] MMG_DRIVER=disabled: the weekly fee on the MMG rail', () => {
  it('defers the charge: no payment row, no request to MMG, no failure, the period unmoved', async () => {
    vi.stubEnv('MMG_DRIVER', 'disabled');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const due = new Date(Date.now() - 60_000);
      const subId = await makeMoverWithMmgSub(due);
      const outcome = await billing.billSubscription((await subWithRelations(subId)) as any);
      expect(outcome).toBe('pending');

      expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: subId } })).toBe(0);
      // The attempt is recorded (the card rail's deferral does the same) and
      // nothing else: no failure, no success, no dunning notice.
      const events = await app.prisma.billingEvent.findMany({ where: { subscriptionId: subId }, select: { type: true } });
      expect(events.map((e) => e.type)).toEqual(['CHARGE_ATTEMPT']);
      const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
      expect(after.status).toBe('ACTIVE');
      expect(after.failedAttempts).toBe(0);
      expect(after.nextBillingDate.getTime()).toBe(due.getTime());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('the deferred week is billed once MMG is switched on: the stale attempt is reclaimed and the request goes out', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeMoverWithMmgSub(due);
    vi.stubEnv('MMG_DRIVER', 'disabled');
    try {
      expect(await billing.billSubscription((await subWithRelations(subId)) as any)).toBe('pending');
    } finally {
      vi.unstubAllEnvs();
    }
    // MMG on again (the sandbox here), a run later than a whole run could take.
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(await billing.billSubscription((await subWithRelations(subId)) as any, later)).toBe('pending');
    const requests = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ paymentMethod: 'MOBILE_MONEY', status: 'PENDING' });
  });

  it('the poller leaves every in-flight MMG row exactly as it was, unstamped', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makeMoverWithMmgSub(due);
    const pending = await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId, amount: 12000, status: 'PENDING', paymentMethod: 'MOBILE_MONEY',
        externalRef: `mmg-off-${nanoid(8)}`, clientKey: `mmg-off-${nanoid(12)}`,
        periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY),
        createdAt: new Date(Date.now() - 2 * DAY),
      },
    });
    const unknown = await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: subId, amount: 12000, status: 'UNKNOWN', paymentMethod: 'MOBILE_MONEY',
        clientKey: `mmg-off-${nanoid(12)}`,
        periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY),
        createdAt: new Date(Date.now() - 2 * DAY),
      },
    });
    vi.stubEnv('MMG_DRIVER', 'disabled');
    try {
      const polled = await billing.pollPendingMmgCharges();
      expect(polled.settled + polled.failed + polled.banked + polled.adopted).toBe(0);
      for (const before of [pending, unknown]) {
        const row = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: before.id } });
        expect(row.status).toBe(before.status);
        expect(row.lastPolledAt).toBeNull();
        expect(row.pollBackoffSec).toBe(before.pollBackoffSec);
        expect(row.failureCode).toBeNull();
      }
      const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
      expect(after.nextBillingDate.getTime()).toBe(due.getTime());
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

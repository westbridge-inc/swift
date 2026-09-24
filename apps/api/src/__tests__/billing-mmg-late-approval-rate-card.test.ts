import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { windDownPartner } from '../modules/user/partner-wind-down';
import { guyanaTiers } from '../modules/ops/platform-config';
import { getPaymentProvider } from '../providers/payment/payment-provider';

// ---------------------------------------------------------------------------
// [G-MMG-1 · R13 on current main] A late MMG approval under the Guyana rate card.
//
// #1270 prices a partner by role: a taxi driver pays the taxi tier whatever
// the vehicle, a courier pays the vehicle band. R13 decides what a late MMG
// approval may do from the payer and subscription rows it locks INSIDE the
// money transaction, not from the snapshot the poller read.
//
// The schedule is the one G-MMG-1 names on main: the weekly MMG prompt is
// issued at the partner's #1270 rate while they are ACTIVE, the partner then
// leaves (wind-down, an older CANCELLED row that still has auto-renew on, or
// in-app account deletion), and the payer's approval arrives afterwards.
//   - ACTIVE: the approval pays exactly one week, at the #1270 rate.
//   - CANCELLED or deleted: the money is banked as wallet balance. The
//     subscription is never reactivated and nextBillingDate does not move.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
let billing: BillingService;
let subscriptions: SubscriptionService;
const userIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const phoneBase = 592_730_000_000 + Math.floor(Math.random() * 500_000_000);

/** The owner's Guyana card as #1270 resolves it: the role picks the tier. */
const RATE_CARD = {
  TAXI_DRIVER: { tier: 'taxi', rate: guyanaTiers.taxiDriver },
  COURIER: { tier: 'courier', rate: guyanaTiers.mover },
} as const;
type Partner = keyof typeof RATE_CARD;
type Leaving = 'ACTIVE' | 'CANCELLED_BY_WIND_DOWN' | 'CANCELLED_AUTO_RENEW_STILL_ON' | 'ACCOUNT_DELETED';

async function makePartner(partner: Partner, due: Date) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Late', lastName: `Approval${seq}`,
      roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER', isPhoneVerified: true, selfieCapturedAt: new Date(),
      customer: { create: {} },
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'MOVER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'late-approval', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  const entity = partner === 'TAXI_DRIVER'
    ? {
        driverId: (await app.prisma.driver.create({
          data: {
            userId: user.id, vehicleType: 'CAR', vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020,
            vehicleColor: 'White', licensePlate: `LA-${nanoid(8)}`, driverLicenseUrl: 'test/lic', vehicleInsuranceUrl: 'test/ins',
          },
        })).id,
      }
    : { riderId: (await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } })).id };

  // #1270: the weekly rate an activation writes, resolved through the
  // market's own CountryConfig exactly as signup and the weekly re-tier do.
  const priced = await subscriptions.priceForActivation(entity);
  expect(priced).toMatchObject(RATE_CARD[partner]);

  const sub = await app.prisma.subscription.create({
    data: {
      ...entity,
      type: partner === 'TAXI_DRIVER' ? 'TAXI_DRIVER' : 'DELIVERY_RIDER',
      status: 'ACTIVE',
      weeklyRate: priced!.rate,
      currencyCode: 'GYD',
      billingMethod: 'MOBILE_MONEY',
      mmgPayerMsisdn: `609${String(2000 + seq)}`,
      currentPeriodStart: new Date(due.getTime() - 7 * DAY),
      currentPeriodEnd: due,
      nextBillingDate: due,
    },
  });
  subIds.push(sub.id);
  return { userId: user.id, token, subId: sub.id };
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

async function leave(leaving: Leaving, p: { userId: string; token: string; subId: string }) {
  if (leaving === 'CANCELLED_BY_WIND_DOWN') {
    // The wind-down Help & Support closure and account deletion both run.
    await windDownPartner(app.prisma, p.userId);
  } else if (leaving === 'CANCELLED_AUTO_RENEW_STILL_ON') {
    // The shape the pre-R13 wind-down left in real databases: CANCELLED, but
    // auto-renew and the retry clock untouched.
    await app.prisma.subscription.update({ where: { id: p.subId }, data: { status: 'CANCELLED' } });
  } else if (leaving === 'ACCOUNT_DELETED') {
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/customer/account', headers: { authorization: `Bearer ${p.token}` } });
    expect(res.statusCode, res.payload).toBe(200);
    const gone = await app.prisma.user.findUniqueOrThrow({ where: { id: p.userId }, select: { status: true } });
    expect(gone.status).toBe('DEACTIVATED');
  }
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['MMG_DRIVER']; // the deterministic sandbox: a reference with no marker is approved on lookup

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
  subscriptions = new SubscriptionService(app.prisma);
});

afterAll(async () => {
  // Fee receipts and ledger lines are append-only financial records and stay,
  // as in the other billing suites; everything keyed to the fixtures goes.
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

const schedules = (['TAXI_DRIVER', 'COURIER'] as const).flatMap((partner) =>
  (['ACTIVE', 'CANCELLED_BY_WIND_DOWN', 'CANCELLED_AUTO_RENEW_STILL_ON', 'ACCOUNT_DELETED'] as const)
    .map((leaving) => ({ partner, leaving })));

describe('[G-MMG-1] a late MMG approval under the #1270 rate card', () => {
  it('the card prices the taxi tier apart from the courier band, so the tier is observable', () => {
    expect(RATE_CARD.TAXI_DRIVER.rate).not.toBe(RATE_CARD.COURIER.rate);
  });

  it.each(schedules)('$partner, $leaving before the approval lands', async ({ partner, leaving }) => {
    const due = new Date(Date.now() - 60_000);
    const { rate } = RATE_CARD[partner];
    const p = await makePartner(partner, due);

    // The weekly prompt goes out while the partner is ACTIVE, at the #1270 rate.
    expect(await billing.billSubscription((await subWithRelations(p.subId)) as never)).toBe('pending');
    const issued = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: p.subId } });
    expect(issued.status).toBe('PENDING');
    expect(Number(issued.amount)).toBe(rate);

    await leave(leaving, p);

    // The payer approves on their phone; the poller observes it afterwards.
    const polled = await billing.pollPendingMmgCharges();
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: p.subId } });
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: p.subId } });
    const successes = await app.prisma.billingEvent.findMany({ where: { subscriptionId: p.subId, type: 'CHARGE_SUCCESS' } });
    const banked = await app.prisma.billingEvent.findUnique({ where: { idempotencyKey: `bank:${issued.id}` } });
    const wallet = await app.prisma.prepaidBalance.findUnique({ where: { subscriptionId: p.subId } });

    // The decision in one object, so a failure shows every consequence at once.
    const outcome = {
      status: after.status,
      nextBillingDate: after.nextBillingDate.toISOString(),
      weeksGranted: successes.length,
      banked: banked ? Number(banked.amount) : 0,
    };
    if (leaving === 'ACTIVE') {
      // Exactly one week, at the #1270 rate; nothing banked.
      expect(outcome).toEqual({
        status: 'ACTIVE', nextBillingDate: new Date(due.getTime() + 7 * DAY).toISOString(), weeksGranted: 1, banked: 0,
      });
      expect(polled.settled).toBeGreaterThanOrEqual(1);
      expect(Number(successes[0]!.amount)).toBe(rate);
      expect(Number(wallet?.balance ?? 0)).toBe(0);
    } else {
      // Never reactivated, never advanced: the approval is banked at the #1270 rate.
      expect(outcome).toEqual({ status: 'CANCELLED', nextBillingDate: due.toISOString(), weeksGranted: 0, banked: rate });
      expect(polled.banked).toBeGreaterThanOrEqual(1);
      expect(after.autoRenew).toBe(false); // no billing job selects it again
      expect(after.nextRetryAt).toBeNull();
      expect(banked).toMatchObject({ type: 'PREPAID_TOPUP', currencyCode: 'GYD' });
      expect(Number(wallet!.balance)).toBe(rate);
    }

    // Either way the money is received exactly once, on the issued row.
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ id: issued.id, status: 'CAPTURED' });
    expect(Number(payments[0]!.amount)).toBe(rate);

    // A second observation changes nothing: the disposition is final.
    await billing.pollPendingMmgCharges();
    const again = await app.prisma.subscription.findUniqueOrThrow({ where: { id: p.subId } });
    expect({ status: again.status, next: again.nextBillingDate.getTime() })
      .toEqual({ status: after.status, next: after.nextBillingDate.getTime() });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: p.subId, type: { in: ['CHARGE_SUCCESS', 'PREPAID_TOPUP'] } } }))
      .toBe(1);
  });
});

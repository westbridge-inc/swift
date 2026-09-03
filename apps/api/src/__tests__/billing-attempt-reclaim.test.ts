import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { sandboxResetMmg } from '../providers/mmg/mmg-provider';

// ---------------------------------------------------------------------------
// [DB-028] A CRASH MID-ATTEMPT STOPPED BILLING A SUBSCRIBER FOREVER.
//
// `billSubscription` claims its work by inserting an immutable CHARGE_ATTEMPT
// keyed by (subscription, period, failed-attempt level). That insert is the
// lock. It is also append-only evidence — which is precisely why it makes a
// bad lock: a run that commits it and then dies holds the claim for good.
// Nothing moves the period or the attempt level, so every later cycle
// recomputes the SAME key, collides on it, and skips. The subscriber is never
// billed again, never dunned, never suspended, and the nightly invariant
// reports the symptom (ACTIVE but unpaid) without repairing anything.
//
// Later work closed the two shapes that leave a trace: a recorded CHARGE_FAILED
// whose outcome never applied is resumed (M-04), and a reserved provider intent
// is recognised as pending rather than skipped (M-01, TA-S0-002). The shape
// with NO trace at all — attempt committed, then nothing — was still permanent.
//
// It is now reclaimable: once an attempt is older than any run could still be
// inside, with no success, no failure and no live intent, a later cycle takes
// it forward. The reclaim is itself keyed, so two cycles cannot both proceed,
// and its generation lets a reclaim that dies in turn be reclaimed rather than
// becoming a second permanent block.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const STALE = 31 * 60 * 1000; // just past the 30-minute window

let app: FastifyInstance;
let billing: BillingService;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdSubIds: string[] = [];
let seq = 0;
const phoneBase = 592_009_400_000 + Math.floor(Math.random() * 500_000);

async function makeSub(opts: { due: Date; rate?: number; method?: string }) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Reclaim', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  createdUserIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Reclaim Vendor ${seq}`, slug: `reclaim-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 300_000 + seq}`,
      addressLine1: '9 Attempt St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: opts.rate ?? 2100,
      billingMethod: (opts.method ?? 'CASH') as never,
      mmgPayerMsisdn: `59260966${String(seq).padStart(2, '0')}`,
      currentPeriodStart: new Date(opts.due.getTime() - WEEK), currentPeriodEnd: opts.due, nextBillingDate: opts.due,
    },
  });
  createdSubIds.push(sub.id);
  return sub;
}

const withRelations = (subId: string) =>
  app.prisma.subscription.findUniqueOrThrow({
    where: { id: subId },
    include: {
      rider: { select: { userId: true } },
      driver: { select: { userId: true } },
      vendor: { select: { id: true, owner: { select: { userId: true } } } },
    },
  });

const attemptKey = (sub: { id: string; nextBillingDate: Date; failedAttempts: number }) =>
  `charge:${sub.id}:${sub.nextBillingDate.toISOString().slice(0, 10)}:a${sub.failedAttempts}`;

/** The residue a crash leaves: the attempt committed, and nothing else. */
async function crashMidAttempt(sub: { id: string; nextBillingDate: Date; failedAttempts: number }, ageMs: number) {
  await app.prisma.billingEvent.create({
    data: {
      subscriptionId: sub.id, type: 'CHARGE_ATTEMPT', amount: 2100, currencyCode: 'GYD',
      idempotencyKey: attemptKey(sub),
      createdAt: new Date(Date.now() - ageMs),
    },
  });
}

const events = (subId: string) =>
  app.prisma.billingEvent.findMany({ where: { subscriptionId: subId }, select: { type: true, idempotencyKey: true }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  await app.prisma.tenant.upsert({ where: { id: 'swift-default' }, update: {}, create: { id: 'swift-default', name: 'Swift', slug: 'swift-default' } });
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});
afterEach(() => sandboxResetMmg());
afterAll(async () => {
  if (createdSubIds.length) {
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: createdSubIds } } });
    await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: createdSubIds } } });
    await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: createdSubIds } } });
    await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: createdSubIds } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: createdSubIds } } });
  }
  if (createdUserIds.length) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('[DB-028] an abandoned attempt is reclaimed, not skipped forever', () => {
  it('the crash residue used to suppress billing permanently; the next cycle now takes it forward', async () => {
    const due = new Date(Date.now() - HOUR);
    const sub = await makeSub({ due });
    await crashMidAttempt(sub, STALE);

    // fund the wallet so the reclaimed charge has somewhere to land
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: sub.id, balance: 5000 } });

    const outcome = await billing.billSubscription(await withRelations(sub.id) as never);
    expect(outcome).toBe('succeeded');

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.nextBillingDate.getTime()).toBeGreaterThan(due.getTime()); // the period MOVED
    const keys = (await events(sub.id)).map((e) => e.idempotencyKey);
    expect(keys.filter((k) => k?.startsWith('reclaim:'))).toHaveLength(1);
    expect(keys.filter((k) => k?.startsWith('success:'))).toHaveLength(1);
  });

  it('a FRESH attempt is still skipped — a run that is genuinely mid-charge is never stolen from', async () => {
    const sub = await makeSub({ due: new Date(Date.now() - HOUR) });
    await crashMidAttempt(sub, 60_000); // one minute old: a live run
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: sub.id, balance: 5000 } });

    expect(await billing.billSubscription(await withRelations(sub.id) as never)).toBe('skipped');
    const keys = (await events(sub.id)).map((e) => e.idempotencyKey);
    expect(keys.filter((k) => k?.startsWith('reclaim:'))).toHaveLength(0);
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.nextBillingDate.getTime()).toBe(sub.nextBillingDate.getTime()); // untouched
  });

  it('two cycles reaching the same stale attempt together: ONE reclaims, one skips, the subscriber is charged ONCE', async () => {
    const sub = await makeSub({ due: new Date(Date.now() - HOUR) });
    await crashMidAttempt(sub, STALE);
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: sub.id, balance: 20000 } });

    const loaded = await withRelations(sub.id);
    const results = await Promise.all([
      billing.billSubscription(loaded as never).catch(() => 'error' as const),
      billing.billSubscription(loaded as never).catch(() => 'error' as const),
      billing.billSubscription(loaded as never).catch(() => 'error' as const),
    ]);
    expect(results.filter((r) => r === 'succeeded')).toHaveLength(1);
    expect(results.filter((r) => r === 'skipped')).toHaveLength(2);

    const keys = (await events(sub.id)).map((e) => e.idempotencyKey);
    expect(keys.filter((k) => k?.startsWith('reclaim:'))).toHaveLength(1);
    expect(keys.filter((k) => k?.startsWith('success:'))).toHaveLength(1);
    const receipts = await app.prisma.feeReceipt.count({ where: { subscriptionId: sub.id } });
    expect(receipts).toBeLessThanOrEqual(1);
  });

  it('a stale attempt whose period ALREADY succeeded is never re-charged — the money is not taken twice', async () => {
    const due = new Date(Date.now() - HOUR);
    const sub = await makeSub({ due });
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: sub.id, balance: 20000 } });
    // a completed charge for this period, then a stale attempt at the same level
    expect(await billing.billSubscription(await withRelations(sub.id) as never)).toBe('succeeded');
    const reloaded = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    const balanceAfterFirst = await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } });

    // rewind the period so the old attempt key is live again, and age it
    await app.prisma.subscription.update({ where: { id: sub.id }, data: { nextBillingDate: due } });
    await app.prisma.billingEvent.updateMany({
      where: { subscriptionId: sub.id, type: 'CHARGE_ATTEMPT' },
      data: { createdAt: new Date(Date.now() - STALE) },
    });

    const outcome = await billing.billSubscription({ ...reloaded, nextBillingDate: due, vendor: null, rider: null, driver: null } as never);
    expect(outcome).toBe('skipped');
    const balanceNow = await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } });
    expect(Number(balanceNow.balance)).toBe(Number(balanceAfterFirst.balance));
  });

  it('a stale attempt with a LIVE provider intent is pending, never reclaimed — no second prompt on a payer’s phone', async () => {
    const due = new Date(Date.now() - HOUR);
    const sub = await makeSub({ due, method: 'MOBILE_MONEY' });
    await crashMidAttempt(sub, STALE);
    await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: sub.id, amount: 2100, status: 'PENDING', paymentMethod: 'MOBILE_MONEY',
        periodStart: new Date(due.getTime() - WEEK), periodEnd: due,
        clientKey: `sub:${sub.id}:${due.toISOString().slice(0, 10)}:a0`,
      },
    });
    expect(await billing.billSubscription(await withRelations(sub.id) as never)).toBe('pending');
    const keys = (await events(sub.id)).map((e) => e.idempotencyKey);
    expect(keys.filter((k) => k?.startsWith('reclaim:'))).toHaveLength(0);
  });

  it('a reclaim that dies in turn is reclaimable by the next generation — one permanent block is not swapped for another', async () => {
    const sub = await makeSub({ due: new Date(Date.now() - HOUR) });
    await crashMidAttempt(sub, STALE);
    // generation 0 was won and then died: the reclaim row exists, nothing else
    await app.prisma.billingEvent.create({
      data: {
        subscriptionId: sub.id, type: 'CHARGE_ATTEMPT_RECLAIMED', amount: 0, currencyCode: 'GYD',
        idempotencyKey: `reclaim:${sub.id}:${sub.nextBillingDate.toISOString().slice(0, 10)}:a0:g0`,
        createdAt: new Date(Date.now() - STALE), // its run has been gone as long
      },
    });
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: sub.id, balance: 5000 } });

    expect(await billing.billSubscription(await withRelations(sub.id) as never)).toBe('succeeded');
    const keys = (await events(sub.id)).map((e) => e.idempotencyKey);
    expect(keys.filter((k) => k?.startsWith('reclaim:'))).toHaveLength(2); // g0 and g1
    expect(keys.filter((k) => k?.startsWith('success:'))).toHaveLength(1);
  });

  it('a reclaim IN PROGRESS blocks a second cycle — the winner is charging right now, and two live charges is the whole defect', async () => {
    const sub = await makeSub({ due: new Date(Date.now() - HOUR) });
    await crashMidAttempt(sub, STALE);
    // a cycle won the reclaim moments ago and is inside the charge
    await app.prisma.billingEvent.create({
      data: {
        subscriptionId: sub.id, type: 'CHARGE_ATTEMPT_RECLAIMED', amount: 0, currencyCode: 'GYD',
        idempotencyKey: `reclaim:${sub.id}:${sub.nextBillingDate.toISOString().slice(0, 10)}:a0:g0`,
      },
    });
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: sub.id, balance: 20000 } });

    expect(await billing.billSubscription(await withRelations(sub.id) as never)).toBe('skipped');
    const keys = (await events(sub.id)).map((e) => e.idempotencyKey);
    expect(keys.filter((k) => k?.startsWith('reclaim:'))).toHaveLength(1); // no g1
    expect(keys.filter((k) => k?.startsWith('success:'))).toHaveLength(0);
    const balance = await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } });
    expect(Number(balance.balance)).toBe(20000); // not charged alongside the winner
  });

  it('the fence itself: the database refuses a second event under one reclaim key', async () => {
    const sub = await makeSub({ due: new Date(Date.now() - HOUR) });
    const key = `reclaim:${sub.id}:${sub.nextBillingDate.toISOString().slice(0, 10)}:a0:g0`;
    const row = { subscriptionId: sub.id, type: 'CHARGE_ATTEMPT_RECLAIMED' as const, amount: 0, currencyCode: 'GYD', idempotencyKey: key };
    await app.prisma.billingEvent.create({ data: row });
    await expect(app.prisma.billingEvent.create({ data: row })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a recorded FAILURE still resumes its outcome rather than being reclaimed — the older repair is untouched', async () => {
    const due = new Date(Date.now() - HOUR);
    const sub = await makeSub({ due });
    await crashMidAttempt(sub, STALE);
    await app.prisma.billingEvent.create({
      data: {
        subscriptionId: sub.id, type: 'CHARGE_FAILED', amount: 2100, currencyCode: 'GYD',
        idempotencyKey: `failed:${sub.id}:${due.toISOString().slice(0, 10)}:a0`,
        note: 'Insufficient balance',
      },
    });
    const outcome = await billing.billSubscription(await withRelations(sub.id) as never);
    expect(outcome).toBe('failed');
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.failedAttempts).toBe(1); // the outcome APPLIED
    const keys = (await events(sub.id)).map((e) => e.idempotencyKey);
    expect(keys.filter((k) => k?.startsWith('reclaim:'))).toHaveLength(0);
  });
});

describe('[DB-028] no aged attempt is left unaccounted for', () => {
  it('the census: every attempt older than the window maps to a success, a failure, a live intent, or a reclaim', async () => {
    const orphans: string[] = [];
    const aged = await app.prisma.billingEvent.findMany({
      where: {
        type: 'CHARGE_ATTEMPT',
        subscriptionId: { in: createdSubIds },
        createdAt: { lt: new Date(Date.now() - 30 * 60 * 1000) },
      },
      select: { subscriptionId: true, idempotencyKey: true },
    });
    for (const attempt of aged) {
      const base = attempt.idempotencyKey!.replace(/^charge:/, '');
      const period = base.split(':').slice(1, 2)[0];
      const [success, failure, reclaim, intent] = await Promise.all([
        app.prisma.billingEvent.count({ where: { subscriptionId: attempt.subscriptionId, idempotencyKey: { startsWith: `success:${attempt.subscriptionId}:${period}` } } }),
        app.prisma.billingEvent.count({ where: { subscriptionId: attempt.subscriptionId, idempotencyKey: `failed:${base}` } }),
        app.prisma.billingEvent.count({ where: { subscriptionId: attempt.subscriptionId, idempotencyKey: { startsWith: `reclaim:${base}:` } } }),
        app.prisma.subscriptionPayment.count({ where: { subscriptionId: attempt.subscriptionId, status: { in: ['PENDING', 'UNKNOWN'] } } }),
      ]);
      if (success + failure + reclaim + intent === 0) orphans.push(attempt.idempotencyKey!);
    }
    expect(orphans).toEqual([]);
  });
});

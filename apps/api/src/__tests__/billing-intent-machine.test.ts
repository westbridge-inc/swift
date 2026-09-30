import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService, type BillingObserver } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { sandboxSetTxStatus, sandboxAddHistory, sandboxResetMmg } from '../providers/mmg/mmg-provider';
import { windDownPartner } from '../modules/user/partner-wind-down';

// ---------------------------------------------------------------------------
// TOLLGATE A2 — the intent machine. UNKNOWN is a first-class state [LAW M-5]:
// an initiate that dies transport-shaped becomes an UNKNOWN intent that is
// never auto-failed, adopts the provider's id from history when the request
// actually landed; an empty history past TTL cannot revoke a dispatched
// instruction. Confirmed provider terminals dun; approval settles in ONE
// transaction (SWIFT-004 closed); a late approval for an already-covered week
// BANKS as wallet balance [BE-08] — a payer's money is never dropped.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

let app: FastifyInstance;
let billing: BillingService;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdSubIds: string[] = [];
let seq = 0;
const phoneBase = 592_009_300_000 + Math.floor(Math.random() * 800_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function makeVendorMmgSub(opts: { due: Date; msisdn?: string; rate?: number }) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Intent', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  createdUserIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Intent Vendor ${seq}`, slug: `intent-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 700_000 + seq}`,
      addressLine1: '4 Poller Rd', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: opts.rate ?? 2100,
      billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: opts.msisdn ?? `59260955${String(seq).padStart(2, '0')}`,
      currentPeriodStart: new Date(opts.due.getTime() - WEEK), currentPeriodEnd: opts.due, nextBillingDate: opts.due,
    },
  });
  createdSubIds.push(sub.id);
  return { sub, userId: user.id };
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
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();

  await app.prisma.tenant.upsert({
    where: { id: 'swift-default' },
    update: {},
    create: { id: 'swift-default', name: 'Swift', slug: 'swift-default' },
  });

  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

afterEach(() => sandboxResetMmg());

afterAll(async () => {
  if (createdSubIds.length) {
    await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: createdSubIds } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: createdSubIds } } });
  }
  if (createdUserIds.length) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('LAW M-5 — UNKNOWN is a first-class state', () => {
  it('an initiate that dies transport-shaped becomes an UNKNOWN intent — never a dunning failure', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub } = await makeVendorMmgSub({ due, msisdn: 'initerror-5926091' });

    const outcome = await billing.billSubscription(await subWithRelations(sub.id));
    expect(outcome).toBe('pending');

    const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(intent.status).toBe('UNKNOWN');
    expect(intent.clientKey).toBeTruthy();
    expect(intent.externalRef).toBeNull();
    expect(intent.failureCode).toBe('TIMEOUT_UNKNOWN');
    // No dunning: zero CHARGE_FAILED events, failedAttempts untouched
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'CHARGE_FAILED' } })).toBe(0);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).failedAttempts).toBe(0);
  });

  it('SWIFT-004 refuses to fire a second request over a live UNKNOWN intent', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub } = await makeVendorMmgSub({ due, msisdn: 'initerror-5926092' });
    await billing.billSubscription(await subWithRelations(sub.id));

    // Clear the retry clock and re-bill the same period at the same attempt
    // level — the UNKNOWN prior must defer it, not double-prompt the payer.
    await app.prisma.subscription.update({ where: { id: sub.id }, data: { nextRetryAt: null } });
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: sub.id, type: 'CHARGE_ATTEMPT' } });
    const second = await billing.billSubscription(await subWithRelations(sub.id));
    expect(second).toBe('pending');
    expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: sub.id } })).toBe(1);
  });

  it('the poller ADOPTS an UNKNOWN intent from history when the request actually landed [6.6]', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub } = await makeVendorMmgSub({ due, msisdn: 'initerror-5926093' });
    await billing.billSubscription(await subWithRelations(sub.id));
    const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });

    // MMG did receive it — history carries our reference with THEIR id.
    sandboxAddHistory({ transactionId: `mmgtx_hist_amt210000_${nanoid(6)}`, status: 'approved', amountMinor: 210000, currencyCode: 'GYD', reference: intent.clientKey! });
    const r1 = await billing.pollPendingMmgCharges(new Date());
    expect(r1.adopted).toBe(1);

    const adopted = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: intent.id } });
    expect(adopted.status).toBe('PENDING');
    expect(adopted.externalRef).toContain('mmgtx_hist_');

    // Next due tick resolves it like any pending row — approved settles.
    const r2 = await billing.pollPendingMmgCharges(new Date(Date.now() + 2 * HOUR));
    expect(r2.settled).toBe(1);
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.nextBillingDate.getTime()).toBe(due.getTime() + WEEK);
  });

  it('an authorized UNKNOWN stays pollable past TTL when history has no record', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub } = await makeVendorMmgSub({ due, msisdn: 'initerror-5926094' });
    await billing.billSubscription(await subWithRelations(sub.id));

    // Before TTL: stays UNKNOWN (history is empty, provider reachable).
    // Assertions are row-scoped — the poller is global and other tests'
    // intents share the table.
    await billing.pollPendingMmgCharges(new Date(Date.now() + HOUR));
    const held = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(held.status).toBe('UNKNOWN');

    // Past TTL: absence is not proof that the dispatched request cannot capture.
    await billing.pollPendingMmgCharges(new Date(Date.now() + 25 * HOUR));
    const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(intent.status).toBe('UNKNOWN');
    expect(intent.failureRaw).toMatchObject({ providerEffect: 'AUTHORIZED' });
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.failedAttempts).toBe(0);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'CHARGE_FAILED' } })).toBe(0);
  });
});

describe('BE-08 / BE-07 — a payer approval is NEVER dropped', () => {
  it('a late approval for an already-covered week BANKS as wallet balance, never a double week', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub, userId } = await makeVendorMmgSub({ due, msisdn: '5926095001' });

    // The live MMG request for this week...
    const outcome = await billing.billSubscription(await subWithRelations(sub.id));
    expect(outcome).toBe('pending');
    const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    sandboxSetTxStatus(intent.externalRef!, 'pending'); // frozen on the payer's phone

    // ...meanwhile the week gets covered by another rail (mimic the prepaid
    // settle's server-side truth: success event + period advance).
    const periodKey = due.toISOString().slice(0, 10);
    await app.prisma.billingEvent.create({
      data: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS', amount: 2100, idempotencyKey: `success:${sub.id}:${periodKey}`, paymentRef: 'prepaid' },
    });
    await app.prisma.subscription.update({
      where: { id: sub.id },
      data: { currentPeriodStart: due, currentPeriodEnd: new Date(due.getTime() + WEEK), nextBillingDate: new Date(due.getTime() + WEEK) },
    });

    // The payer approves anyway. The money banks; the period does NOT re-advance.
    sandboxSetTxStatus(intent.externalRef!, 'approved');
    const polled = await billing.pollPendingMmgCharges(new Date(Date.now() + 10 * 60_000));
    expect(polled.banked).toBe(1);
    expect(polled.settled).toBe(0);

    const wallet = await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } });
    expect(Number(wallet.balance)).toBe(2100);
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.nextBillingDate.getTime()).toBe(due.getTime() + WEEK); // unchanged
    const captured = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: intent.id } });
    expect(captured.status).toBe('CAPTURED');
    // Receipted, ledger-backed, payer told the truth
    expect(await app.prisma.feeReceipt.count({ where: { subscriptionId: sub.id } })).toBe(1);
    expect(await app.prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:bank:${intent.id}` } })).toBe(1);
    const note = await app.prisma.notification.findFirst({ where: { userId, data: { path: ['kind'], equals: 'billing_banked' } } });
    expect(note).toBeTruthy();
  });

  it('full BE-07 story: expired request honored late — the money banks after the retry paid the week', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub } = await makeVendorMmgSub({ due, msisdn: '5926095002' });

    // a0 request goes out; MMG itself confirms expiry before dunning.
    await billing.billSubscription(await subWithRelations(sub.id));
    const a0 = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    sandboxSetTxStatus(a0.externalRef!, 'expired');
    const t1 = new Date(Date.now() + 25 * HOUR);
    await billing.pollPendingMmgCharges(t1);
    expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: a0.id } })).status).toBe('EXPIRED');

    // SWIFT-004 lets a retry through only over that provider-confirmed terminal.

    // The a1 retry goes out and the payer approves IT → the week is paid.
    await app.prisma.subscription.update({ where: { id: sub.id }, data: { nextRetryAt: null } });
    const second = await billing.billSubscription(await subWithRelations(sub.id), t1);
    expect(second).toBe('pending');
    const a1 = await app.prisma.subscriptionPayment.findFirstOrThrow({
      where: { subscriptionId: sub.id, id: { not: a0.id } },
    });
    const r2 = await billing.pollPendingMmgCharges(new Date(t1.getTime() + 10 * 60_000));
    expect(r2.settled).toBe(1);

    // MMG then honors the EXPIRED a0 anyway (BE-07). Re-open it as the
    // provider would report it and poll: the money BANKS.
    sandboxSetTxStatus(a0.externalRef!, 'approved');
    await app.prisma.subscriptionPayment.update({ where: { id: a0.id }, data: { status: 'UNKNOWN' } }); // portal check reopened it
    const r3 = await billing.pollPendingMmgCharges(new Date(t1.getTime() + 20 * 60_000));
    expect(r3.banked).toBe(1);
    const wallet = await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } });
    expect(Number(wallet.balance)).toBe(2100);
    expect(await app.prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:bank:${a0.id}` } })).toBe(1);
    void a1;
  });
});

describe('atomic claim+advance and the poll ladder', () => {
  it('two concurrent polls on one approved intent: one advance, one ledger posting, one captured row', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub } = await makeVendorMmgSub({ due, msisdn: '5926095003' });
    await billing.billSubscription(await subWithRelations(sub.id));
    const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    sandboxSetTxStatus(intent.externalRef!, 'approved');

    const now = new Date(Date.now() + 10 * 60_000);
    const [r1, r2] = await Promise.all([billing.pollPendingMmgCharges(now), billing.pollPendingMmgCharges(now)]);
    expect((r1.settled + r2.settled)).toBe(1);
    expect((r1.banked + r2.banked)).toBe(0);

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.nextBillingDate.getTime()).toBe(due.getTime() + WEEK); // advanced exactly once
    expect(await app.prisma.ledgerTransaction.count({ where: { idempotencyKey: { startsWith: `ledger:success:${sub.id}` } } })).toBe(1);
    expect(await app.prisma.subscriptionPayment.count({ where: { subscriptionId: sub.id, status: 'CAPTURED' } })).toBe(1);
  });

  it('the backoff ladder stamps every poll and skips rows before they are due again', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub } = await makeVendorMmgSub({ due, msisdn: '5926095004' });
    await billing.billSubscription(await subWithRelations(sub.id));
    const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    sandboxSetTxStatus(intent.externalRef!, 'pending');

    const t0 = new Date();
    await billing.pollPendingMmgCharges(t0);
    const stamped = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: intent.id } });
    expect(stamped.lastPolledAt?.getTime()).toBe(t0.getTime());
    expect(stamped.pollBackoffSec).toBeGreaterThanOrEqual(48); // 60s ±20%
    expect(stamped.status).toBe('PENDING');

    // One second later the row is not due — untouched, unpolled.
    await billing.pollPendingMmgCharges(new Date(t0.getTime() + 1000));
    const untouched = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: intent.id } });
    expect(untouched.lastPolledAt?.getTime()).toBe(t0.getTime());
  });

  it('an amount mismatch is held with its normalized code — never settled, flagged once', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub } = await makeVendorMmgSub({ due, msisdn: '5926095005' });
    await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: sub.id, amount: 2100, status: 'PENDING', paymentMethod: 'MOBILE_MONEY',
        externalRef: `mmgtx_mismatch_${nanoid(6)}`, periodStart: due, periodEnd: new Date(due.getTime() + WEEK),
      },
    });
    const r = await billing.pollPendingMmgCharges(new Date());
    expect(r.stillPending).toBe(1);
    const row = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(row.status).toBe('PENDING');
    expect(row.failureCode).toBe('SETTLEMENT_MISMATCH');
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: sub.id, idempotencyKey: { startsWith: 'mismatch:' } } })).toBe(1);
  });

  it('treats a missing provider amount as a mismatch, never as permission to settle', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub } = await makeVendorMmgSub({ due });
    await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: sub.id, amount: 2100, status: 'PENDING', paymentMethod: 'MOBILE_MONEY',
        externalRef: `mmgtx_legacy_zero_${nanoid(6)}`, periodStart: due, periodEnd: new Date(due.getTime() + WEEK),
      },
    });
    await billing.pollPendingMmgCharges(new Date());
    const row = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(row.status).toBe('PENDING');
    expect(row.failureCode).toBe('SETTLEMENT_MISMATCH');
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).nextBillingDate.getTime()).toBe(due.getTime());
  });

  it('requires the provider currency to match before settlement', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub } = await makeVendorMmgSub({ due });
    await app.prisma.subscription.update({ where: { id: sub.id }, data: { currencyCode: 'USD' } });
    await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: sub.id, amount: 2100, status: 'PENDING', paymentMethod: 'MOBILE_MONEY',
        externalRef: `mmgtx_currency_amt210000_${nanoid(6)}`, periodStart: due, periodEnd: new Date(due.getTime() + WEEK),
      },
    });
    await billing.pollPendingMmgCharges(new Date());
    const row = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(row.status).toBe('PENDING');
    expect(row.failureCode).toBe('SETTLEMENT_MISMATCH');
  });
});

describe('late MMG outcomes preserve stopped subscription authority', () => {
  it.each(['before-lock', 'after-commit'] as const)('vendor deletion %s cannot be followed by stale MMG reinstatement', async (ordering) => {
    const due = new Date(Date.now() - HOUR);
    const { sub, userId } = await makeVendorMmgSub({ due });
    await billing.billSubscription(await subWithRelations(sub.id));
    const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    await app.prisma.subscription.update({ where: { id: sub.id }, data: { status: 'SUSPENDED' } });
    await app.prisma.vendor.update({ where: { id: sub.vendorId! }, data: {
      status: 'SUSPENDED', suspensionSource: 'BILLING', acceptingOrders: false,
    } });
    sandboxSetTxStatus(intent.externalRef!, 'approved');
    const atBoundary = deferred();
    const release = deferred();
    const concurrent = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider(), {
      beforeLateMmgAuthorityLock: async (id) => {
        if (id === sub.id && ordering === 'before-lock') { atBoundary.resolve(); await release.promise; }
      },
    });
    const internals = concurrent as unknown as {
      afterSuccessfulCharge(snapshot: Awaited<ReturnType<typeof subWithRelations>>, amount: number, periodKey: string, mmgSettlementCommitted?: boolean): Promise<void>;
    };
    if (ordering === 'after-commit') {
      const afterCharge = internals.afterSuccessfulCharge.bind(concurrent);
      vi.spyOn(internals, 'afterSuccessfulCharge').mockImplementation(async (...args) => {
        atBoundary.resolve();
        await release.promise;
        return afterCharge(...args);
      });
    }
    const polling = concurrent.pollPendingMmgCharges(new Date(Date.now() + 10 * 60_000));
    try {
      await atBoundary.promise;
      if (ordering === 'after-commit') {
        expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: sub.vendorId! } }))
          .toMatchObject({ status: 'ACTIVE', acceptingOrders: true });
      }
      await app.prisma.user.update({ where: { id: userId }, data: { status: 'DEACTIVATED' } });
      await windDownPartner(app.prisma, userId);
    } finally {
      release.resolve();
    }
    const result = await polling;
    expect(result.banked).toBe(ordering === 'before-lock' ? 1 : 0);
    expect(result.settled).toBe(ordering === 'after-commit' ? 1 : 0);
    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ status: 'CANCELLED' });
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: sub.vendorId! } }))
      .toMatchObject({ status: 'SUSPENDED', acceptingOrders: false });
    vi.restoreAllMocks();
  });

  it('poller restores the vendor when suspension committed after its ACTIVE snapshot', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub } = await makeVendorMmgSub({ due });
    await billing.billSubscription(await subWithRelations(sub.id));
    const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    sandboxSetTxStatus(intent.externalRef!, 'approved');
    const arrived = deferred();
    const release = deferred();
    const concurrent = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider(), {
      beforeLateMmgAuthorityLock: async (id) => {
        if (id === sub.id) { arrived.resolve(); await release.promise; }
      },
    });
    const polling = concurrent.pollPendingMmgCharges(new Date(Date.now() + 10 * 60_000));
    try {
      await arrived.promise;
      await app.prisma.$transaction(async (tx) => {
        await tx.subscription.update({ where: { id: sub.id }, data: { status: 'SUSPENDED' } });
        await tx.vendor.update({ where: { id: sub.vendorId! }, data: {
          status: 'SUSPENDED', suspensionSource: 'BILLING', acceptingOrders: false,
        } });
      });
    } finally {
      release.resolve();
    }
    expect((await polling).settled).toBe(1);
    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ status: 'ACTIVE' });
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: sub.vendorId! } }))
      .toMatchObject({ status: 'ACTIVE', acceptingOrders: true });
  });

  it('banks an approval after cancellation exactly once without reactivation or period advance', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub, userId } = await makeVendorMmgSub({ due, msisdn: '5926095101' });
    expect(await billing.billSubscription(await subWithRelations(sub.id))).toBe('pending');
    const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });

    const wound = await windDownPartner(app.prisma, userId);
    expect(wound.subscriptionsCancelled).toBe(1);
    const cancelled = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(cancelled).toMatchObject({ status: 'CANCELLED', autoRenew: false, nextRetryAt: null });

    sandboxSetTxStatus(intent.externalRef!, 'approved');
    await billing.pollPendingMmgCharges(new Date(Date.now() + 10 * 60_000));
    await billing.pollPendingMmgCharges(new Date(Date.now() + 20 * 60_000)); // retry is a no-op

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('CANCELLED');
    expect(after.autoRenew).toBe(false);
    expect(after.nextRetryAt).toBeNull();
    expect(after.currentPeriodStart.getTime()).toBe(sub.currentPeriodStart.getTime());
    expect(after.currentPeriodEnd.getTime()).toBe(sub.currentPeriodEnd.getTime());
    expect(after.nextBillingDate.getTime()).toBe(due.getTime());
    expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('CAPTURED');
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } })).balance)).toBe(2100);
    expect(await app.prisma.billingEvent.count({ where: { idempotencyKey: `bank:${intent.id}` } })).toBe(1);
    expect(await app.prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:bank:${intent.id}` } })).toBe(1);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS' } })).toBe(0);
  });

  it('honours the account-deletion cutoff even if partner wind-down has not reached the subscription yet', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub, userId } = await makeVendorMmgSub({ due, msisdn: '5926095107' });
    expect(await billing.billSubscription(await subWithRelations(sub.id))).toBe('pending');
    const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });

    // deleteAccount commits this authority cut-off before its best-effort
    // partner wind-down. Reproduce that real gap: the subscription is stale
    // ACTIVE when the old MMG prompt approves.
    await app.prisma.user.update({ where: { id: userId }, data: { status: 'DEACTIVATED' } });
    sandboxSetTxStatus(intent.externalRef!, 'approved');
    await billing.pollPendingMmgCharges(new Date(Date.now() + 10 * 60_000));

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after).toMatchObject({ status: 'CANCELLED', autoRenew: false, nextRetryAt: null });
    expect(after.nextBillingDate.getTime()).toBe(due.getTime());
    expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('CAPTURED');
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } })).balance)).toBe(2100);
    expect(await app.prisma.billingEvent.count({ where: { idempotencyKey: `bank:${intent.id}` } })).toBe(1);
    expect(await app.prisma.notification.count({ where: { userId, data: { path: ['kind'], equals: 'billing_banked' } } })).toBe(0);
  });

  it('honours the durable deletion tombstone after an admin changes DEACTIVATED to BANNED', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub, userId } = await makeVendorMmgSub({ due, msisdn: '5926095108' });
    expect(await billing.billSubscription(await subWithRelations(sub.id))).toBe('pending');
    const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });

    await app.prisma.user.update({
      where: { id: userId },
      data: { status: 'BANNED', phone: `deleted:${userId}` },
    });
    sandboxSetTxStatus(intent.externalRef!, 'approved');
    await billing.pollPendingMmgCharges(new Date(Date.now() + 10 * 60_000));

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after).toMatchObject({ status: 'CANCELLED', autoRenew: false, nextRetryAt: null });
    expect(after.nextBillingDate.getTime()).toBe(due.getTime());
    expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('CAPTURED');
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } })).balance)).toBe(2100);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS' } })).toBe(0);
    expect(await app.prisma.notification.count({ where: { userId, data: { path: ['kind'], equals: 'billing_success' } } })).toBe(0);
  });

  it.each([false, true])('proves PostgreSQL lock ordering against an arrived poller (remove prepaid lock: %s)', async (removePrepaidLock) => {
    const due = new Date(Date.now() - HOUR);
    const { sub } = await makeVendorMmgSub({ due, msisdn: '5926095109' });
    const prepaidDebited = deferred();
    const releasePrepaid = deferred();
    const lateArrived = deferred();
    const releaseLate = deferred();
    let lateAuthorityLocked = false;
    let prepaidPid = 0;
    let latePid = 0;
    const observer: BillingObserver = {
      afterSuccessfulChargePrepaidDebit: async (subscriptionId, tx) => {
        if (subscriptionId !== sub.id) return;
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        if (!backend) throw new Error('Missing prepaid backend identity');
        prepaidPid = backend.pid;
        prepaidDebited.resolve();
        await releasePrepaid.promise;
      },
      beforeLateMmgAuthorityLock: async (subscriptionId, tx) => {
        if (subscriptionId !== sub.id) return;
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        if (!backend) throw new Error('Missing poller backend identity');
        latePid = backend.pid;
        lateArrived.resolve();
      },
      afterLateMmgAuthorityLocked: async (subscriptionId) => {
        if (subscriptionId !== sub.id) return;
        lateAuthorityLocked = true;
        await releaseLate.promise;
        // The mutation is diagnostic: stop after proving it took the lock,
        // before it can form the actual wallet/subscription deadlock.
        if (removePrepaidLock) throw new Error('LOCK_ORDER_MUTATION_DETECTED');
      },
    };
    // Fixture dispatch itself takes the authority lock. Only arm the barriers
    // after it has committed, so they observe the intended prepaid/poller race.
    expect(await billing.billSubscription(await subWithRelations(sub.id))).toBe('pending');
    const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    sandboxSetTxStatus(intent.externalRef!, 'approved');
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: sub.id, balance: 2100 } });

    const concurrent = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider(), observer);
    const cashSnapshot = { ...await subWithRelations(sub.id), billingMethod: 'CASH' as const };
    const internals = concurrent as unknown as {
      lockSubscriptionMoneyAuthority(tx: Prisma.TransactionClient, snapshot: typeof cashSnapshot): Promise<{
        payerStatus: string; payerPhone: string; status: typeof cashSnapshot.status; autoRenew: boolean;
      }>;
      applySuccessfulCharge(
        snapshot: typeof cashSnapshot, amount: number, ref: string, now: Date, periodKey: string,
        settlePaymentId?: string, usdTrio?: undefined, spendPrepaid?: number,
      ): Promise<boolean>;
    };
    if (removePrepaidLock) {
      // One-call mutation: prepaid skips its authority locks. MMG still takes
      // the real PostgreSQL locks, so the same oracle must detect the defect.
      vi.spyOn(internals, 'lockSubscriptionMoneyAuthority').mockResolvedValueOnce({
        payerStatus: 'ACTIVE', payerPhone: '', status: cashSnapshot.status, autoRenew: cashSnapshot.autoRenew,
      });
    }
    const prepaid = internals.applySuccessfulCharge(
      cashSnapshot, 2100, 'prepaid', new Date(), due.toISOString().slice(0, 10), undefined, undefined, 2100,
    );
    let late: ReturnType<BillingService['pollPendingMmgCharges']> | undefined;
    const awaitBarrier = async (barrier: Promise<void>, operation: Promise<unknown>, label: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          barrier,
          operation.then(() => { throw new Error(`${label}: operation completed before its barrier`); }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label}: barrier timed out`)), 4000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    };
    let blockedByPrepaid = false;
    try {
      await awaitBarrier(prepaidDebited.promise, prepaid, 'prepaid debit');
      late = concurrent.pollPendingMmgCharges(new Date(Date.now() + 10 * 60_000));
      await awaitBarrier(lateArrived.promise, late, 'late poller arrival');
      const deadline = Date.now() + 4000;
      // An elapsed deadline is a failure, never evidence of blocking. The
      // positive oracle is PostgreSQL naming the exact prepaid backend.
      while (!blockedByPrepaid && !lateAuthorityLocked) {
        const [row] = await app.prisma.$queryRaw<Array<{ blockers: number[] }>>`
          SELECT pg_blocking_pids(${latePid}::integer) AS blockers
        `;
        if (!row) throw new Error('Missing PostgreSQL blocking proof');
        blockedByPrepaid = row.blockers.includes(prepaidPid);
        if (Date.now() > deadline) throw new Error('Poller neither acquired authority nor proved blocked by prepaid');
        if (!blockedByPrepaid && !lateAuthorityLocked) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      releasePrepaid.resolve();
      releaseLate.resolve();
      await Promise.allSettled([prepaid, ...(late ? [late] : [])]);
    }
    const outcomes = await Promise.allSettled([prepaid, late!]);

    expect(blockedByPrepaid).toBe(!removePrepaidLock);
    vi.restoreAllMocks();
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    if (removePrepaidLock) {
      expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('PENDING');
      return;
    }
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.nextBillingDate.getTime()).toBe(due.getTime() + WEEK);
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } })).balance)).toBe(2100);
    expect(await app.prisma.billingEvent.count({ where: { idempotencyKey: `success:${sub.id}:${due.toISOString().slice(0, 10)}` } })).toBe(1);
    expect(await app.prisma.billingEvent.count({ where: { idempotencyKey: `bank:${intent.id}` } })).toBe(1);
    expect(await app.prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:success:${sub.id}:${due.toISOString().slice(0, 10)}` } })).toBe(1);
    expect(await app.prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:bank:${intent.id}` } })).toBe(1);
  });

  it('banks an approval while PAUSED without treating the old prompt as resume authority', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub } = await makeVendorMmgSub({ due, msisdn: '5926095102' });
    expect(await billing.billSubscription(await subWithRelations(sub.id))).toBe('pending');
    const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    await app.prisma.subscription.update({ where: { id: sub.id }, data: { status: 'PAUSED' } });

    sandboxSetTxStatus(intent.externalRef!, 'approved');
    await billing.pollPendingMmgCharges(new Date(Date.now() + 10 * 60_000));

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('PAUSED');
    expect(after.autoRenew).toBe(true); // pause is preserved, not rewritten as cancellation
    expect(after.nextBillingDate.getTime()).toBe(due.getTime());
    expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('CAPTURED');
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } })).balance)).toBe(2100);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS' } })).toBe(0);
  });

  it('records declined payment evidence without dunning CANCELLED or PAUSED subscriptions', async () => {
    const due = new Date(Date.now() - HOUR);
    const cancelledFixture = await makeVendorMmgSub({ due, msisdn: '5926095103' });
    const pausedFixture = await makeVendorMmgSub({ due, msisdn: '5926095104' });
    await billing.billSubscription(await subWithRelations(cancelledFixture.sub.id));
    await billing.billSubscription(await subWithRelations(pausedFixture.sub.id));
    const cancelledIntent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: cancelledFixture.sub.id } });
    const pausedIntent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: pausedFixture.sub.id } });
    await windDownPartner(app.prisma, cancelledFixture.userId);
    await app.prisma.subscription.update({ where: { id: pausedFixture.sub.id }, data: { status: 'PAUSED' } });
    sandboxSetTxStatus(cancelledIntent.externalRef!, 'declined');
    sandboxSetTxStatus(pausedIntent.externalRef!, 'declined');

    await billing.pollPendingMmgCharges(new Date(Date.now() + 10 * 60_000));

    const cancelled = await app.prisma.subscription.findUniqueOrThrow({ where: { id: cancelledFixture.sub.id } });
    const paused = await app.prisma.subscription.findUniqueOrThrow({ where: { id: pausedFixture.sub.id } });
    expect(cancelled).toMatchObject({ status: 'CANCELLED', autoRenew: false, failedAttempts: 0, nextRetryAt: null });
    expect(paused.status).toBe('PAUSED');
    expect(paused.autoRenew).toBe(true);
    expect(paused.failedAttempts).toBe(0);
    expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: cancelledIntent.id } })).status).toBe('FAILED');
    expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: pausedIntent.id } })).status).toBe('FAILED');
    expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: cancelledIntent.id } })).failureRaw)
      .toMatchObject({ subscriptionOutcome: 'PRESERVED_NO_DUNNING', subscriptionStatus: 'CANCELLED' });
    expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: pausedIntent.id } })).failureRaw)
      .toMatchObject({ subscriptionOutcome: 'PRESERVED_NO_DUNNING', subscriptionStatus: 'PAUSED' });
    expect(await app.prisma.billingEvent.count({
      where: { subscriptionId: { in: [cancelledFixture.sub.id, pausedFixture.sub.id] }, type: 'CHARGE_FAILED' },
    })).toBe(0);
  });

  it('records a provider-confirmed expiry without dunning cancellation', async () => {
    const due = new Date(Date.now() - HOUR);
    const fixture = await makeVendorMmgSub({ due, msisdn: '5926095110' });
    await billing.billSubscription(await subWithRelations(fixture.sub.id));
    const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: fixture.sub.id } });
    await windDownPartner(app.prisma, fixture.userId);
    sandboxSetTxStatus(intent.externalRef!, 'expired');

    await billing.pollPendingMmgCharges(new Date(Date.now() + 25 * HOUR));

    const payment = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: intent.id } });
    expect(payment.status).toBe('EXPIRED');
    expect(payment.failureRaw).toMatchObject({ subscriptionOutcome: 'PRESERVED_NO_DUNNING', subscriptionStatus: 'CANCELLED' });
    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: fixture.sub.id }, select: { status: true, failedAttempts: true } }))
      .toEqual({ status: 'CANCELLED', failedAttempts: 0 });
  });

  it('leaves pending provider truth pending without mutating CANCELLED or PAUSED state', async () => {
    const due = new Date(Date.now() - HOUR);
    const cancelledFixture = await makeVendorMmgSub({ due, msisdn: '5926095105' });
    const pausedFixture = await makeVendorMmgSub({ due, msisdn: '5926095106' });
    await billing.billSubscription(await subWithRelations(cancelledFixture.sub.id));
    await billing.billSubscription(await subWithRelations(pausedFixture.sub.id));
    const cancelledIntent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: cancelledFixture.sub.id } });
    const pausedIntent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: pausedFixture.sub.id } });
    await windDownPartner(app.prisma, cancelledFixture.userId);
    await app.prisma.subscription.update({ where: { id: pausedFixture.sub.id }, data: { status: 'PAUSED' } });
    sandboxSetTxStatus(cancelledIntent.externalRef!, 'pending');
    sandboxSetTxStatus(pausedIntent.externalRef!, 'pending');

    await billing.pollPendingMmgCharges(new Date(Date.now() + 10 * 60_000));

    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: cancelledFixture.sub.id }, select: { status: true, autoRenew: true, failedAttempts: true } }))
      .toEqual({ status: 'CANCELLED', autoRenew: false, failedAttempts: 0 });
    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: pausedFixture.sub.id }, select: { status: true, autoRenew: true, failedAttempts: true } }))
      .toEqual({ status: 'PAUSED', autoRenew: true, failedAttempts: 0 });
    expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: cancelledIntent.id } })).status).toBe('PENDING');
    expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: pausedIntent.id } })).status).toBe('PENDING');
  });
});

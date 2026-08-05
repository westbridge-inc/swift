import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { sandboxSetTxStatus, sandboxAddHistory, sandboxResetMmg } from '../providers/mmg/mmg-provider';

// ---------------------------------------------------------------------------
// TOLLGATE A2 — the intent machine. UNKNOWN is a first-class state [LAW M-5]:
// an initiate that dies transport-shaped becomes an UNKNOWN intent that is
// never auto-failed, adopts the provider's id from history when the request
// actually landed, and expires into dunning only when the provider provably
// has no record past TTL [6.6c]. Approved settles claim+advance in ONE
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
    sandboxAddHistory({ transactionId: `mmgtx_hist_${nanoid(6)}`, status: 'approved', amountMinor: 0, currencyCode: 'GYD', reference: intent.clientKey! });
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

  it('an UNKNOWN the provider has no record of expires at TTL into dunning [6.6c]', async () => {
    const due = new Date(Date.now() - HOUR);
    const { sub } = await makeVendorMmgSub({ due, msisdn: 'initerror-5926094' });
    await billing.billSubscription(await subWithRelations(sub.id));

    // Before TTL: stays UNKNOWN (history is empty, provider reachable).
    // Assertions are row-scoped — the poller is global and other tests'
    // intents share the table.
    await billing.pollPendingMmgCharges(new Date(Date.now() + HOUR));
    const held = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(held.status).toBe('UNKNOWN');

    // Past TTL: closes EXPIRED with the normalized code, duns normally
    await billing.pollPendingMmgCharges(new Date(Date.now() + 25 * HOUR));
    const intent = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(intent.status).toBe('EXPIRED');
    expect(intent.failureCode).toBe('REQUEST_EXPIRED');
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('PAST_DUE');
    expect(after.failedAttempts).toBe(1);
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

    // a0 request goes out, payer ignores it past TTL → EXPIRED, dunning.
    await billing.billSubscription(await subWithRelations(sub.id));
    const a0 = await app.prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    sandboxSetTxStatus(a0.externalRef!, 'pending');
    const t1 = new Date(Date.now() + 25 * HOUR);
    await billing.pollPendingMmgCharges(t1);
    expect((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: a0.id } })).status).toBe('EXPIRED');

    // MMG's own view of a0 moves to expired too — SWIFT-004 lets a real
    // retry through only over a provably-dead prior (a 'pending' answer
    // would correctly defer it; that safety is its own test above).
    sandboxSetTxStatus(a0.externalRef!, 'expired');

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
    expect(row.failureCode).toBe('AMOUNT_MISMATCH');
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: sub.id, idempotencyKey: { startsWith: 'mismatch:' } } })).toBe(1);
  });
});

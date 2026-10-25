import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { AgentCashService, type InboundFeePayment, type IngestResult } from '../modules/billing/agent-cash.service';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { ensureSan } from '../modules/billing/san.service';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';

// Agent-cash ingestion [san spec PARTS 4/13] against the real engine:
// scenario B (suspended → cash → reactivated through recordTopUp's instant
// re-bill), C (partial parks, completing partial converts once), E (x50
// idempotency storm → ONE credit), F (suspense → attach → full trail), and
// the edge matrix rows for currency/amount/clock/dedupe. SO-6 throughout:
// nothing here ever drops money.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
const paymentIds: string[] = [];
let seq = 0;
// [SAFE-B · retained history] A credited payment records an advisory MMG payer observation: immutable evidence
// naming its subscription and account, kept after the suite. Owners and stores therefore live in a phone
// namespace no other suite uses or purges, unique to the run.
const PHONE_PREFIX = retainedPhonePrefix('16');

let svc: AgentCashService;
let billing: BillingService;

async function makeVendorSub(over: Record<string, unknown> = {}) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Cash', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Cash Vendor ${seq}`, slug: `cash-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}${String(500 + seq).padStart(3, '0')}`,
      addressLine1: '4 Agent Row', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH',
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000), nextBillingDate: new Date(Date.now() + 7 * 86_400_000),
      ...over,
    } as never,
  });
  subIds.push(sub.id);
  const san = await ensureSan(prisma, sub.id);
  return { user, vendor, sub, san };
}

function inbound(san: string, over: Partial<InboundFeePayment> = {}): InboundFeePayment {
  return {
    externalId: `TXN-${nanoid(10)}`,
    channel: 'MANUAL_ADMIN',
    sanRaw: san,
    amount: 2100,
    currencyCode: 'GYD',
    paidAt: new Date(),
    raw: { test: true },
    ...over,
  };
}

beforeAll(async () => {
  await prisma.$connect();
  // Service-level test: a stub socket server (send() only needs .to().emit()).
  const io = { to: () => ({ emit: () => undefined }) } as never;
  billing = new BillingService(prisma, new NotificationService(prisma, io), getPaymentProvider());
  svc = new AgentCashService(prisma, billing);
});

afterAll(async () => {
  // [SAFE-B · retained history] A subscription an MMG payer observation names is kept with its money records,
  // store and owner; the rest goes as before, in one transaction. What stays is cancelled without renewal and
  // its store closed, so no later billing cycle reaches it. Identity rows go for everyone, as before.
  try {
    await prisma.$transaction(async (tx) => {
      const kept = await retainedCohort(tx, { subscriptionIds: subIds });
      const goneSubs = without(subIds, kept.subscriptionIds);
      // [#1393] Every suite subscription's shared dunning clock evidence goes (a
      // kept one keeps its money records, never a pending fee demand or hold).
      await cleanupBillingClocks(tx, subIds);
      await tx.mmgAgentPayment.deleteMany({ where: { id: { in: paymentIds }, OR: [{ subscriptionId: null }, { subscriptionId: { in: goneSubs } }] } });
      await tx.billingEvent.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.prepaidBalance.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.sanTombstone.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.subscription.deleteMany({ where: { id: { in: goneSubs } } });
      await tx.vendor.deleteMany({ where: { id: { in: without(vendorIds, kept.vendorIds) } } });
      await tx.vendorOwner.deleteMany({ where: { userId: { in: without(userIds, kept.userIds) } } });
      await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
      await tx.identityKey.deleteMany({ where: { accountId: { in: userIds } } });
      await tx.identityClusterMember.deleteMany({ where: { accountId: { in: userIds } } });
      await tx.user.deleteMany({ where: { id: { in: without(userIds, kept.userIds) } } });
      await retireKeptScaffolding(tx, kept);
    }, { timeout: 60_000 });
  } finally {
    await prisma.$disconnect();
  }
});

const track = <T extends { paymentId: string }>(r: T): T => { paymentIds.push(r.paymentId); return r; };

describe('scenario B — cash reactivates a suspended account with zero human touch', () => {
  it('suspended + past-due sub: agent payment → MATCHED → credit → re-bill → ACTIVE', async () => {
    const past = new Date(Date.now() - 2 * 86_400_000);
    const { sub, san } = await makeVendorSub({
      status: 'SUSPENDED', suspendedAt: past, nextBillingDate: past, currentPeriodEnd: past, failedAttempts: 3,
    });
    const res = track(await svc.ingest(inbound(san, { payerMsisdn: '+5926001234' })));
    expect(res.status).toBe('accepted');

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('ACTIVE'); // the reactivation moment — no human touched anything
    expect(after.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
    const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: res.paymentId } });
    expect(row.status).toBe('MATCHED');
    expect(row.subscriptionId).toBe(sub.id);
    // The credit + the settle both live on the immutable event stream.
    const events = await prisma.billingEvent.findMany({ where: { subscriptionId: sub.id }, select: { type: true } });
    expect(events.map((e) => e.type)).toContain('PREPAID_TOPUP');
    expect(events.map((e) => e.type)).toContain('CHARGE_SUCCESS');
  });
});

describe('scenario C — partial money parks; the completing partial converts exactly once', () => {
  it('GY$1,000 then GY$1,200 at fee GY$2,100 → one charge, only after the second credit', async () => {
    const past = new Date(Date.now() - 86_400_000);
    const { sub, san } = await makeVendorSub({ status: 'PAST_DUE', nextBillingDate: past, currentPeriodEnd: past });
    track(await svc.ingest(inbound(san, { amount: 1000 })));
    let state = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(state.status).toBe('PAST_DUE'); // parked — GY$1,000 buys nothing yet
    const balance1 = await prisma.prepaidBalance.findUnique({ where: { subscriptionId: sub.id } });
    expect(Number(balance1?.balance)).toBe(1000);

    track(await svc.ingest(inbound(san, { amount: 1100 })));
    state = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(state.status).toBe('ACTIVE');
    const charges = await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS' } });
    expect(charges).toBe(1);
    const balance2 = await prisma.prepaidBalance.findUnique({ where: { subscriptionId: sub.id } });
    expect(Number(balance2?.balance)).toBe(0); // 2,100 consumed exactly
  });
});

describe('scenario E — idempotency storm', () => {
  it('the same externalId x50 concurrent → exactly one credit on the ledger', async () => {
    const { sub, san } = await makeVendorSub();
    const p = inbound(san);
    const results = await Promise.all(Array.from({ length: 50 }, () => svc.ingest({ ...p })));
    const accepted = results.filter((r) => r.status === 'accepted');
    const dupes = results.filter((r) => r.status === 'duplicate');
    expect(accepted).toHaveLength(1);
    expect(dupes).toHaveLength(49);
    paymentIds.push(accepted[0]!.paymentId);
    const topups = await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } });
    expect(topups).toBe(1); // ledger-count proof, not application hope
  });

  it('edge 21: the same SAN twice with DIFFERENT receipts = two real credits, not a duplicate', async () => {
    const { sub, san } = await makeVendorSub();
    // [owner #62] Two part-payments of the one coming week: both fit the one-week limit.
    expect(track(await svc.ingest(inbound(san, { amount: 1000 }))).status).toBe('accepted');
    expect(track(await svc.ingest(inbound(san, { amount: 1000 }))).status).toBe('accepted');
    const topups = await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } });
    expect(topups).toBe(2);
  });
});

describe('scenario F + the suspense laws — money is never lost, never rejected', () => {
  it('valid-Luhn unknown SAN → UNMATCHED(SAN_UNKNOWN) → attach → credit + RESOLVED trail', async () => {
    const { generateSan } = await import('../modules/billing/san');
    let unknown = '';
    for (;;) {
      unknown = generateSan();
      if (!(await prisma.subscription.findUnique({ where: { san: unknown } }))
        && !(await prisma.sanTombstone.findUnique({ where: { san: unknown } }))) break;
    }
    const res = track(await svc.ingest(inbound(unknown)));
    expect(res).toMatchObject({ status: 'received_unmatched', failureCode: 'SAN_UNKNOWN' });

    const queue = await svc.unmatchedQueue();
    const mine = queue.find((q) => q.id === res.paymentId)!;
    expect(mine.diagnosis).toContain('valid checksum');

    const { sub } = await makeVendorSub();
    const attached = await svc.attach(res.paymentId, sub.id, 'admin-test');
    expect(attached.status).toBe('accepted');
    const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: res.paymentId } });
    expect(row.status).toBe('RESOLVED');
    expect(row.resolvedBy).toBe('admin-test');
    const topups = await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } });
    expect(topups).toBe(1);
  });

  it('checksum-fail SAN is suspensed with the typo diagnosis (edge 3)', async () => {
    const { san } = await makeVendorSub();
    const wrong = san.slice(0, 9) + String((Number(san[9]) + 1) % 10);
    const res = track(await svc.ingest(inbound(wrong)));
    expect(res).toMatchObject({ status: 'received_unmatched', failureCode: 'SAN_CHECKSUM_FAILED' });
  });

  it('bad currency and out-of-range amounts suspense, never reject (edges 17 / S-10)', async () => {
    const { san } = await makeVendorSub();
    const usd = track(await svc.ingest(inbound(san, { currencyCode: 'USD' })));
    expect(usd).toMatchObject({ status: 'received_unmatched', failureCode: 'BAD_CURRENCY' });
    const big = track(await svc.ingest(inbound(san, { amount: 750_000 })));
    expect(big).toMatchObject({ status: 'received_unmatched', failureCode: 'AMOUNT_OUT_OF_RANGE' });
    const small = track(await svc.ingest(inbound(san, { amount: 200 })));
    expect(small).toMatchObject({ status: 'received_unmatched', failureCode: 'AMOUNT_OUT_OF_RANGE' });
  });

  it('tombstoned SAN routes to suspense — never to a stranger (edge 8)', async () => {
    const { sub, san } = await makeVendorSub();
    const { releaseSan } = await import('../modules/billing/san.service');
    await releaseSan(prisma, sub.id, 'closure-test');
    const res = track(await svc.ingest(inbound(san)));
    expect(res).toMatchObject({ status: 'received_unmatched', failureCode: 'TOMBSTONED' });
  });

  it('zero/negative amounts are the ONE true reject (malformed, not money — edge 16)', async () => {
    const { san } = await makeVendorSub();
    await expect(svc.ingest(inbound(san, { amount: 0 }))).rejects.toThrow('ZERO_OR_NEGATIVE_AMOUNT');
  });

  it('future paidAt clamps to now, original preserved in raw (edge 15)', async () => {
    const { san } = await makeVendorSub();
    const future = new Date(Date.now() + 5 * 86_400_000);
    const res = track(await svc.ingest(inbound(san, { paidAt: future })));
    const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: res.paymentId } });
    expect(row.paidAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('suspense attachment is one atomic money operation', () => {
  it('rolls back the wallet, immutable event, receipt, and ledger when payment finalization crashes, then safely retries to a different subscription', async () => {
    const { generateSan } = await import('../modules/billing/san');
    let unknown = '';
    for (;;) {
      unknown = generateSan();
      if (!(await prisma.subscription.findUnique({ where: { san: unknown } }))
        && !(await prisma.sanTombstone.findUnique({ where: { san: unknown } }))) break;
    }
    const payment = track(await svc.ingest(inbound(unknown, { amount: 1_700 })));
    expect(payment.status).toBe('received_unmatched');
    const first = await makeVendorSub();
    const retryDestination = await makeVendorSub();

    // Simulate the process dying exactly when the payment row would be made
    // final, after the credit tail has already written its event/receipt/
    // ledger/balance. The query extension runs inside the service transaction,
    // so the invariant under test is a real PostgreSQL rollback, not a mock.
    const crashingPrisma = prisma.$extends({
      query: {
        mmgAgentPayment: {
          $allOperations: async ({ operation, args, query }) => {
            const status = (args as { data?: { status?: string } }).data?.status;
            if ((operation === 'update' || operation === 'updateMany')
              && (status === 'MATCHED' || status === 'RESOLVED')) {
              throw new Error('TEST_CRASH_BEFORE_PAYMENT_FINALIZE');
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const io = { to: () => ({ emit: () => undefined }) } as never;
    const crashingBilling = new BillingService(
      crashingPrisma,
      new NotificationService(crashingPrisma, io),
      getPaymentProvider(),
    );
    const crashingService = new AgentCashService(crashingPrisma, crashingBilling);

    await expect(crashingService.attach(payment.paymentId, first.sub.id, 'admin-crash'))
      .rejects.toThrow('TEST_CRASH_BEFORE_PAYMENT_FINALIZE');

    const afterCrash = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: payment.paymentId } });
    expect(afterCrash).toMatchObject({ status: 'UNMATCHED', subscriptionId: null, resolvedBy: null, resolvedAt: null });
    expect(await prisma.billingEvent.count({ where: { subscriptionId: first.sub.id, type: 'PREPAID_TOPUP' } })).toBe(0);
    expect(await prisma.feeReceipt.count({ where: { subscriptionId: first.sub.id } })).toBe(0);
    expect(await prisma.ledgerEntry.count({
      where: { subledgerId: first.sub.id, accountCode: 'WALLET_LIABILITY', credit: { gt: 0 } },
    })).toBe(0);
    expect(await prisma.prepaidBalance.findUnique({ where: { subscriptionId: first.sub.id } })).toBeNull();

    const retry = await svc.attach(payment.paymentId, retryDestination.sub.id, 'admin-retry');
    expect(retry).toMatchObject({ status: 'accepted', subscriptionId: retryDestination.sub.id });
    const afterRetry = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: payment.paymentId } });
    expect(afterRetry).toMatchObject({
      status: 'RESOLVED',
      subscriptionId: retryDestination.sub.id,
      resolvedBy: 'admin-retry',
    });
    expect(await prisma.billingEvent.count({
      where: { subscriptionId: { in: [first.sub.id, retryDestination.sub.id] }, type: 'PREPAID_TOPUP' },
    })).toBe(1);
    expect(await prisma.feeReceipt.count({
      where: { subscriptionId: { in: [first.sub.id, retryDestination.sub.id] } },
    })).toBe(1);
    expect(await prisma.ledgerEntry.count({
      where: {
        subledgerId: { in: [first.sub.id, retryDestination.sub.id] },
        accountCode: 'WALLET_LIABILITY',
        credit: { gt: 0 },
      },
    })).toBe(1);
    expect(Number((await prisma.prepaidBalance.findUniqueOrThrow({
      where: { subscriptionId: retryDestination.sub.id },
    })).balance)).toBe(1_700);

    await expect(svc.attach(payment.paymentId, first.sub.id, 'admin-late-retry'))
      .rejects.toThrow('NOT_UNMATCHED');
    expect(await prisma.billingEvent.count({
      where: { subscriptionId: { in: [first.sub.id, retryDestination.sub.id] }, type: 'PREPAID_TOPUP' },
    })).toBe(1);
  });

  it('serializes two admins attaching the same payment to different subscriptions so exactly one destination wins', async () => {
    const { generateSan } = await import('../modules/billing/san');
    let unknown = '';
    for (;;) {
      unknown = generateSan();
      if (!(await prisma.subscription.findUnique({ where: { san: unknown } }))
        && !(await prisma.sanTombstone.findUnique({ where: { san: unknown } }))) break;
    }
    const payment = track(await svc.ingest(inbound(unknown, { amount: 1_900 })));
    const left = await makeVendorSub();
    const right = await makeVendorSub();

    const attempts = await Promise.allSettled([
      svc.attach(payment.paymentId, left.sub.id, 'admin-left'),
      svc.attach(payment.paymentId, right.sub.id, 'admin-right'),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: payment.paymentId } });
    expect(row.status).toBe('RESOLVED');
    expect([left.sub.id, right.sub.id]).toContain(row.subscriptionId);
    expect(await prisma.billingEvent.count({
      where: { subscriptionId: { in: [left.sub.id, right.sub.id] }, type: 'PREPAID_TOPUP' },
    })).toBe(1);
    expect(await prisma.feeReceipt.count({
      where: { subscriptionId: { in: [left.sub.id, right.sub.id] } },
    })).toBe(1);
    expect(await prisma.ledgerEntry.count({
      where: {
        subledgerId: { in: [left.sub.id, right.sub.id] },
        accountCode: 'WALLET_LIABILITY',
        credit: { gt: 0 },
      },
    })).toBe(1);
    const balances = await prisma.prepaidBalance.findMany({
      where: { subscriptionId: { in: [left.sub.id, right.sub.id] } },
    });
    expect(balances).toHaveLength(1);
    expect(balances[0]!.subscriptionId).toBe(row.subscriptionId);
    expect(Number(balances[0]!.balance)).toBe(1_900);
  });
});

describe('cross-channel dedupe (edge 2 / scenario G core)', () => {
  it('webhook then the same mmgTxnId via settlement file → RECONCILED, zero new money', async () => {
    const { sub, san } = await makeVendorSub();
    const txn = `MMG-${nanoid(8)}`;
    track(await svc.ingest(inbound(san, { channel: 'MMG_AGENT_WEBHOOK', mmgTxnId: txn })));
    const second = track(await svc.ingest(inbound(san, { channel: 'MMG_SETTLEMENT_FILE', mmgTxnId: txn })));
    expect(second.status).toBe('reconciled');
    const topups = await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } });
    expect(topups).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// [OWNER #62 · 14 Oct (was four weeks, 8 Oct) + OWNER RULING 8 Oct (4)] Weekly
// fees are paid one week at a time (at most the coming week is held), and
// production credits no fee by hand or by agent
// (BILLING_TOPUP_HOLD=1). Agent money is never refused or dropped once it is
// Swift's: past the cap, or under the hold, it is recorded and held for a
// person, who refunds it. An admin attaching it is refused in plain words.
// ---------------------------------------------------------------------------
describe('[owner #62] agent money: one week ahead at most, and held in production', () => {
  it('the coming week credits; a second week is held for a person (PAY_AHEAD_LIMIT), never credited', async () => {
    const { sub, san } = await makeVendorSub();
    expect(track(await svc.ingest(inbound(san))).status).toBe('accepted');
    expect(Number((await prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } })).balance)).toBe(2100);
    const second = track(await svc.ingest(inbound(san)));
    expect(second).toMatchObject({ status: 'received_unmatched', failureCode: 'PAY_AHEAD_LIMIT' });
    expect(await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } })).toBe(1);
    expect(Number((await prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } })).balance)).toBe(2100);
    // The provider transaction is not marked credited: a person can still refund it.
    const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: second.paymentId } });
    expect(row.status).toBe('UNMATCHED');
    if (row.providerPaymentId) expect((await prisma.providerPayment.findUniqueOrThrow({ where: { id: row.providerPaymentId } })).status).toBe('OPEN');

    // An admin attaching it to the full account is refused, naming what to do.
    await expect(svc.attach(second.paymentId, sub.id, 'admin-test')).rejects.toMatchObject({ statusCode: 409, code: 'PAY_AHEAD_LIMIT' });
    // [review S4] An attach is whole or nothing: the words say refund it.
    await expect(svc.attach(second.paymentId, sub.id, 'admin-test')).rejects.toThrow(/attached whole or not at all: refund it to the partner/);
    expect(await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } })).toBe(1);
  });

  it('at the cap, an admin attaching an observation another channel already credited is told it is reconciled — never asked to refund it', async () => {
    const { generateSan } = await import('../modules/billing/san');
    let unknown = '';
    for (;;) {
      unknown = generateSan();
      if (!(await prisma.subscription.findUnique({ where: { san: unknown } }))
        && !(await prisma.sanTombstone.findUnique({ where: { san: unknown } }))) break;
    }
    const { sub, san } = await makeVendorSub();
    const txn = `MMG-${nanoid(8)}`;
    // The webhook saw the payment with a mistyped Swift Number: held for a person.
    const first = track(await svc.ingest(inbound(unknown, { channel: 'MMG_AGENT_WEBHOOK', mmgTxnId: txn })));
    expect(first).toMatchObject({ status: 'received_unmatched', failureCode: 'SAN_UNKNOWN' });
    // MMG's statement credits that same transaction: the coming week, the cap [owner #62].
    expect(track(await svc.ingest(inbound(san, { channel: 'MMG_SETTLEMENT_FILE', mmgTxnId: txn }))).status).toBe('accepted');
    // Attaching the first observation moves no money and is not a refund case.
    expect(await svc.attach(first.paymentId, sub.id, 'admin-test')).toMatchObject({ status: 'reconciled' });
    expect(await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } })).toBe(1);
  });

  it('under the hold, an agent payment is recorded and held for a person, and an admin cannot attach it', async () => {
    const { sub, san } = await makeVendorSub();
    process.env['BILLING_TOPUP_HOLD'] = '1';
    try {
      const held = track(await svc.ingest(inbound(san)));
      expect(held).toMatchObject({ status: 'received_unmatched', failureCode: 'TOPUP_ON_HOLD' });
      await expect(svc.attach(held.paymentId, sub.id, 'admin-test')).rejects.toMatchObject({ statusCode: 503, code: 'TOPUP_ON_HOLD' });
    } finally {
      delete process.env['BILLING_TOPUP_HOLD'];
    }
    expect(await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// [REVIEW S3-2 · owner 11 Oct] Under the hold every agent payment is held for a
// refund, and one real MMG payment can arrive as several observations (the
// webhook, MMG's statement). A refund is made ONCE per MMG transaction: the
// refund closes the transaction, its other held observations are reconciled
// (nothing to refund twice), a later observation never credits it, and a
// transaction already credited is never also refunded.
// ---------------------------------------------------------------------------
describe('[review S3-2] one refund per MMG payment', () => {
  async function unknownSan() {
    const { generateSan } = await import('../modules/billing/san');
    for (;;) {
      const s = generateSan();
      if (!(await prisma.subscription.findUnique({ where: { san: s } })) && !(await prisma.sanTombstone.findUnique({ where: { san: s } }))) return s;
    }
  }
  const observationsOf = async (paymentId: string) => {
    const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: paymentId } });
    return prisma.mmgAgentPayment.findMany({ where: { providerPaymentId: row.providerPaymentId! }, select: { id: true, status: true } });
  };

  it('two observations of one held payment: one refund, the other reconciled, a second refund refused', async () => {
    const { san } = await makeVendorSub();
    const txn = `MMG-${nanoid(8)}`;
    process.env['BILLING_TOPUP_HOLD'] = '1';
    try {
      const a = track(await svc.ingest(inbound(san, { channel: 'MMG_AGENT_WEBHOOK', mmgTxnId: txn })));
      const b = track(await svc.ingest(inbound(san, { channel: 'MMG_SETTLEMENT_FILE', mmgTxnId: txn })));
      expect([a.status, b.status]).toEqual(['received_unmatched', 'received_unmatched']);
      expect(await svc.flagRefund(a.paymentId, 'admin-test', 'returned at the agent')).toMatchObject({ status: 'refund_flagged' });
      const rows = await observationsOf(a.paymentId);
      expect(rows.filter((r) => r.status === 'REFUND_FLAGGED').map((r) => r.id)).toEqual([a.paymentId]);
      expect(rows.find((r) => r.id === b.paymentId)?.status).toBe('RECONCILED');
      await expect(svc.flagRefund(b.paymentId, 'admin-test', 'again')).rejects.toMatchObject({ code: 'NOT_UNMATCHED' });
      const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: a.paymentId } });
      expect((await prisma.providerPayment.findUniqueOrThrow({ where: { id: row.providerPaymentId! } })).status).toBe('REFUNDED');
    } finally {
      delete process.env['BILLING_TOPUP_HOLD'];
    }
  });

  it('a refunded payment observed again later is never credited', async () => {
    const { sub, san } = await makeVendorSub();
    const txn = `MMG-${nanoid(8)}`;
    const a = track(await svc.ingest(inbound(await unknownSan(), { channel: 'MMG_AGENT_WEBHOOK', mmgTxnId: txn })));
    expect(a).toMatchObject({ status: 'received_unmatched', failureCode: 'SAN_UNKNOWN' });
    await svc.flagRefund(a.paymentId, 'admin-test', 'returned at the agent');
    const late = track(await svc.ingest(inbound(san, { channel: 'MMG_SETTLEMENT_FILE', mmgTxnId: txn })));
    expect(late.status).toBe('reconciled');
    expect(await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } })).toBe(0);
  });

  it('a payment another channel already credited is never also refunded', async () => {
    const { sub, san } = await makeVendorSub();
    const txn = `MMG-${nanoid(8)}`;
    const a = track(await svc.ingest(inbound(await unknownSan(), { channel: 'MMG_AGENT_WEBHOOK', mmgTxnId: txn })));
    expect(track(await svc.ingest(inbound(san, { channel: 'MMG_SETTLEMENT_FILE', mmgTxnId: txn }))).status).toBe('accepted');
    await expect(svc.flagRefund(a.paymentId, 'admin-test', 'returned at the agent')).rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_CREDITED' });
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: a.paymentId } })).status).toBe('UNMATCHED');
    expect(await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// [#1609 review S3-1, S3-2, S4] A refund and an observation of the same MMG
// payment still being judged (RECEIVED): the refund settles it under the same
// locks, and one linked after the refund is settled at its own verdict, so it
// never reaches the refund queue a second time. A payment already refunded is
// answered 409 in words that say do not refund. An observation that disagrees
// with its MMG transaction (PROVIDER_ID_CONFLICT) is for finance review: it is
// never closed in bulk and never closes the transaction itself.
// ---------------------------------------------------------------------------
describe('[#1609 review] refunds vs observations still being judged, and conflict rows', () => {
  async function unknownSan() {
    const { generateSan } = await import('../modules/billing/san');
    for (;;) {
      const s = generateSan();
      if (!(await prisma.subscription.findUnique({ where: { san: s } })) && !(await prisma.sanTombstone.findUnique({ where: { san: s } }))) return s;
    }
  }
  const statusOf = async (id: string) => {
    const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id } });
    return { status: row.status, failureCode: row.failureCode, providerPaymentId: row.providerPaymentId };
  };
  const identityStatus = async (paymentId: string) => {
    const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: paymentId } });
    return (await prisma.providerPayment.findUniqueOrThrow({ where: { id: row.providerPaymentId! } })).status;
  };
  /** An observation saved and not yet judged: its delivery is still on its way to a verdict. */
  async function savedNotJudged(san: string, txn: string, over: Record<string, unknown> = {}) {
    const row = await prisma.mmgAgentPayment.create({
      data: {
        channel: 'MMG_SETTLEMENT_FILE', externalId: `${txn}-file-${nanoid(6)}`, mmgTxnId: txn, sanRaw: san,
        amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'RECEIVED', raw: { test: true },
        ...over,
      } as never,
    });
    paymentIds.push(row.id);
    return row;
  }
  const door = () => {
    let reached!: () => void;
    let open!: () => void;
    const isReached = new Promise<void>((r) => { reached = r; });
    const opened = new Promise<void>((r) => { open = r; });
    return { reached, isReached, open, opened };
  };
  const within = async <T>(p: Promise<T>, ms = 15_000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms); })]);
    } finally {
      clearTimeout(timer);
    }
  };
  /** Hold one row lock (`lockSql`) until `waiters` backends queue behind it, directly or through each other. */
  async function holding<T>(lockSql: (tx: Prisma.TransactionClient) => Promise<unknown>, waiters: number, start: () => T, meanwhile?: () => Promise<void>): Promise<{ started: T }> {
    let started!: T;
    await prisma.$transaction(async (tx) => {
      await lockSql(tx);
      const pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      started = start();
      const deadline = Date.now() + 15_000;
      for (;;) {
        const blocked = (await prisma.$queryRaw<Array<{ blocked: number }>>`
          WITH RECURSIVE waiting(pid, path) AS (
            SELECT a.pid, ARRAY[a.pid] FROM pg_stat_activity a WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
            UNION ALL
            SELECT a.pid, w.path || a.pid FROM waiting w JOIN pg_stat_activity a ON w.pid = ANY(pg_blocking_pids(a.pid))
            WHERE NOT a.pid = ANY(w.path)
          ) SELECT count(DISTINCT pid)::int AS blocked FROM waiting
        `)[0]!.blocked;
        if (blocked >= waiters) break;
        if (Date.now() > deadline) throw new Error(`only ${blocked} of ${waiters} reached the lock`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await meanwhile?.();
    }, { timeout: 30_000, maxWait: 5_000 });
    return { started }; // wrapped: a returned promise would be awaited here
  }

  it('S3-1: an observation of the same payment still being judged when the refund lands is closed by the refund, and never reaches the refund queue', async () => {
    const { san } = await makeVendorSub();
    const txn = `MMG-${nanoid(8)}`;
    const proto = AgentCashService.prototype as unknown as { suspense: (paymentId: string, failureCode: string) => Promise<IngestResult> };
    const realSuspense = proto.suspense;
    const stall = door();
    let armed = false;
    const stalling = vi.spyOn(proto, 'suspense').mockImplementation(async function (this: unknown, ...args: [string, string]) {
      if (armed) { armed = false; stall.reached(); await stall.opened; }
      return realSuspense.apply(this, args);
    });
    process.env['BILLING_TOPUP_HOLD'] = '1';
    try {
      const a = track(await svc.ingest(inbound(san, { channel: 'MMG_AGENT_WEBHOOK', mmgTxnId: txn })));
      expect(a).toMatchObject({ status: 'received_unmatched', failureCode: 'TOPUP_ON_HOLD' });
      // MMG's statement brings the same payment; its delivery is judged and about to be held.
      armed = true;
      const second = inbound(san, { channel: 'MMG_SETTLEMENT_FILE', mmgTxnId: txn });
      const live = svc.ingest(second);
      live.catch(() => undefined); // awaited below
      await within(stall.isReached);
      const b = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { channel_externalId: { channel: 'MMG_SETTLEMENT_FILE', externalId: second.externalId } } });
      paymentIds.push(b.id);
      expect((await statusOf(b.id)).status).toBe('RECEIVED');
      // The refund of the webhook's record lands while it is still being judged.
      expect(await svc.flagRefund(a.paymentId, 'admin-test', 'returned at the agent')).toMatchObject({ status: 'refund_flagged' });
      expect(await statusOf(b.id)).toMatchObject({ status: 'RECONCILED', providerPaymentId: (await statusOf(a.paymentId)).providerPaymentId });
      // Its own verdict then writes nothing over the refund (a lost race, as for any finisher).
      stall.open();
      await expect(within(live)).rejects.toThrow('NOT_RECEIVED');
      expect((await statusOf(b.id)).status).toBe('RECONCILED');
      expect((await svc.unmatchedQueue(500)).map((r) => r.id)).not.toContain(b.id);
      await expect(svc.flagRefund(b.id, 'admin-test', 'again')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/do not refund/i) });
    } finally {
      stall.open();
      stalling.mockRestore();
      delete process.env['BILLING_TOPUP_HOLD'];
    }
  });

  it('S3-1: an observation linked to the payment only after the refund committed is settled at its own verdict, never held for a second refund', async () => {
    const { san } = await makeVendorSub();
    const txn = `MMG-${nanoid(8)}`;
    process.env['BILLING_TOPUP_HOLD'] = '1';
    try {
      const a = track(await svc.ingest(inbound(san, { channel: 'MMG_AGENT_WEBHOOK', mmgTxnId: txn })));
      const b = await savedNotJudged(san, txn);
      // b's verdict reads the payment (still OPEN) and then waits to link b to it; the refund lands meanwhile.
      const { started: judged } = await holding(
        (tx) => tx.$queryRaw`SELECT "id" FROM "mmg_agent_payments" WHERE "id" = ${b.id} FOR UPDATE`,
        1,
        () => { const p = svc.resumeReceived(b.id); p.catch(() => undefined); return p; },
        async () => {
          expect(await svc.flagRefund(a.paymentId, 'admin-test', 'returned at the agent')).toMatchObject({ status: 'refund_flagged' });
          expect(await statusOf(b.id)).toMatchObject({ status: 'RECEIVED', providerPaymentId: null });
        },
      );
      expect(await within(judged)).toMatchObject({ status: 'reconciled', originalPaymentId: a.paymentId });
      expect(await statusOf(b.id)).toMatchObject({ status: 'RECONCILED', providerPaymentId: (await statusOf(a.paymentId)).providerPaymentId });
      expect((await svc.unmatchedQueue(500)).map((r) => r.id)).not.toContain(b.id);
    } finally {
      delete process.env['BILLING_TOPUP_HOLD'];
    }
  });

  it('S3-1 (no hold): an observation reaching its credit after the refund landed is reconciled, not refused with an error', async () => {
    const { sub, san } = await makeVendorSub();
    const txn = `MMG-${nanoid(8)}`;
    const a = track(await svc.ingest(inbound(await unknownSan(), { channel: 'MMG_AGENT_WEBHOOK', mmgTxnId: txn })));
    expect(a).toMatchObject({ status: 'received_unmatched', failureCode: 'SAN_UNKNOWN' });
    const b = await savedNotJudged(san, txn);
    const { started: judged } = await holding(
      (tx) => tx.$queryRaw`SELECT "id" FROM "mmg_agent_payments" WHERE "id" = ${b.id} FOR UPDATE`,
      1,
      () => { const p = svc.resumeReceived(b.id); p.catch(() => undefined); return p; },
      async () => { await svc.flagRefund(a.paymentId, 'admin-test', 'returned at the agent'); },
    );
    expect(await within(judged)).toMatchObject({ status: 'reconciled', originalPaymentId: a.paymentId });
    expect((await statusOf(b.id)).status).toBe('RECONCILED');
    expect(await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } })).toBe(0);
  });

  it('S3-1: flagging a payment already refunded answers 409 "do not refund" and closes the record as a duplicate (never "Recorded")', async () => {
    const { san } = await makeVendorSub();
    const txn = `MMG-${nanoid(8)}`;
    process.env['BILLING_TOPUP_HOLD'] = '1';
    try {
      const a = track(await svc.ingest(inbound(san, { channel: 'MMG_AGENT_WEBHOOK', mmgTxnId: txn })));
      await svc.flagRefund(a.paymentId, 'admin-test', 'returned at the agent');
      const providerPaymentId = (await statusOf(a.paymentId)).providerPaymentId;
      // A record of the same payment held after the refund (linked later, or history).
      const b = await savedNotJudged(san, txn, { status: 'UNMATCHED', failureCode: 'TOPUP_ON_HOLD', providerPaymentId });
      await expect(svc.flagRefund(b.id, 'admin-test', 'returned at the agent'))
        .rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_REFUNDED', message: expect.stringMatching(/^Do not refund/) });
      expect((await statusOf(b.id)).status).toBe('RECONCILED');
      expect((await prisma.mmgAgentPayment.findMany({ where: { providerPaymentId, status: 'REFUND_FLAGGED' } })).map((r) => r.id)).toEqual([a.paymentId]);
    } finally {
      delete process.env['BILLING_TOPUP_HOLD'];
    }
  });

  it('S3-1: a held record never linked to its MMG payment is linked before it is flagged, so the same payment is never refunded twice', async () => {
    const { san } = await makeVendorSub();
    const txn = `MMG-${nanoid(8)}`;
    process.env['BILLING_TOPUP_HOLD'] = '1';
    try {
      // Saved, never linked, and given up on by the repair pass: in the queue as UNFINISHED.
      const a = await savedNotJudged(san, txn, { channel: 'MMG_AGENT_WEBHOOK', status: 'UNMATCHED', failureCode: 'UNFINISHED' });
      expect(await svc.flagRefund(a.id, 'admin-test', 'returned at the agent')).toMatchObject({ status: 'refund_flagged' });
      expect((await statusOf(a.id)).providerPaymentId).not.toBeNull();
      expect(await identityStatus(a.id)).toBe('REFUNDED');
      // MMG's statement brings the same payment: reconciled against the refund, not held for another.
      const late = track(await svc.ingest(inbound(san, { channel: 'MMG_SETTLEMENT_FILE', mmgTxnId: txn })));
      expect(late).toMatchObject({ status: 'reconciled', originalPaymentId: a.id });
    } finally {
      delete process.env['BILLING_TOPUP_HOLD'];
    }
  });

  it('S3-2: a refund never closes an observation that disagrees with the MMG payment (a conflict waits for finance review)', async () => {
    const { san } = await makeVendorSub();
    const txn = `MMG-${nanoid(8)}`;
    process.env['BILLING_TOPUP_HOLD'] = '1';
    try {
      const a = track(await svc.ingest(inbound(san, { channel: 'MMG_AGENT_WEBHOOK', mmgTxnId: txn })));
      const c = track(await svc.ingest(inbound(san, { channel: 'MMG_SETTLEMENT_FILE', mmgTxnId: txn, amount: 2500 })));
      expect(c).toMatchObject({ status: 'received_unmatched', failureCode: 'PROVIDER_ID_CONFLICT' });
      expect((await statusOf(c.paymentId)).providerPaymentId).toBe((await statusOf(a.paymentId)).providerPaymentId);
      expect(await svc.flagRefund(a.paymentId, 'admin-test', 'returned at the agent')).toMatchObject({ status: 'refund_flagged' });
      expect(await statusOf(c.paymentId)).toMatchObject({ status: 'UNMATCHED', failureCode: 'PROVIDER_ID_CONFLICT' });
      // The queue tells the operator up front that a person in finance decides it.
      expect((await svc.unmatchedQueue(500)).find((r) => r.id === c.paymentId)?.diagnosis).toMatch(/finance review/);
    } finally {
      delete process.env['BILLING_TOPUP_HOLD'];
    }
  });

  it('S3-2: a conflict observation cannot be flagged for refund: 409, nothing closed, every record stays for finance review', async () => {
    const { san } = await makeVendorSub();
    const txn = `MMG-${nanoid(8)}`;
    process.env['BILLING_TOPUP_HOLD'] = '1';
    try {
      const a = track(await svc.ingest(inbound(san, { channel: 'MMG_AGENT_WEBHOOK', mmgTxnId: txn })));
      const c = track(await svc.ingest(inbound(san, { channel: 'MMG_SETTLEMENT_FILE', mmgTxnId: txn, amount: 2500 })));
      await expect(svc.flagRefund(c.paymentId, 'admin-test', 'returned at the agent'))
        .rejects.toMatchObject({ statusCode: 409, code: 'PROVIDER_ID_CONFLICT', message: expect.stringMatching(/finance review/) });
      expect(await identityStatus(a.paymentId)).toBe('OPEN');
      expect(await statusOf(a.paymentId)).toMatchObject({ status: 'UNMATCHED', failureCode: 'TOPUP_ON_HOLD' });
      expect(await statusOf(c.paymentId)).toMatchObject({ status: 'UNMATCHED', failureCode: 'PROVIDER_ID_CONFLICT' });
    } finally {
      delete process.env['BILLING_TOPUP_HOLD'];
    }
  });

  it('S4: two refund flags on two records of one payment at once: one refund, the other a clean 409 (no deadlock)', async () => {
    const { san } = await makeVendorSub();
    const txn = `MMG-${nanoid(8)}`;
    process.env['BILLING_TOPUP_HOLD'] = '1';
    try {
      const a = track(await svc.ingest(inbound(san, { channel: 'MMG_AGENT_WEBHOOK', mmgTxnId: txn })));
      const b = track(await svc.ingest(inbound(san, { channel: 'MMG_SETTLEMENT_FILE', mmgTxnId: txn })));
      const providerPaymentId = (await statusOf(a.paymentId)).providerPaymentId!;
      const { started: flags } = await holding(
        (tx) => tx.$queryRaw`SELECT "id" FROM "provider_payments" WHERE "id" = ${providerPaymentId} FOR UPDATE`,
        2,
        () => [a.paymentId, b.paymentId].map((id) => {
          const p = svc.flagRefund(id, 'admin-test', 'returned at the agent');
          p.catch(() => undefined); // settled below
          return p;
        }),
      );
      const settled = await within(Promise.allSettled(flags));
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      const refused = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect(refused[0]!.reason).toMatchObject({ statusCode: 409 });
      expect(await prisma.mmgAgentPayment.count({ where: { providerPaymentId, status: 'REFUND_FLAGGED' } })).toBe(1);
    } finally {
      delete process.env['BILLING_TOPUP_HOLD'];
    }
  });
});

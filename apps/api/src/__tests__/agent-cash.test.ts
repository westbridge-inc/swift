import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { AgentCashService, type InboundFeePayment } from '../modules/billing/agent-cash.service';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { ensureSan } from '../modules/billing/san.service';

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
const phoneBase = 592_006_000_000 + Math.floor(Math.random() * 8_000_000);

let svc: AgentCashService;
let billing: BillingService;

async function makeVendorSub(over: Record<string, unknown> = {}) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Cash', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Cash Vendor ${seq}`, slug: `cash-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 700_000 + seq}`,
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
  await prisma.mmgAgentPayment.deleteMany({ where: { id: { in: paymentIds } } });
  await prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.sanTombstone.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } });
  await prisma.identityClusterMember.deleteMany({ where: { accountId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
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
    track(await svc.ingest(inbound(san)));
    track(await svc.ingest(inbound(san)));
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

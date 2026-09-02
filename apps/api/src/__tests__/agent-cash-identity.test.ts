import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { AgentCashService, PROVIDER, providerTxnKey, scanDuplicateCredits, type InboundFeePayment } from '../modules/billing/agent-cash.service';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { ensureSan } from '../modules/billing/san.service';
import { agentCashDuplicateCreditsCounter, agentCashDuplicateCreditsGauge, agentCashProviderIdConflictsCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [M-18 · S0] One real-world provider transaction creates at most ONE wallet
// credit, whatever channel observed it, in whatever order, at whatever time.
//
// Before: cross-channel dedupe looked for an already-MATCHED sibling by
// mmgTxnId. Two channels arriving together both saw none and both credited;
// an unmatched first observation (a mistyped account number) never blocked
// the second channel's credit, and its later attach by an admin credited
// AGAIN. Now every observation points at one identity with one lifecycle,
// and the credit is a single compare-and-set on it.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
let app: FastifyInstance;
let svc: AgentCashService;
const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
const externalIds: string[] = [];
const txnKeys: string[] = [];
let seq = 0;
const phoneBase = 592_009_000_000 + Math.floor(Math.random() * 8_000_000);

async function makeVendorSub() {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Ident', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Identity Kitchen ${seq}`, slug: `ident-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 700_000 + seq}`,
      addressLine1: '18 Identity St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH',
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000), nextBillingDate: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  subIds.push(sub.id);
  const san = await ensureSan(prisma, sub.id);
  return { sub, san };
}

function txn(): string {
  const id = `ID-${nanoid(8)}`;
  externalIds.push(id, `MANUAL:${id}`);
  txnKeys.push(providerTxnKey({ mmgTxnId: id, externalId: id, channel: 'MMG_AGENT_WEBHOOK' }));
  return id;
}
const webhook = (id: string, san: string, amount = 2100): InboundFeePayment => ({ externalId: id, channel: 'MMG_AGENT_WEBHOOK', mmgTxnId: id, sanRaw: san, amount, currencyCode: 'GYD', paidAt: new Date(), raw: { via: 'webhook' } });
const file = (id: string, san: string, amount = 2100): InboundFeePayment => ({ externalId: id, channel: 'MMG_SETTLEMENT_FILE', mmgTxnId: id, sanRaw: san, amount, currencyCode: 'GYD', paidAt: new Date(), raw: { via: 'file' } });
const manual = (id: string, san: string, amount = 2100): InboundFeePayment => ({ externalId: `MANUAL:${id}`, channel: 'MANUAL_ADMIN', sanRaw: san, amount, currencyCode: 'GYD', paidAt: new Date(), raw: { via: 'manual' }, recordedBy: 'admin_1' });

/** The money facts for one subscription: credits, receipts, balanced ledger postings, balance. */
async function money(subscriptionId: string) {
  const topups = await prisma.billingEvent.findMany({ where: { subscriptionId, type: 'PREPAID_TOPUP' }, select: { id: true, idempotencyKey: true } });
  return {
    credits: topups.length,
    receipts: await prisma.feeReceipt.count({ where: { subscriptionId } }),
    postings: await prisma.ledgerTransaction.count({ where: { idempotencyKey: { in: topups.map((t) => `ledger:${t.idempotencyKey}`) } } }),
    balance: Number((await prisma.prepaidBalance.findUnique({ where: { subscriptionId } }))?.balance ?? 0),
  };
}
const identityOf = (id: string) => prisma.providerPayment.findUniqueOrThrow({ where: { provider_providerTxnId: { provider: PROVIDER, providerTxnId: providerTxnKey({ mmgTxnId: id, externalId: id, channel: 'MMG_AGENT_WEBHOOK' }) } } });
const counter = async (c: { get: () => Promise<{ values: Array<{ labels: Record<string, string | number>; value: number }> }> }, labels: Record<string, string>) =>
  (await c.get()).values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))?.value ?? 0;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  await prisma.$connect();
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  const notifications = new NotificationService(app.prisma, app.io);
  svc = new AgentCashService(app.prisma, new BillingService(app.prisma, notifications, getPaymentProvider()), notifications);
});

afterAll(async () => {
  await prisma.mmgAgentPayment.deleteMany({ where: { externalId: { in: externalIds } } });
  await prisma.providerPayment.deleteMany({ where: { providerTxnId: { in: txnKeys } } });
  await prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } });
  await prisma.identityClusterMember.deleteMany({ where: { accountId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
  await prisma.$disconnect();
});

describe('[M-18] one provider transaction, one credit', () => {
  it('the identity key is the provider transaction id, normalized — a manual receipt reference is the same id', () => {
    expect(providerTxnKey({ mmgTxnId: ' xc-abc ', externalId: 'ignored', channel: 'MMG_AGENT_WEBHOOK' })).toBe('XC-ABC');
    expect(providerTxnKey({ mmgTxnId: null, externalId: 'MANUAL:xc-abc', channel: 'MANUAL_ADMIN' })).toBe('XC-ABC');
  });

  it('the race the register names: webhook and settlement file observe one transaction at the same moment — one credit, one receipt, one posting', async () => {
    const { sub, san } = await makeVendorSub();
    const id = txn();
    const [a, b] = await Promise.all([svc.ingest(webhook(id, san)), svc.ingest(file(id, san))]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['accepted', 'reconciled']);
    expect(await money(sub.id)).toEqual({ credits: 1, receipts: 1, postings: 1, balance: 2100 });
    const identity = await identityOf(id);
    const winner = a.status === 'accepted' ? a.paymentId : b.paymentId;
    const loser = a.status === 'accepted' ? b.paymentId : a.paymentId;
    expect({ status: identity.status, credited: identity.creditedPaymentId, sub: identity.subscriptionId }).toEqual({ status: 'CREDITED', credited: winner, sub: sub.id });
    const loserRow = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: loser } });
    expect(loserRow.status).toBe('RECONCILED');
    expect(loserRow.note).toContain(`duplicate of ${winner}`);
    expect(loserRow.providerPaymentId).toBe(identity.id);
  });

  it('unmatched first, matched second, then the original attached — the attach is answered reconciled and moves nothing', async () => {
    const { sub, san } = await makeVendorSub();
    const id = txn();
    const before = await counter(agentCashDuplicateCreditsCounter, { channel: 'MMG_AGENT_WEBHOOK', stage: 'credit' });
    // A mistyped account number at the counter: the webhook is money in suspense.
    const first = await svc.ingest(webhook(id, '1234567890'));
    expect(first.status).toBe('received_unmatched');
    // The settlement file carries the right account: it credits.
    const second = await svc.ingest(file(id, san));
    expect(second.status).toBe('accepted');
    expect(await money(sub.id)).toEqual({ credits: 1, receipts: 1, postings: 1, balance: 2100 });
    // The admin resolves the suspensed original against the same account: no second credit.
    const attached = await svc.attach(first.paymentId, sub.id, 'admin_1');
    expect(attached).toEqual({ status: 'reconciled', paymentId: first.paymentId, originalPaymentId: second.paymentId });
    expect(await money(sub.id)).toEqual({ credits: 1, receipts: 1, postings: 1, balance: 2100 });
    const original = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: first.paymentId } });
    expect(original.status).toBe('RECONCILED');
    expect(await counter(agentCashDuplicateCreditsCounter, { channel: 'MMG_AGENT_WEBHOOK', stage: 'credit' })).toBe(before + 1);
    // The identity names the credit that stands.
    expect((await identityOf(id)).creditedPaymentId).toBe(second.paymentId);
  });

  it('the same transaction id with a different amount is a conflict: suspensed, counted, never credited', async () => {
    const { sub, san } = await makeVendorSub();
    const id = txn();
    const before = await counter(agentCashProviderIdConflictsCounter, { channel: 'MMG_SETTLEMENT_FILE' });
    expect((await svc.ingest(webhook(id, san, 2100))).status).toBe('accepted');
    const clash = await svc.ingest(file(id, san, 2500));
    expect(clash).toMatchObject({ status: 'received_unmatched', failureCode: 'PROVIDER_ID_CONFLICT' });
    expect(await money(sub.id)).toEqual({ credits: 1, receipts: 1, postings: 1, balance: 2100 });
    expect(await counter(agentCashProviderIdConflictsCounter, { channel: 'MMG_SETTLEMENT_FILE' })).toBe(before + 1);
    // The conflicting observation is linked to the identity so a person sees both.
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: clash.paymentId } })).providerPaymentId).toBe((await identityOf(id)).id);
  });

  it('a manual entry for a transaction the webhook already credited is reconciled, not credited again', async () => {
    const { sub, san } = await makeVendorSub();
    const id = txn();
    expect((await svc.ingest(webhook(id, san))).status).toBe('accepted');
    const again = await svc.ingest(manual(id, san));
    expect(again.status).toBe('reconciled');
    expect(await money(sub.id)).toEqual({ credits: 1, receipts: 1, postings: 1, balance: 2100 });
  });

  it('the credit key is the transaction’s, so even a bypassed compare-and-set could not post a second top-up', async () => {
    const { sub, san } = await makeVendorSub();
    const id = txn();
    const first = await svc.ingest(webhook(id, san));
    expect(first.status).toBe('accepted');
    const identity = await identityOf(id);
    const event = await prisma.billingEvent.findFirstOrThrow({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } });
    expect(event.idempotencyKey).toBe(`agent-cash:pp:${identity.id}`);
  });
});

describe('[M-18 · operations] the historical double credits', () => {
  it('a transaction that holds two credited observations is found, gauged and reported — never reversed here', async () => {
    const { sub, san } = await makeVendorSub();
    const id = txn();
    const first = await svc.ingest(webhook(id, san));
    expect(first.status).toBe('accepted');
    // A legacy double: before the identity existed, the file channel credited too.
    const legacy = await prisma.mmgAgentPayment.create({
      data: { channel: 'MMG_SETTLEMENT_FILE', externalId: id, mmgTxnId: id, sanRaw: san, amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'MATCHED', subscriptionId: sub.id, raw: {}, providerPaymentId: (await identityOf(id)).id },
    });
    const found = await scanDuplicateCredits(prisma);
    const mine = found.find((f) => f.providerTxnId === providerTxnKey({ mmgTxnId: id, externalId: id, channel: 'MMG_AGENT_WEBHOOK' }));
    expect(mine).toMatchObject({ observations: 2, amount: 2100 });
    expect(mine?.subscriptionIds).toContain(sub.id);
    expect((await agentCashDuplicateCreditsGauge.get()).values[0]?.value).toBeGreaterThanOrEqual(1);
    // Nothing was reversed: both observations stand until a person reconciles them.
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe('MATCHED');
  });
});

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import type { OnAudit } from '../lib/audit-writer';
import { agentCashRoutes } from '../modules/billing/agent-cash.routes';
import {
  AgentCashService, STRANDED_AFTER_MS, STRANDED_GIVE_UP_AFTER_MS, STRANDED_RETRY_BACKOFF_MS,
  type InboundFeePayment, type IngestResult,
} from '../modules/billing/agent-cash.service';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { ensureSan } from '../modules/billing/san.service';
import { generateSan } from '../modules/billing/san';

// ---------------------------------------------------------------------------
// [MMG-RECV] Agent-cash payments stranded RECEIVED.
//
// An observation is saved RECEIVED first and judged after. When the delivery
// that saved it died in between, it stayed RECEIVED for ever: every
// redelivery answered `duplicate` (the webhook told MMG to stop; a re-keyed
// receipt read as done) and nothing looked at RECEIVED again. The money was
// on disk and nobody credited it. Now a redelivery finishes it, and so does
// the repair pass of poll-mmg-billing: fenced (every verdict a
// compare-and-set on RECEIVED), on the database clock, and fair.
// ---------------------------------------------------------------------------

const SECRET = 'test-agent-cash-secret-0123456789';
const WEBHOOK = '/api/v1/billing/mmg/agent-notification';
const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });

let app: FastifyInstance;
let svc: AgentCashService;
const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
const externalIds: string[] = [];
const providerTxnIds: string[] = [];
let seq = 0;
const phoneBase = 592_011_000_000 + Math.floor(Math.random() * 8_000_000);

async function makeVendorSub(opts: { san?: boolean } = {}) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Strand', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Stranded Kitchen ${seq}`, slug: `strand-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 700_000 + seq}`,
      addressLine1: '12 Receipt St', city: 'Georgetown', region: 'Demerara-Mahaica',
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
  const san = opts.san === false ? '' : await ensureSan(prisma, sub.id);
  return { sub, san };
}

/** [AX363-F2] An account of ANOTHER tenant, retained and inactive: the data a
 *  single-active-tenant deployment may still hold. */
const tenantIds: string[] = [];
async function makeForeignVendorSub() {
  seq += 1;
  const tenant = await prisma.tenant.create({ data: { name: `Retained operator ${seq}`, slug: `retained-${nanoid(8).toLowerCase()}`, isActive: false } });
  tenantIds.push(tenant.id);
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, phone: `+${phoneBase + seq}`, firstName: 'Foreign', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      tenantId: tenant.id, ownerId: owner.id, name: `Foreign Kitchen ${seq}`, slug: `foreign-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 700_000 + seq}`,
      addressLine1: '1 Elsewhere St', city: 'Georgetown', region: 'Demerara-Mahaica',
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
  return { sub, san: await ensureSan(prisma, sub.id), tenant };
}

const txnId = () => { const id = `RECV-${nanoid(10)}`; externalIds.push(id); providerTxnIds.push(id.toUpperCase()); return id; };
const receiptNo = () => { const r = `RCPT-${nanoid(10)}`; externalIds.push(`MANUAL:${r}`); providerTxnIds.push(r.toUpperCase()); return r; };

const webhookPayment = (txn: string, san: string, amount = 2100): InboundFeePayment => ({
  externalId: txn, channel: 'MMG_AGENT_WEBHOOK', mmgTxnId: txn, sanRaw: san, amount, currencyCode: 'GYD', paidAt: new Date(), raw: { transactionId: txn },
});
const manualPayment = (receipt: string, san: string, adminId: string, amount = 2100): InboundFeePayment => ({
  externalId: `MANUAL:${receipt}`, channel: 'MANUAL_ADMIN', sanRaw: san, amount, currencyCode: 'GYD', paidAt: new Date(),
  raw: { enteredBy: adminId, receiptNumber: receipt, verifiedInPortal: true }, recordedBy: adminId,
});
/** What the admin route hands the credit: its audit row, named for the admin. */
const adminAudit = (adminId: string): OnAudit => async (tx, facts) => {
  await tx.auditLog.create({ data: { userId: adminId, action: 'TEST_AGENT_PAYMENT_RECORDED', entity: 'MmgAgentPayment', entityId: String(facts['paymentId']), changes: { ...facts } } });
};

function signed(body: unknown) {
  const raw = JSON.stringify(body);
  const ts = Date.now();
  const sig = createHmac('sha256', SECRET).update(`${ts}.`).update(Buffer.from(raw)).digest('hex');
  return { method: 'POST' as const, payload: raw, headers: { 'content-type': 'application/json', 'x-swift-timestamp': String(ts), 'x-swift-signature': sig } };
}

const realCredit = AgentCashService.prototype.credit;
/** The delivery dies after saving the payment: its credit throws once. */
async function strandedBy(payment: InboundFeePayment, onAudit?: OnAudit) {
  const dying = vi.spyOn(AgentCashService.prototype, 'credit').mockImplementationOnce(async () => { throw new Error('CONNECTION_LOST'); });
  try {
    await expect(svc.ingest(payment, onAudit)).rejects.toThrow('CONNECTION_LOST');
  } finally {
    dying.mockRestore();
  }
  const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { channel_externalId: { channel: payment.channel, externalId: payment.externalId } } });
  expect(row.status).toBe('RECEIVED');
  return row;
}
const strandedWebhook = async (san: string, amount = 2100) => {
  const txn = txnId();
  return { ...(await strandedBy(webhookPayment(txn, san, amount))), txn };
};

/** [AX363-F1] The delivery dies BEFORE its provider identity is linked: every
 *  identity lookup fails while `down` says so. */
type IdentityFor = (row: unknown, channel: string) => Promise<unknown>;
const identityProto = AgentCashService.prototype as unknown as { identityFor: IdentityFor };
const realIdentityFor = identityProto.identityFor;
function identityOutage() {
  const state = { down: true };
  const spy = vi.spyOn(identityProto, 'identityFor').mockImplementation(async function (this: unknown, row: unknown, channel: string) {
    if (state.down) throw new Error('CONNECTION_LOST');
    return realIdentityFor.call(this, row, channel);
  });
  return { end: () => { state.down = false; spy.mockRestore(); } };
}
/** A payment whose delivery died before its identity was linked, and that the
 *  repair pass then gave up on: UNMATCHED / UNFINISHED, with no identity. */
async function givenUpWithoutIdentity(san: string) {
  const txn = txnId();
  const outage = identityOutage();
  let id: string;
  try {
    await expect(svc.ingest(webhookPayment(txn, san))).rejects.toThrow('CONNECTION_LOST');
    id = (await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { channel_externalId: { channel: 'MMG_AGENT_WEBHOOK', externalId: txn } } })).id;
    await savedAgo(id, STRANDED_GIVE_UP_AFTER_MS + 60_000);
    expect(await svc.finishStrandedPayments({ paymentIds: [id] })).toEqual({ finished: [], failed: [id], suspensed: [] });
    await lastTriedAgo([id], STRANDED_RETRY_BACKOFF_MS + 60_000);
    expect(await svc.finishStrandedPayments({ paymentIds: [id] })).toEqual({ finished: [], failed: [], suspensed: [id] });
  } finally {
    outage.end();
  }
  const held = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id } });
  expect({ status: held.status, failureCode: held.failureCode, providerPaymentId: held.providerPaymentId })
    .toEqual({ status: 'UNMATCHED', failureCode: 'UNFINISHED', providerPaymentId: null });
  return { id, txn };
}

const dbNow = async () => (await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`)[0]!.now;
/** Saved this long ago, on the database clock. */
async function savedAgo(paymentId: string, ms: number) {
  await prisma.mmgAgentPayment.update({ where: { id: paymentId }, data: { createdAt: new Date((await dbNow()).getTime() - ms) } });
}
/** Time passes for these payments' last failed attempt, their order kept. */
const lastTriedAgo = (ids: string[], ms: number) =>
  prisma.$executeRaw`UPDATE "mmg_agent_payments" SET "finishAttemptAt" = "finishAttemptAt" - (${ms} * INTERVAL '1 millisecond') WHERE "id" IN (${Prisma.join(ids)}) AND "finishAttemptAt" IS NOT NULL`;

async function money(subscriptionId: string, externals: string[]) {
  const topups = await prisma.billingEvent.findMany({ where: { subscriptionId, type: 'PREPAID_TOPUP' }, select: { idempotencyKey: true } });
  return {
    credits: topups.length,
    ledger: await prisma.ledgerTransaction.count({ where: { idempotencyKey: { in: topups.map((t) => `ledger:${t.idempotencyKey}`) } } }),
    observations: await prisma.mmgAgentPayment.count({ where: { externalId: { in: externals } } }),
  };
}

/** A door a finisher waits at, until the test opens it. */
const door = () => {
  let reached!: () => void;
  let open!: () => void;
  const isReached = new Promise<void>((r) => { reached = r; });
  const opened = new Promise<void>((r) => { open = r; });
  return { reached, isReached, open, opened };
};
/** Wait for `p`, but fail the test instead of hanging it. */
const within = async <T>(p: Promise<T>, ms = 15_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
};

/** Hold the payment row until every finisher is waiting on its lock chain.
 * Payer → source → payment locks can queue more than two levels deep. */
async function holdingPaymentRow<T>(paymentId: string, waiters: number, start: () => Array<Promise<T>>): Promise<Array<Promise<T>>> {
  let sent: Array<Promise<T>> = [];
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "mmg_agent_payments" WHERE "id" = ${paymentId} FOR UPDATE`;
    const pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
    sent = start();
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
      if (blocked >= waiters) return;
      if (Date.now() > deadline) throw new Error(`only ${blocked} of ${waiters} finishers reached the payment row`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }, { timeout: 20_000, maxWait: 5_000 });
  return sent;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  process.env['AGENT_CASH_WEBHOOK_SECRET'] = SECRET;
  await prisma.$connect();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(rateLimit, { max: 500, timeWindow: '1 minute' });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.register(agentCashRoutes, { prefix: '/api/v1/billing/mmg' });
  await app.ready();
  const notifications = new NotificationService(app.prisma, app.io);
  svc = new AgentCashService(app.prisma, new BillingService(app.prisma, notifications, getPaymentProvider()), notifications);
});

afterAll(async () => {
  delete process.env['AGENT_CASH_WEBHOOK_SECRET'];
  await prisma.mmgAgentPayment.deleteMany({ where: { externalId: { in: externalIds } } });
  await prisma.providerPayment.deleteMany({ where: { providerTxnId: { in: providerTxnIds } } });
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
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await app.close();
  await prisma.$disconnect();
});

describe('[MMG-RECV] a payment saved RECEIVED whose delivery died is finished, never left on disk', () => {
  it('webhook: the delivery dies after saving the payment; MMG redelivers while it is young and is told duplicate; once it is stranded, the redelivery credits it, once', async () => {
    const { sub, san } = await makeVendorSub();
    const txn = txnId();
    const body = { transactionId: txn, accountNumber: san, amount: 2100, currency: 'GYD' };
    const dying = vi.spyOn(AgentCashService.prototype, 'credit').mockImplementationOnce(async () => { throw new Error('CONNECTION_LOST'); });
    try {
      expect((await app.inject({ url: WEBHOOK, ...signed(body) })).statusCode).toBe(500);
    } finally {
      dying.mockRestore();
    }
    const saved = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { channel_externalId: { channel: 'MMG_AGENT_WEBHOOK', externalId: txn } } });
    expect(saved.status).toBe('RECEIVED');
    // Young: its own delivery may still be at work, so it is left to it.
    expect((await app.inject({ url: WEBHOOK, ...signed(body) })).json()).toEqual({ status: 'duplicate' });
    expect(await money(sub.id, [txn])).toEqual({ credits: 0, ledger: 0, observations: 1 });

    await savedAgo(saved.id, STRANDED_AFTER_MS + 60_000);
    const late = await app.inject({ url: WEBHOOK, ...signed(body) });
    expect(late.statusCode).toBe(200);
    expect(late.json()).toEqual({ status: 'accepted' });
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: saved.id } })).status).toBe('MATCHED');
    expect(await money(sub.id, [txn])).toEqual({ credits: 1, ledger: 1, observations: 1 });
    // Every later redelivery moves nothing.
    expect((await app.inject({ url: WEBHOOK, ...signed(body) })).json()).toEqual({ status: 'duplicate' });
    expect(await money(sub.id, [txn])).toEqual({ credits: 1, ledger: 1, observations: 1 });
  });

  it('manual: a receipt whose credit died is RECEIVED; keyed again while young it reads as recorded; keyed again once stranded, it is credited once, on the record of the admin who keyed it', async () => {
    const { sub, san } = await makeVendorSub();
    const receipt = receiptNo();
    const saved = await strandedBy(manualPayment(receipt, san, 'admin-first'), adminAudit('admin-first'));
    expect(await svc.ingest(manualPayment(receipt, san, 'admin-first'), adminAudit('admin-first'))).toEqual({ status: 'duplicate', paymentId: saved.id });

    await savedAgo(saved.id, STRANDED_AFTER_MS + 60_000);
    expect(await svc.ingest(manualPayment(receipt, san, 'admin-again'), adminAudit('admin-again')))
      .toMatchObject({ status: 'accepted', paymentId: saved.id, subscriptionId: sub.id });
    expect(await money(sub.id, [`MANUAL:${receipt}`])).toEqual({ credits: 1, ledger: 1, observations: 1 });
    // The first admin's audit row rolled back with the credit that failed; the
    // credit that landed carries the row of the admin who keyed it again.
    const trail = await prisma.auditLog.findMany({ where: { entityId: saved.id } });
    expect(trail.map((t) => ({ by: t.userId, action: t.action }))).toEqual([{ by: 'admin-again', action: 'TEST_AGENT_PAYMENT_RECORDED' }]);
  });

  it('the repair pass finishes webhook and manual payments stranded RECEIVED, each once and with a system audit row, and leaves a settlement-file row and a payment still in its delivery alone', async () => {
    const { sub, san } = await makeVendorSub();
    const webhook = await strandedWebhook(san);
    const receipt = receiptNo();
    const manual = await strandedBy(manualPayment(receipt, san, 'admin-keyer', 1000), adminAudit('admin-keyer'));
    const young = await strandedWebhook(san, 700);
    const fileTxn = txnId();
    const fileRow = await prisma.mmgAgentPayment.create({
      data: { channel: 'MMG_SETTLEMENT_FILE', externalId: fileTxn, mmgTxnId: fileTxn, sanRaw: san, amount: 900, currencyCode: 'GYD', paidAt: new Date(), status: 'RECEIVED', raw: { importId: 'an-import-that-owns-it', line: 2 } },
    });
    await savedAgo(webhook.id, STRANDED_AFTER_MS + 120_000);
    await savedAgo(manual.id, STRANDED_AFTER_MS + 60_000);
    await savedAgo(fileRow.id, STRANDED_AFTER_MS + 60_000);
    const ids = [webhook.id, manual.id, young.id, fileRow.id];

    expect(await svc.finishStrandedPayments({ paymentIds: ids })).toEqual({ finished: [webhook.id, manual.id], failed: [], suspensed: [] });
    const status = async () => Object.fromEntries((await prisma.mmgAgentPayment.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } })).map((r) => [r.id, r.status]));
    expect(await status()).toEqual({ [webhook.id]: 'MATCHED', [manual.id]: 'MATCHED', [young.id]: 'RECEIVED', [fileRow.id]: 'RECEIVED' });
    expect(await money(sub.id, [webhook.txn, `MANUAL:${receipt}`])).toEqual({ credits: 2, ledger: 2, observations: 2 });
    // The pass is the actor: a system row (no user) with each credit, naming
    // the payment and, for the manual entry, the admin who keyed it.
    const trail = await prisma.auditLog.findMany({ where: { entityId: { in: [webhook.id, manual.id] } }, orderBy: { createdAt: 'asc' } });
    expect(trail.map((t) => ({ by: t.userId, action: t.action, entityId: t.entityId, changes: t.changes }))).toEqual([
      { by: null, action: 'AGENT_PAYMENT_STRANDED_FINISHED', entityId: webhook.id, changes: expect.objectContaining({ paymentId: webhook.id, credited: true, channel: 'MMG_AGENT_WEBHOOK', finishedBy: 'poll-mmg-billing' }) },
      { by: null, action: 'AGENT_PAYMENT_STRANDED_FINISHED', entityId: manual.id, changes: expect.objectContaining({ paymentId: manual.id, credited: true, channel: 'MANUAL_ADMIN', finishedBy: 'poll-mmg-billing', enteredBy: 'admin-keyer' }) },
    ]);
    // A second pass moves nothing.
    expect(await svc.finishStrandedPayments({ paymentIds: ids })).toEqual({ finished: [], failed: [], suspensed: [] });
    expect(await money(sub.id, [webhook.txn, `MANUAL:${receipt}`])).toEqual({ credits: 2, ledger: 2, observations: 2 });
  });

  it('a stranded webhook payment whose transaction the founder has since keyed from the MMG portal is reconciled against that credit, never credited twice', async () => {
    const { sub, san } = await makeVendorSub();
    const w = await strandedWebhook(san);
    externalIds.push(`MANUAL:${w.txn}`);
    // The same MMG transaction, keyed by hand from the portal: that credit lands.
    const keyed = await svc.ingest(manualPayment(w.txn, san, 'admin-portal'), adminAudit('admin-portal'));
    expect(keyed).toMatchObject({ status: 'accepted' });
    await savedAgo(w.id, STRANDED_AFTER_MS + 60_000);
    expect(await svc.finishStrandedPayments({ paymentIds: [w.id] })).toEqual({ finished: [w.id], failed: [], suspensed: [] });
    const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.status).toBe('RECONCILED');
    expect(row.note).toContain(keyed.paymentId);
    expect(await money(sub.id, [w.txn, `MANUAL:${w.txn}`])).toEqual({ credits: 1, ledger: 1, observations: 2 });
  });
});

describe('[MMG-RECV · fenced] of every finisher, one decides; the others write nothing', () => {
  it('two MMG redeliveries and the repair pass reach one stranded payment together: exactly one credits it, the others are answered duplicate', async () => {
    const { sub, san } = await makeVendorSub();
    const s = await strandedWebhook(san);
    await savedAgo(s.id, STRANDED_AFTER_MS + 60_000);
    const sent = await holdingPaymentRow<IngestResult | { finished: string[]; failed: string[]; suspensed: string[] }>(s.id, 3, () => [
      svc.ingest(webhookPayment(s.txn, san)),
      svc.ingest(webhookPayment(s.txn, san)),
      svc.finishStrandedPayments({ paymentIds: [s.id] }),
    ]);
    const [a, b, pass] = await within(Promise.all(sent)) as [IngestResult, IngestResult, { finished: string[]; failed: string[]; suspensed: string[] }];
    const winners = [a.status === 'accepted', b.status === 'accepted', pass.finished.includes(s.id)].filter(Boolean).length;
    expect(winners).toBe(1);
    expect([a.status, b.status].every((x) => x === 'accepted' || x === 'duplicate')).toBe(true);
    expect({ failed: pass.failed, suspensed: pass.suspensed }).toEqual({ failed: [], suspensed: [] });
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('MATCHED');
    expect(await money(sub.id, [s.txn])).toEqual({ credits: 1, ledger: 1, observations: 1 });
  });

  it('two redeliveries reconcile one stranded payment together: one decides it, the other is answered duplicate and rewrites nothing', async () => {
    const { sub, san } = await makeVendorSub();
    const w = await strandedWebhook(san);
    externalIds.push(`MANUAL:${w.txn}`);
    expect(await svc.ingest(manualPayment(w.txn, san, 'admin-portal'), adminAudit('admin-portal'))).toMatchObject({ status: 'accepted' });
    await savedAgo(w.id, STRANDED_AFTER_MS + 60_000);
    const sent = await holdingPaymentRow<IngestResult>(w.id, 2, () => [svc.ingest(webhookPayment(w.txn, san)), svc.ingest(webhookPayment(w.txn, san))]);
    const answers = (await within(Promise.all(sent))).map((r) => r.status).sort();
    expect(answers).toEqual(['duplicate', 'reconciled']);
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: w.id } })).status).toBe('RECONCILED');
    expect(await money(sub.id, [w.txn, `MANUAL:${w.txn}`])).toEqual({ credits: 1, ledger: 1, observations: 2 });
  });

  it('a live delivery paused past the stranded age loses to the repair pass: its own verdict writes nothing over the credit that won', async () => {
    const { sub } = await makeVendorSub({ san: false });
    const san = generateSan(); // nobody holds it yet: the live delivery will judge it unknown
    const txn = txnId();
    const proto = AgentCashService.prototype as unknown as { suspense: (paymentId: string, failureCode: string) => Promise<IngestResult> };
    const realSuspense = proto.suspense;
    const stall = door();
    let first = true;
    const stalling = vi.spyOn(proto, 'suspense').mockImplementation(async function (this: unknown, ...args: [string, string]) {
      if (first) { first = false; stall.reached(); await stall.opened; }
      return realSuspense.apply(this, args);
    });
    try {
      const live = svc.ingest(webhookPayment(txn, san));
      live.catch(() => undefined); // awaited below; a failed run must not leave it unhandled
      await within(stall.isReached); // judged the number unknown; about to park it in suspense
      const id = (await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { channel_externalId: { channel: 'MMG_AGENT_WEBHOOK', externalId: txn } } })).id;
      // Meanwhile the account takes that number, and the delivery has been gone past the stranded age.
      await prisma.subscription.update({ where: { id: sub.id }, data: { san, sanAssignedAt: new Date() } });
      await savedAgo(id, STRANDED_AFTER_MS + 60_000);
      expect(await svc.finishStrandedPayments({ paymentIds: [id] })).toEqual({ finished: [id], failed: [], suspensed: [] });
      stall.open();
      // The live delivery wakes and lost: its suspense verdict lands on nothing.
      await expect(within(live)).rejects.toThrow('NOT_RECEIVED');
      const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id } });
      expect({ status: row.status, failureCode: row.failureCode }).toEqual({ status: 'MATCHED', failureCode: null });
    } finally {
      stall.open();
      stalling.mockRestore();
    }
    expect(await money(sub.id, [txn])).toEqual({ credits: 1, ledger: 1, observations: 1 });
  });

  it('a finish that fails after another finisher decided the payment records nothing: the verdict that won stands', async () => {
    const { sub, san } = await makeVendorSub();
    const s = await strandedWebhook(san);
    // Stranded past the give-up age and tried before: an unfenced write of
    // this failure would send the credited payment to the suspense queue.
    await savedAgo(s.id, STRANDED_GIVE_UP_AFTER_MS + 60_000);
    await prisma.mmgAgentPayment.update({ where: { id: s.id }, data: { finishAttemptAt: new Date((await dbNow()).getTime() - STRANDED_RETRY_BACKOFF_MS - 60_000) } });
    let first = true;
    let redelivered: IngestResult | undefined;
    const racing = vi.spyOn(AgentCashService.prototype, 'credit').mockImplementation(async function (this: AgentCashService, ...args: Parameters<AgentCashService['credit']>) {
      if (first) {
        first = false;
        // While the pass is inside its credit, MMG redelivers and that credit lands...
        redelivered = await svc.ingest(webhookPayment(s.txn, san));
        // ...then the pass's own credit fails.
        throw new Error('CONNECTION_LOST');
      }
      return realCredit.apply(this, args);
    });
    try {
      expect(await svc.finishStrandedPayments({ paymentIds: [s.id] })).toEqual({ finished: [], failed: [], suspensed: [] });
    } finally {
      racing.mockRestore();
    }
    expect(redelivered).toMatchObject({ status: 'accepted', paymentId: s.id });
    const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: s.id } });
    expect({ status: row.status, failureCode: row.failureCode }).toEqual({ status: 'MATCHED', failureCode: null });
    expect(await money(sub.id, [s.txn])).toEqual({ credits: 1, ledger: 1, observations: 1 });
  });
});

describe('[MMG-RECV · database clock] the stranded age is the database clock, stamped by the INSERT', () => {
  it('this server 10 minutes AHEAD still leaves a payment saved just now to its delivery; 10 minutes BEHIND, it still finishes a stranded one', async () => {
    const { sub, san } = await makeVendorSub();
    const young = await strandedWebhook(san);
    const old = await strandedWebhook(san, 1000);
    await savedAgo(old.id, STRANDED_AFTER_MS + 60_000);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 10 * 60_000);
      expect(await svc.finishStrandedPayments({ paymentIds: [young.id] })).toEqual({ finished: [], failed: [], suspensed: [] });
      expect(await svc.ingest(webhookPayment(young.txn, san))).toEqual({ status: 'duplicate', paymentId: young.id });
      vi.setSystemTime(Date.now() - 20 * 60_000);
      expect(await svc.finishStrandedPayments({ paymentIds: [old.id] })).toEqual({ finished: [old.id], failed: [], suspensed: [] });
    } finally {
      vi.useRealTimers();
    }
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: young.id } })).status).toBe('RECEIVED');
    expect(await money(sub.id, [young.txn, old.txn])).toEqual({ credits: 1, ledger: 1, observations: 2 });
  });

  it('the saved time is written by the INSERT on the database clock, never by the app clock: a server 10 minutes behind still saves a young payment', async () => {
    const { san } = await makeVendorSub();
    vi.useFakeTimers({ toFake: ['Date'] });
    let saved: Awaited<ReturnType<typeof strandedWebhook>>;
    let before: Date;
    let after: Date;
    try {
      vi.setSystemTime(Date.now() - 10 * 60_000);
      before = await dbNow();
      saved = await strandedWebhook(san);
      after = await dbNow();
    } finally {
      vi.useRealTimers();
    }
    expect(saved.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1);
    expect(saved.createdAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1);
    // So a redelivery right away still leaves it to its own delivery.
    expect(await svc.ingest(webhookPayment(saved.txn, san))).toEqual({ status: 'duplicate', paymentId: saved.id });
  });
});

describe('[MMG-RECV · fair] the repair pass: never tried first, then the least recently tried; a backoff; a person after the give-up age', () => {
  it('twenty stranded payments that fail every time cannot starve the twenty-first', async () => {
    const { sub, san } = await makeVendorSub();
    const stranded: Array<Awaited<ReturnType<typeof strandedWebhook>>> = [];
    for (let i = 0; i < 21; i += 1) stranded.push(await strandedWebhook(san, 1000 + i));
    const ids = stranded.map((s) => s.id);
    // All stranded; the twenty were saved before the twenty-first.
    for (const [i, id] of ids.entries()) await savedAgo(id, STRANDED_AFTER_MS + (ids.length - i) * 60_000);
    const broken = new Set(stranded.slice(0, 20).map((s) => s.txn));
    const failing = vi.spyOn(AgentCashService.prototype, 'credit').mockImplementation(async function (this: AgentCashService, ...args: Parameters<AgentCashService['credit']>) {
      if (broken.has(args[2].externalId)) throw new Error('WALLET_CURRENCY_MISMATCH');
      return realCredit.apply(this, args);
    });
    try {
      const first = await svc.finishStrandedPayments({ paymentIds: ids, limit: 20 });
      expect({ ...first, failed: [...first.failed].sort() }).toEqual({ finished: [], failed: ids.slice(0, 20).sort(), suspensed: [] });
      // Past the backoff for all of them: only the order can reach the twenty-first first.
      await lastTriedAgo(ids, STRANDED_RETRY_BACKOFF_MS + 60_000);
      const second = await svc.finishStrandedPayments({ paymentIds: ids, limit: 20 });
      expect(second.finished).toEqual([ids[20]]);
    } finally {
      failing.mockRestore();
    }
    expect(await money(sub.id, stranded.map((s) => s.txn))).toEqual({ credits: 1, ledger: 1, observations: 21 });
  });

  it('a stranded payment whose finish just failed is left alone for the backoff, then tried again', async () => {
    const { san } = await makeVendorSub();
    const s = await strandedWebhook(san);
    await savedAgo(s.id, STRANDED_AFTER_MS + 60_000);
    const failing = vi.spyOn(AgentCashService.prototype, 'credit').mockImplementation(async () => { throw new Error('WALLET_CURRENCY_MISMATCH'); });
    try {
      expect(await svc.finishStrandedPayments({ paymentIds: [s.id] })).toEqual({ finished: [], failed: [s.id], suspensed: [] });
      expect(await svc.finishStrandedPayments({ paymentIds: [s.id] })).toEqual({ finished: [], failed: [], suspensed: [] });
      await lastTriedAgo([s.id], STRANDED_RETRY_BACKOFF_MS + 60_000);
      expect(await svc.finishStrandedPayments({ paymentIds: [s.id] })).toEqual({ finished: [], failed: [s.id], suspensed: [] });
    } finally {
      failing.mockRestore();
    }
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('RECEIVED');
  });

  it('one that keeps failing goes to the suspense queue for a person after the give-up age, never on its first failure, and the person can still credit it once', async () => {
    const { sub, san } = await makeVendorSub();
    const s = await strandedWebhook(san);
    await savedAgo(s.id, STRANDED_GIVE_UP_AFTER_MS + 60_000); // stranded for over an hour: the pass was down
    const failing = vi.spyOn(AgentCashService.prototype, 'credit').mockImplementation(async () => { throw new Error('WALLET_CURRENCY_MISMATCH'); });
    try {
      // Its first failure is only recorded: giving up needs a failure before it.
      expect(await svc.finishStrandedPayments({ paymentIds: [s.id] })).toEqual({ finished: [], failed: [s.id], suspensed: [] });
      await lastTriedAgo([s.id], STRANDED_RETRY_BACKOFF_MS + 60_000);
      expect(await svc.finishStrandedPayments({ paymentIds: [s.id] })).toEqual({ finished: [], failed: [], suspensed: [s.id] });
    } finally {
      failing.mockRestore();
    }
    const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: s.id } });
    expect({ status: row.status, failureCode: row.failureCode }).toEqual({ status: 'UNMATCHED', failureCode: 'UNFINISHED' });
    expect((await svc.unmatchedQueue(1000)).find((r) => r.id === s.id)?.diagnosis).toMatch(/never credited/);
    // A person resolves it through the same credit pipeline: once.
    expect(await svc.attach(s.id, sub.id, 'admin-resolver')).toMatchObject({ status: 'accepted', paymentId: s.id });
    expect(await money(sub.id, [s.txn])).toEqual({ credits: 1, ledger: 1, observations: 1 });
  });
});

describe('[AX363] every credit goes through the provider identity and stays inside its tenant', () => {
  it('[F1] a payment whose delivery died before its identity was linked, given up and then attached by a person, and the same MMG transaction keyed from the portal: exactly one credit', async () => {
    const { sub, san } = await makeVendorSub();
    const { id, txn } = await givenUpWithoutIdentity(san);
    externalIds.push(`MANUAL:${txn}`);
    const attached = await svc.attach(id, sub.id, 'admin-resolver');
    const keyed = await svc.ingest(manualPayment(txn, san, 'admin-portal'), adminAudit('admin-portal'));
    expect([attached.status, keyed.status]).toEqual(['accepted', 'reconciled']);
    const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('RESOLVED');
    expect(row.providerPaymentId).not.toBeNull();
    expect(await money(sub.id, [txn, `MANUAL:${txn}`])).toEqual({ credits: 1, ledger: 1, observations: 2 });
  });

  it('[F1] the same, with the attach and the other channel landing together: exactly one credit', async () => {
    const { sub, san } = await makeVendorSub();
    const { id, txn } = await givenUpWithoutIdentity(san);
    externalIds.push(`MANUAL:${txn}`);
    const answers = await within(Promise.all([
      svc.attach(id, sub.id, 'admin-resolver'),
      svc.ingest(manualPayment(txn, san, 'admin-portal'), adminAudit('admin-portal')),
    ]));
    expect(answers.map((a) => a.status).sort()).toEqual(['accepted', 'reconciled']);
    expect(await money(sub.id, [txn, `MANUAL:${txn}`])).toEqual({ credits: 1, ledger: 1, observations: 2 });
  });

  it('[F1] the shared credit refuses an observation with no provider identity: nothing is credited and it stays held', async () => {
    const { sub, san } = await makeVendorSub();
    const txn = txnId();
    const row = await prisma.mmgAgentPayment.create({
      data: { channel: 'MMG_AGENT_WEBHOOK', externalId: txn, mmgTxnId: txn, sanRaw: san, amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'RECEIVED', raw: {} },
    });
    await expect(svc.credit(row.id, sub.id, { amount: 2100, channel: 'MMG_AGENT_WEBHOOK', externalId: txn })).rejects.toThrow('PROVIDER_IDENTITY_MISSING');
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('RECEIVED');
    expect(await money(sub.id, [txn])).toEqual({ credits: 0, ledger: 0, observations: 1 });
  });

  it('[F1] the shared credit refuses an observation whose identity disagrees with it: nothing is credited', async () => {
    const { sub, san } = await makeVendorSub();
    const txn = txnId();
    const identity = await prisma.providerPayment.create({ data: { provider: 'MMG', providerTxnId: txn.toUpperCase(), amount: 9999, currencyCode: 'GYD' } });
    const row = await prisma.mmgAgentPayment.create({
      data: { channel: 'MMG_AGENT_WEBHOOK', externalId: txn, mmgTxnId: txn, providerPaymentId: identity.id, sanRaw: san, amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'RECEIVED', raw: {} },
    });
    await expect(svc.credit(row.id, sub.id, { amount: 2100, channel: 'MMG_AGENT_WEBHOOK', externalId: txn })).rejects.toThrow('PROVIDER_ID_CONFLICT');
    expect((await prisma.providerPayment.findUniqueOrThrow({ where: { id: identity.id } })).status).toBe('OPEN');
    expect(await money(sub.id, [txn])).toEqual({ credits: 0, ledger: 0, observations: 1 });
  });

  it("[F2] a recovery whose SAN belongs to another tenant moves nothing there: the payment is held in suspense for a person, the other tenant's wallet untouched", async () => {
    const foreign = await makeForeignVendorSub();
    const txn = txnId();
    // Saved in this tenant; the delivery died before it judged anything.
    const outage = identityOutage();
    try {
      await expect(svc.ingest(webhookPayment(txn, foreign.san))).rejects.toThrow('CONNECTION_LOST');
    } finally {
      outage.end();
    }
    const saved = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { channel_externalId: { channel: 'MMG_AGENT_WEBHOOK', externalId: txn } } });
    expect(saved.tenantId).toBe('swift-default');
    await savedAgo(saved.id, STRANDED_AFTER_MS + 60_000);
    expect(await svc.finishStrandedPayments({ paymentIds: [saved.id] })).toEqual({ finished: [saved.id], failed: [], suspensed: [] });
    const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: saved.id } });
    expect({ status: row.status, failureCode: row.failureCode, subscriptionId: row.subscriptionId }).toEqual({ status: 'UNMATCHED', failureCode: 'SAN_UNKNOWN', subscriptionId: null });
    expect(await money(foreign.sub.id, [txn])).toEqual({ credits: 0, ledger: 0, observations: 1 });
    expect(await prisma.prepaidBalance.findUnique({ where: { subscriptionId: foreign.sub.id } })).toBeNull();
  });

  it("[F2] a person cannot attach a payment to another tenant's account: refused, nothing moves", async () => {
    const foreign = await makeForeignVendorSub();
    const txn = txnId();
    const parked = await svc.ingest(webhookPayment(txn, generateSan())); // nobody holds it: suspense
    expect(parked.status).toBe('received_unmatched');
    await expect(svc.attach(parked.paymentId, foreign.sub.id, 'admin-resolver')).rejects.toThrow('DESTINATION_TENANT_MISMATCH');
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: parked.paymentId } })).status).toBe('UNMATCHED');
    expect(await money(foreign.sub.id, [txn])).toEqual({ credits: 0, ledger: 0, observations: 1 });
  });

  it('[F3] the migration waits at most 10 s for its lock on the live payments table, set in the migration itself', () => {
    const sql = readFileSync(join(process.cwd(), 'prisma/migrations/20260930120000_mmg_received_stranded/migration.sql'), 'utf8');
    const bound = sql.indexOf("SET lock_timeout = '10s';");
    expect(bound).toBeGreaterThan(-1);
    expect(bound).toBeLessThan(sql.indexOf('ALTER TABLE'));
  });
});

describe('[AX369] one MMG transaction, one credit authority, whatever the key normalisation', () => {
  /** The legacy pair: an MMG id padded with tabs, and the same id with spaces
   *  around the tabs. The identity backfill (Postgres trim(): spaces only)
   *  keyed both "\tID\t"; today's normalisation (all whitespace) keys "ID". */
  const legacyPair = () => {
    const core = `LEG${nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, 'Q')}`;
    providerTxnIds.push(`\t${core}\t`, core, `\n\t${core}\t\n`);
    return { core, tabbed: `\t${core}\t`, spaced: ` \t${core}\t ` };
  };
  /** The backfill's state: an identity under `key`, and a first observation
   *  linked to it and credited THROUGH it. */
  async function creditedLegacy(san: string, subscriptionId: string, key: string, externalId: string) {
    const identity = await prisma.providerPayment.create({ data: { provider: 'MMG', providerTxnId: key, amount: 2100, currencyCode: 'GYD' } });
    externalIds.push(externalId);
    const first = await prisma.mmgAgentPayment.create({
      data: { channel: 'MMG_AGENT_WEBHOOK', externalId, mmgTxnId: externalId, providerPaymentId: identity.id, sanRaw: san, amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'RECEIVED', raw: {} },
    });
    expect(await svc.credit(first.id, subscriptionId, { amount: 2100, channel: 'MMG_AGENT_WEBHOOK', externalId })).toMatchObject({ status: 'accepted' });
    return identity;
  }
  /** A second observation the backfill linked to the same identity, parked in suspense. */
  async function linkedInSuspense(san: string, identityId: string, receipt: string) {
    externalIds.push(`MANUAL:${receipt}`);
    return prisma.mmgAgentPayment.create({
      data: { channel: 'MANUAL_ADMIN', externalId: `MANUAL:${receipt}`, providerPaymentId: identityId, sanRaw: san, amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'UNMATCHED', failureCode: 'SAN_UNKNOWN', raw: {} },
    });
  }
  const identitiesFor = (core: string) => prisma.providerPayment.count({ where: { providerTxnId: { in: [`\t${core}\t`, core, `\n\t${core}\t\n`] } } });

  it('the tab/space legacy pair: attach USES the identity the backfill linked, never re-mints; the second observation is reconciled, one credit', async () => {
    const { sub, san } = await makeVendorSub();
    const { core, tabbed, spaced } = legacyPair();
    const legacy = await creditedLegacy(san, sub.id, tabbed, tabbed);
    const second = await linkedInSuspense(san, legacy.id, spaced);
    expect(await svc.attach(second.id, sub.id, 'admin-resolver')).toMatchObject({ status: 'reconciled', paymentId: second.id });
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: second.id } })).providerPaymentId).toBe(legacy.id);
    expect(await identitiesFor(core)).toBe(1);
    expect(await money(sub.id, [tabbed, `MANUAL:${spaced}`])).toEqual({ credits: 1, ledger: 1, observations: 2 });
  });

  it('a link is used even when no normalisation of the id today would find it (a newline-padded legacy id): reconciled, one credit', async () => {
    const { sub, san } = await makeVendorSub();
    const { core, tabbed } = legacyPair();
    const legacy = await creditedLegacy(san, sub.id, tabbed, tabbed);
    const newline = `\n\t${core}\t\n`; // trim() and the backfill form both miss "\tCORE\t" here
    const second = await linkedInSuspense(san, legacy.id, newline);
    expect(await svc.attach(second.id, sub.id, 'admin-resolver')).toMatchObject({ status: 'reconciled', paymentId: second.id });
    expect(await identitiesFor(core)).toBe(1);
    expect(await money(sub.id, [tabbed, `MANUAL:${newline}`])).toEqual({ credits: 1, ledger: 1, observations: 2 });
  });

  it("a new delivery of a legacy transaction finds the identity under the backfill's key before minting one: reconciled, one credit", async () => {
    const { sub, san } = await makeVendorSub();
    const { core, tabbed, spaced } = legacyPair();
    await creditedLegacy(san, sub.id, tabbed, tabbed);
    externalIds.push(spaced);
    expect(await svc.ingest(webhookPayment(spaced, san))).toMatchObject({ status: 'reconciled' });
    expect(await identitiesFor(core)).toBe(1);
    expect(await money(sub.id, [tabbed, spaced])).toEqual({ credits: 1, ledger: 1, observations: 2 });
  });

  it('the concurrent mint race: two unlinked observations of one legacy transaction (tab and space-tab forms) arriving together mint exactly ONE identity, one credit', async () => {
    const { sub, san } = await makeVendorSub();
    const { core, tabbed, spaced } = legacyPair();
    externalIds.push(tabbed, spaced);
    // Hold an uncommitted identity under today's key until BOTH deliveries
    // have looked every key form up, found nothing, and are blocked on the
    // same unique key; then roll it back so they really race to mint.
    const HOLD = new Error('hold released');
    let sent: Array<Promise<IngestResult>> = [];
    await prisma.$transaction(async (tx) => {
      await tx.providerPayment.create({ data: { provider: 'MMG', providerTxnId: core, amount: 2100, currencyCode: 'GYD' } });
      const pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      sent = [svc.ingest(webhookPayment(tabbed, san)), svc.ingest(webhookPayment(spaced, san))];
      sent.forEach((p) => p.catch(() => undefined));
      const deadline = Date.now() + 15_000;
      for (;;) {
        const blocked = (await prisma.$queryRaw<Array<{ blocked: number }>>`SELECT count(*)::int AS blocked FROM pg_stat_activity a
          WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
             OR EXISTS (SELECT 1 FROM unnest(pg_blocking_pids(a.pid)) AS b(p) WHERE ${pid}::int = ANY(pg_blocking_pids(b.p)))`)[0]!.blocked;
        if (blocked >= 2) throw HOLD;
        if (Date.now() > deadline) throw new Error(`only ${blocked} of 2 deliveries reached the identity key`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }, { timeout: 20_000, maxWait: 5_000 }).catch((e: unknown) => { if (e !== HOLD) throw e; });
    const answers = (await within(Promise.all(sent))).map((a) => a.status).sort();
    expect(answers).toEqual(['accepted', 'reconciled']);
    const identities = await prisma.providerPayment.findMany({ where: { providerTxnId: { in: [`\t${core}\t`, core] } } });
    expect(identities.map((i) => i.providerTxnId)).toEqual([core]);
    const links = await prisma.mmgAgentPayment.findMany({ where: { externalId: { in: [tabbed, spaced] } }, select: { providerPaymentId: true } });
    expect(links.map((l) => l.providerPaymentId)).toEqual([identities[0]!.id, identities[0]!.id]);
    expect(await money(sub.id, [tabbed, spaced])).toEqual({ credits: 1, ledger: 1, observations: 2 });
  });

  it('the database refuses two live identities for one transaction; a held duplicate cannot displace the live identity', async () => {
    const { sub, san } = await makeVendorSub();
    const { core, spaced } = legacyPair();
    const live = await prisma.providerPayment.create({ data: { provider: 'MMG', providerTxnId: `\t${core}\t`, amount: 2100, currencyCode: 'GYD' } });
    await expect(prisma.providerPayment.create({ data: { provider: 'MMG', providerTxnId: core, amount: 2100, currencyCode: 'GYD' } })).rejects.toMatchObject({ code: 'P2002' });
    await prisma.providerPayment.create({ data: { provider: 'MMG', providerTxnId: core, status: 'HELD_DUPLICATE', amount: 2100, currencyCode: 'GYD' } });
    externalIds.push(spaced);
    expect(await svc.ingest(webhookPayment(spaced, san))).toMatchObject({ status: 'accepted' });
    const row = await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { channel_externalId: { channel: 'MMG_AGENT_WEBHOOK', externalId: spaced } } });
    expect({ status: row.status, providerPaymentId: row.providerPaymentId }).toEqual({ status: 'MATCHED', providerPaymentId: live.id });
    expect(await money(sub.id, [spaced])).toEqual({ credits: 1, ledger: 1, observations: 1 });
  });

  it.each(['plain', 'spaces'])('[AX384] a %s observation of the tab-padded credited legacy transaction cannot mint or credit again', async (spelling) => {
    const { sub, san } = await makeVendorSub();
    const { core, tabbed } = legacyPair();
    const legacy = await creditedLegacy(san, sub.id, tabbed, tabbed);
    const incoming = spelling === 'plain' ? core : ` ${core} `;
    externalIds.push(incoming);
    expect(await svc.ingest(webhookPayment(incoming, san))).toMatchObject({ status: 'reconciled' });
    expect(await identitiesFor(core)).toBe(1);
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { channel_externalId: { channel: 'MMG_AGENT_WEBHOOK', externalId: incoming } } })).providerPaymentId).toBe(legacy.id);
    expect(await money(sub.id, [tabbed, incoming])).toEqual({ credits: 1, ledger: 1, observations: 2 });
  });

  it.each(['straße', 'ﬁle'])('[AX384] %s uses database case folding for every channel', async (suffix) => {
    const { sub, san } = await makeVendorSub();
    const raw = `${txnId()}-${suffix}`;
    const { key } = (await prisma.$queryRaw<Array<{ key: string }>>`SELECT upper(${raw}) AS key`)[0]!;
    providerTxnIds.push(key!, raw.toUpperCase());
    externalIds.push(raw);
    await creditedLegacy(san, sub.id, key!, raw);
    externalIds.push(`MANUAL:${raw}`);
    expect(await svc.ingest(manualPayment(raw, san, 'admin-portal'))).toMatchObject({ status: 'reconciled' });
    expect(await money(sub.id, [raw, `MANUAL:${raw}`])).toEqual({ credits: 1, ledger: 1, observations: 2 });
  });

  it('[AX384] a stale resolver cannot link an observation after it was held; later attach cannot credit it', async () => {
    const { sub, san } = await makeVendorSub();
    const txn = txnId();
    const stale = await prisma.mmgAgentPayment.create({ data: {
      channel: 'MMG_AGENT_WEBHOOK', externalId: txn, mmgTxnId: txn, sanRaw: san,
      amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'RECEIVED', raw: {},
    } });
    await prisma.mmgAgentPayment.update({ where: { id: stale.id }, data: { status: 'UNMATCHED', failureCode: 'PROVIDER_ID_CONFLICT' } });
    await expect(realIdentityFor.call(svc, stale, stale.channel)).rejects.toThrow('NOT_RECEIVED');
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: stale.id } })).providerPaymentId).toBeNull();
    await expect(svc.attach(stale.id, sub.id, 'admin-resolver')).rejects.toThrow('PROVIDER_ID_CONFLICT');
    expect(await money(sub.id, [txn])).toEqual({ credits: 0, ledger: 0, observations: 1 });
  });

  it('[AX384] a linked held identity goes to suspense and can never be reconciled as an unknown credit or attached', async () => {
    const { sub, san } = await makeVendorSub();
    const txn = txnId();
    const held = await prisma.providerPayment.create({ data: { provider: 'MMG', providerTxnId: txn.toUpperCase(), status: 'HELD_DUPLICATE', amount: 2100, currencyCode: 'GYD' } });
    const row = await prisma.mmgAgentPayment.create({ data: {
      channel: 'MMG_AGENT_WEBHOOK', externalId: txn, mmgTxnId: txn, providerPaymentId: held.id, sanRaw: san,
      amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'RECEIVED', raw: {},
    } });
    expect(await realIdentityFor.call(svc, row, row.channel)).toMatchObject({ conflict: true });
    expect(await svc.resumeReceived(row.id)).toMatchObject({ status: 'received_unmatched', failureCode: 'PROVIDER_ID_CONFLICT' });
    await expect(svc.attach(row.id, sub.id, 'admin-resolver')).rejects.toThrow('PROVIDER_ID_CONFLICT');
    expect(await money(sub.id, [txn])).toEqual({ credits: 0, ledger: 0, observations: 1 });
  });

  it('[AX384] the same-state hold wins against an old unmatched resolver snapshot without linking it', async () => {
    const { sub, san } = await makeVendorSub();
    const txn = txnId();
    const stale = await prisma.mmgAgentPayment.create({ data: {
      channel: 'MMG_AGENT_WEBHOOK', externalId: txn, mmgTxnId: txn, sanRaw: san,
      amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'UNMATCHED', failureCode: 'UNFINISHED', raw: {},
    } });
    await prisma.mmgAgentPayment.update({ where: { id: stale.id }, data: { failureCode: 'PROVIDER_ID_CONFLICT' } });
    expect(await realIdentityFor.call(svc, stale, stale.channel)).toMatchObject({ conflict: true });
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: stale.id } })).providerPaymentId).toBeNull();
    await expect(svc.attach(stale.id, sub.id, 'admin-resolver')).rejects.toThrow('PROVIDER_ID_CONFLICT');
    expect(await money(sub.id, [txn])).toEqual({ credits: 0, ledger: 0, observations: 1 });
  });

  it('[AX384] credit waits for the identity row lock, re-reads the hold, and durably suspenses without money movement', async () => {
    const { sub, san } = await makeVendorSub();
    const txn = txnId();
    const identity = await prisma.providerPayment.create({ data: { provider: 'MMG', providerTxnId: txn.toUpperCase(), amount: 2100, currencyCode: 'GYD' } });
    const row = await prisma.mmgAgentPayment.create({ data: {
      channel: 'MMG_AGENT_WEBHOOK', externalId: txn, mmgTxnId: txn, providerPaymentId: identity.id, sanRaw: san,
      amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'RECEIVED', raw: {},
    } });
    let pending: Promise<IngestResult> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.providerPayment.update({ where: { id: identity.id }, data: { status: 'HELD_DUPLICATE' } });
      const { pid } = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!;
      pending = svc.credit(row.id, sub.id, { amount: 2100, channel: row.channel, externalId: txn });
      pending.catch(() => undefined);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { blocked } = (await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity a WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))) AS blocked`)[0]!;
        if (blocked) break;
        if (Date.now() > deadline) throw new Error('credit never reached the identity row lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }, { timeout: 15_000 });
    expect(await pending).toMatchObject({ status: 'received_unmatched', failureCode: 'PROVIDER_ID_CONFLICT' });
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('UNMATCHED');
    expect(await money(sub.id, [txn])).toEqual({ credits: 0, ledger: 0, observations: 1 });
  });

  it.each(['canonical', 'tenant'])('[AX384] credit validates the identity %s inside the money transaction', async (mismatch) => {
    const { sub, san } = await makeVendorSub();
    const txn = txnId();
    const other = txnId();
    const identity = await prisma.providerPayment.create({ data: {
      provider: 'MMG', providerTxnId: mismatch === 'canonical' ? other.toUpperCase() : txn.toUpperCase(),
      tenantId: mismatch === 'tenant' ? (await makeForeignVendorSub()).tenant.id : 'swift-default', amount: 2100, currencyCode: 'GYD',
    } });
    const row = await prisma.mmgAgentPayment.create({ data: {
      channel: 'MMG_AGENT_WEBHOOK', externalId: txn, mmgTxnId: txn, providerPaymentId: identity.id, sanRaw: san,
      amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'RECEIVED', raw: {},
    } });
    await expect(svc.credit(row.id, sub.id, { amount: 2100, channel: row.channel, externalId: txn })).rejects.toThrow('PROVIDER_ID_CONFLICT');
    expect((await prisma.providerPayment.findUniqueOrThrow({ where: { id: identity.id } })).status).toBe('OPEN');
    expect(await money(sub.id, [txn])).toEqual({ credits: 0, ledger: 0, observations: 1 });
  });

  it('[AX384] an alternate raw alias of a historical JS-collapsed identity cannot mint another credit authority', async () => {
    const { sub, san } = await makeVendorSub();
    const raw = `${txnId()}-straße`;
    const { key } = (await prisma.$queryRaw<Array<{ key: string }>>`SELECT upper(${raw}) AS key`)[0]!;
    providerTxnIds.push(key!, raw.toUpperCase());
    const identity = await creditedLegacy(san, sub.id, key!, raw);
    const alias = raw.toUpperCase();
    const historical = await linkedInSuspense(san, identity.id, alias);
    expect(await realIdentityFor.call(svc, historical, historical.channel)).toMatchObject({ conflict: true });
    externalIds.push(alias);
    expect(await svc.ingest(webhookPayment(alias, san))).toMatchObject({ status: 'received_unmatched', failureCode: 'PROVIDER_ID_CONFLICT' });
    await expect(svc.attach(historical.id, sub.id, 'admin-resolver')).rejects.toThrow('PROVIDER_ID_CONFLICT');
    expect(await prisma.providerPayment.count({ where: { providerTxnId: { in: [key!, alias] } } })).toBe(1);
    expect(await money(sub.id, [raw, alias, `MANUAL:${alias}`])).toEqual({ credits: 1, ledger: 1, observations: 3 });
  });

  it('[AX384] a stale unlinked snapshot cannot overwrite a link another resolver already set to a held identity', async () => {
    const { sub, san } = await makeVendorSub();
    const txn = txnId();
    await prisma.providerPayment.create({ data: { provider: 'MMG', providerTxnId: txn.toUpperCase(), amount: 2100, currencyCode: 'GYD' } });
    const held = await prisma.providerPayment.create({ data: { provider: 'MMG', providerTxnId: txn.toUpperCase(), status: 'HELD_DUPLICATE', amount: 2100, currencyCode: 'GYD' } });
    const stale = await prisma.mmgAgentPayment.create({ data: {
      channel: 'MMG_AGENT_WEBHOOK', externalId: txn, mmgTxnId: txn, sanRaw: san,
      amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'UNMATCHED', failureCode: 'UNFINISHED', raw: {},
    } });
    await prisma.mmgAgentPayment.update({ where: { id: stale.id }, data: { providerPaymentId: held.id } });
    expect(await realIdentityFor.call(svc, stale, stale.channel)).toMatchObject({ conflict: true, payment: { id: held.id } });
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: stale.id } })).providerPaymentId).toBe(held.id);
    await expect(svc.attach(stale.id, sub.id, 'admin-resolver')).rejects.toThrow('PROVIDER_ID_CONFLICT');
    expect(await money(sub.id, [txn])).toEqual({ credits: 0, ledger: 0, observations: 1 });
  });

  it('[AX384] a resolver must retry after the observation changes status, even without a conflict hold', async () => {
    const { sub, san } = await makeVendorSub();
    const txn = txnId();
    const stale = await prisma.mmgAgentPayment.create({ data: {
      channel: 'MMG_AGENT_WEBHOOK', externalId: txn, mmgTxnId: txn, sanRaw: san,
      amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'RECEIVED', raw: {},
    } });
    await prisma.mmgAgentPayment.update({ where: { id: stale.id }, data: { status: 'UNMATCHED', failureCode: 'UNFINISHED' } });
    await expect(realIdentityFor.call(svc, stale, stale.channel)).rejects.toThrow('NOT_RECEIVED');
    expect((await prisma.mmgAgentPayment.findUniqueOrThrow({ where: { id: stale.id } })).providerPaymentId).toBeNull();
    expect(await money(sub.id, [txn])).toEqual({ credits: 0, ledger: 0, observations: 1 });
    expect(await svc.attach(stale.id, sub.id, 'admin-resolver')).toMatchObject({ status: 'accepted' });
    expect(await money(sub.id, [txn])).toEqual({ credits: 1, ledger: 1, observations: 1 });
  });

  it.each(['\u00a0', '\u202f', '\ufeff'])('[AX384] database whitespace includes adapter-trimmed %j so manual and webhook observations share one identity', async (space) => {
    const { sub, san } = await makeVendorSub();
    const core = txnId();
    const raw = `${space}${core}${space}`;
    externalIds.push(raw, `MANUAL:${core}`);
    providerTxnIds.push(raw.toUpperCase());
    expect(await svc.ingest(webhookPayment(raw, san))).toMatchObject({ status: 'accepted' });
    // The portal and CSV adapters trim receipt strings before ingestion.
    expect(await svc.ingest(manualPayment(raw.trim(), san, 'admin-portal'))).toMatchObject({ status: 'reconciled' });
    expect(await money(sub.id, [raw, `MANUAL:${core}`])).toEqual({ credits: 1, ledger: 1, observations: 2 });
  });

});

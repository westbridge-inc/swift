import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { agentCashRoutes } from '../modules/billing/agent-cash.routes';
import { AgentCashService } from '../modules/billing/agent-cash.service';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { importSettlementCsv } from '../modules/billing/settlement-import';
import { ensureSan } from '../modules/billing/san.service';

// Channels A/A'/B [san spec 4.1-4.3] — built dark, proven now: HMAC + raw-body
// auth law (401 ONLY for signatures; unknown SANs are 200 received_unmatched),
// the inquiry masking law, settlement import idempotency, and scenario G
// (webhook + file = one credit).

const SECRET = 'test-agent-cash-secret-0123456789';
const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });

let app: FastifyInstance;
let svc: AgentCashService;
const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
const externalIds: string[] = [];
let seq = 0;
const phoneBase = 592_007_000_000 + Math.floor(Math.random() * 8_000_000);

async function makeVendorSub() {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Chan', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Shanta Kitchen ${seq}`, slug: `chan-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 700_000 + seq}`,
      addressLine1: '9 Inquiry St', city: 'Georgetown', region: 'Demerara-Mahaica',
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
  return { sub, san, vendor };
}

function signed(body: unknown, over: { ts?: number; sig?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = over.ts ?? Date.now();
  const sig = over.sig ?? createHmac('sha256', SECRET).update(`${ts}.`).update(Buffer.from(raw)).digest('hex');
  return {
    method: 'POST' as const,
    payload: raw,
    headers: { 'content-type': 'application/json', 'x-swift-timestamp': String(ts), 'x-swift-signature': sig },
  };
}

const notification = (san: string, over: Record<string, unknown> = {}) => {
  const transactionId = `WH-${nanoid(10)}`;
  externalIds.push(transactionId);
  return { transactionId, accountNumber: san, amount: 2100, currency: 'GYD', ...over };
};

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

  const billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
  svc = new AgentCashService(app.prisma, billing);
});

afterAll(async () => {
  delete process.env['AGENT_CASH_WEBHOOK_SECRET'];
  await prisma.mmgAgentPayment.deleteMany({ where: { externalId: { in: externalIds } } });
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

describe('Channel A — webhook auth law', () => {
  it('a correctly signed notification credits and answers accepted', async () => {
    const { sub, san } = await makeVendorSub();
    const res = await app.inject({ url: '/api/v1/billing/mmg/agent-notification', ...signed(notification(san, { payerMsisdn: '+5926009999' })) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'accepted' });
    const topups = await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } });
    expect(topups).toBe(1);
  });

  it('replays answer duplicate; bad signature and stale timestamp are the ONLY 401s; unknown SAN is still 200', async () => {
    const { san } = await makeVendorSub();
    const body = notification(san);
    const first = await app.inject({ url: '/api/v1/billing/mmg/agent-notification', ...signed(body) });
    expect(first.json().status).toBe('accepted');
    const replay = await app.inject({ url: '/api/v1/billing/mmg/agent-notification', ...signed(body) });
    expect(replay.json().status).toBe('duplicate');

    const badSig = await app.inject({ url: '/api/v1/billing/mmg/agent-notification', ...signed(notification(san), { sig: 'deadbeef'.repeat(8) }) });
    expect(badSig.statusCode).toBe(401);
    const stale = await app.inject({ url: '/api/v1/billing/mmg/agent-notification', ...signed(notification(san), { ts: Date.now() - 10 * 60_000 }) });
    expect(stale.statusCode).toBe(401);

    // The money law: an unknown account is NOT an auth failure — record it.
    const unknown = await app.inject({ url: '/api/v1/billing/mmg/agent-notification', ...signed(notification('4729058836')) });
    expect(unknown.statusCode).toBe(200);
    expect(['received_unmatched', 'accepted']).toContain(unknown.json().status);
  });

  it('without the secret the channel answers 503 channel_disabled (built first, enabled last)', async () => {
    const saved = process.env['AGENT_CASH_WEBHOOK_SECRET'];
    delete process.env['AGENT_CASH_WEBHOOK_SECRET'];
    try {
      const { san } = await makeVendorSub();
      const res = await app.inject({ url: '/api/v1/billing/mmg/agent-notification', ...signed(notification(san)) });
      expect(res.statusCode).toBe(503);
    } finally {
      process.env['AGENT_CASH_WEBHOOK_SECRET'] = saved;
    }
  });
});

describe("Channel A' — inquiry, the typo-killer", () => {
  it('masks the holder (first letter + bullets + city) and quotes the amount due', async () => {
    const { san } = await makeVendorSub();
    const res = await app.inject({ url: '/api/v1/billing/mmg/inquiry', ...signed({ accountNumber: san }) });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.valid).toBe(true);
    expect(data.displayName).toMatch(/^S•+ \(Georgetown\)$/); // never the name
    expect(data.displayName).not.toContain('hanta');
    expect(data.weeklyFeeGyd).toBe('2100.00');
    expect(data.amountDueGyd).toBe('2100.00');
  });

  it('rejects checksum failures BEFORE any cash is taken', async () => {
    const { san } = await makeVendorSub();
    const wrong = san.slice(0, 9) + String((Number(san[9]) + 1) % 10);
    const res = await app.inject({ url: '/api/v1/billing/mmg/inquiry', ...signed({ accountNumber: wrong }) });
    expect(res.json()).toMatchObject({ valid: false, reason: 'SAN_CHECKSUM_FAILED' });
  });
});

describe('Channel B — settlement import + scenario G', () => {
  it('imports a file, re-import is a zero-credit no-op, trailer mismatch is flagged', async () => {
    const { sub, san } = await makeVendorSub();
    const t1 = `SF-${nanoid(8)}`;
    const t2 = `SF-${nanoid(8)}`;
    externalIds.push(t1, t2);
    const csv = [
      'transaction_id,account_number,amount,paid_at',
      `${t1},${san},2100,2026-08-01T10:00:00Z`,
      `${t2},"${san.slice(0, 3)}-${san.slice(3, 6)}-${san.slice(6)}",1000,2026-08-01T11:00:00Z`,
      'TOTAL,9999',
    ].join('\n');

    const report = await importSettlementCsv(prisma, svc, csv, { source: 'test-file-1' });
    expect(report.fileRows).toBe(2);
    expect(report.credited).toBe(2);
    expect(report.trailerTotalGyd).toBe(9999);
    expect(report.trailerMismatch).toBe(true); // 3100 ≠ 9999 — the file disagrees with itself

    const again = await importSettlementCsv(prisma, svc, csv, { source: 'test-file-1-reimport' });
    expect(again.credited).toBe(0);
    expect(again.duplicates).toBe(2);
    const topups = await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } });
    expect(topups).toBe(2);
  });

  it('scenario G: webhook first, then the same mmgTxnId in a file → RECONCILED, one credit', async () => {
    const { sub, san } = await makeVendorSub();
    const txn = `XC-${nanoid(8)}`;
    externalIds.push(txn);
    const wh = await app.inject({ url: '/api/v1/billing/mmg/agent-notification', ...signed({ transactionId: txn, accountNumber: san, amount: 2100, currency: 'GYD' }) });
    expect(wh.json().status).toBe('accepted');

    const csv = ['transaction_id,account_number,amount', `${txn},${san},2100`].join('\n');
    const report = await importSettlementCsv(prisma, svc, csv, { source: 'test-xc' });
    expect(report.reconciled).toBe(1);
    expect(report.credited).toBe(0);
    const topups = await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'PREPAID_TOPUP' } });
    expect(topups).toBe(1);
  });

  it('unparseable rows are reported, never silently skipped', async () => {
    const csv = ['transaction_id,account_number,amount', ',4729058836,2100', `BAD-${nanoid(6)},,abc`].join('\n');
    const report = await importSettlementCsv(prisma, svc, csv, { source: 'test-bad' });
    expect(report.rejectedRows).toHaveLength(2);
    expect(report.fileRows).toBe(2);
  });
});

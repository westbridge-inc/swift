import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { AgentCashService } from '../modules/billing/agent-cash.service';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { importSettlementCsv, publishSettlementImport, parseSettlementCsv, scanSettlementImports, settlementFileHash, DEFAULT_HEADER_MAP, resumeInterruptedSettlementImports, PUBLICATION_LEASE_MS } from '../modules/billing/settlement-import';
import { ensureSan } from '../modules/billing/san.service';

// ---------------------------------------------------------------------------
// [M-20 · S0] No row of a settlement file publishes money until the whole file
// is validated.
//
// Before, rows were credited one by one inside the parse loop and the control
// total was checked only at the end: a truncated, tampered, malformed or
// wrong-total file had already credited what it managed to parse, and a
// retry compounded it. Now the file is hashed and staged, strictly parsed,
// validated in full, published by one winner, and every outcome is recorded
// on the batch — or the batch is rejected with zero credits and zero ledger
// entries.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
let app: FastifyInstance;
let svc: AgentCashService;
const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
const externalIds: string[] = [];
let seq = 0;
const phoneBase = 592_010_000_000 + Math.floor(Math.random() * 8_000_000);

async function makeVendorSub() {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Staged', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Staged Kitchen ${seq}`, slug: `staged-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 700_000 + seq}`,
      addressLine1: '20 Batch St', city: 'Georgetown', region: 'Demerara-Mahaica',
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
const txn = () => { const id = `ST-${nanoid(8)}`; externalIds.push(id); return id; };
const HEADER = 'transaction_id,account_number,amount,paid_at';
const file = (lines: string[]) => [HEADER, ...lines].join('\n');
async function money(subscriptionId: string) {
  const topups = await prisma.billingEvent.findMany({ where: { subscriptionId, type: 'PREPAID_TOPUP' }, select: { idempotencyKey: true } });
  return {
    credits: topups.length,
    ledger: await prisma.ledgerTransaction.count({ where: { idempotencyKey: { in: topups.map((t) => `ledger:${t.idempotencyKey}`) } } }),
    observations: await prisma.mmgAgentPayment.count({ where: { subscriptionId, channel: 'MMG_SETTLEMENT_FILE' } }),
  };
}

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

afterEach(() => { delete process.env['SETTLEMENT_PUBLISH_KILL']; });

afterAll(async () => {
  delete process.env['SETTLEMENT_PUBLISH_KILL'];
  await prisma.settlementImport.deleteMany({ where: { source: { startsWith: 'staged-test' } } });
  await prisma.mmgAgentPayment.deleteMany({ where: { externalId: { in: externalIds } } });
  await prisma.providerPayment.deleteMany({ where: { providerTxnId: { in: externalIds.map((e) => e.toUpperCase()) } } });
  await prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
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

describe('[M-20] the register’s red test: every invalid batch creates zero credits and zero ledger entries', () => {
  const cases: Array<{ name: string; reason: string; lines: (san: string) => string[] }> = [
    { name: 'control-total mismatch', reason: 'CONTROL_TOTAL_MISMATCH', lines: (san) => [`${txn()},${san},2100,2026-08-01T10:00:00Z`, `${txn()},${san},1000,2026-08-01T11:00:00Z`, 'TOTAL,9999'] },
    { name: 'malformed quoting', reason: 'MALFORMED_QUOTING', lines: (san) => [`${txn()},${san},2100,2026-08-01T10:00:00Z`, `${txn()},"${san},1000,2026-08-01T11:00:00Z`] },
    { name: 'wrong column count', reason: 'COLUMN_COUNT', lines: (san) => [`${txn()},${san},2100,2026-08-01T10:00:00Z`, `${txn()},${san},1000`] },
    { name: 'unreadable date', reason: 'DATE_UNREADABLE', lines: (san) => [`${txn()},${san},2100,2026-08-01T10:00:00Z`, `${txn()},${san},1000,yesterday-ish`] },
    { name: 'duplicate provider id inside the file', reason: 'DUPLICATE_TXN_ID_IN_FILE', lines: (san) => { const id = txn(); return [`${id},${san},2100,2026-08-01T10:00:00Z`, `${id},${san},2100,2026-08-01T10:00:00Z`]; } },
    { name: 'row-count trailer disagrees', reason: 'ROW_COUNT_MISMATCH', lines: (san) => [`${txn()},${san},2100,2026-08-01T10:00:00Z`, 'ROWCOUNT,3'] },
  ];
  for (const c of cases) {
    it(`${c.name} → the whole file is rejected, the good rows too`, async () => {
      const { sub, san } = await makeVendorSub();
      const report = await importSettlementCsv(prisma, svc, file(c.lines(san)), { source: `staged-test-${c.reason}` });
      expect(report.status).toBe('REJECTED');
      expect(report.credited).toBe(0);
      expect(report.rejectedRows.some((r) => r.reason.startsWith(c.reason))).toBe(true);
      expect(await money(sub.id)).toEqual({ credits: 0, ledger: 0, observations: 0 });
      const staged = await prisma.settlementImport.findUniqueOrThrow({ where: { id: report.importId } });
      expect(staged.status).toBe('REJECTED');
    });
  }
});

describe('[M-20] a valid file publishes once, by one winner, with every outcome recorded', () => {
  it('a file with a matching control total and row count credits every row exactly once; the same file again is the same import', async () => {
    const { sub, san } = await makeVendorSub();
    const csv = file([`${txn()},${san},2100,2026-08-01T10:00:00Z`, `${txn()},${san},1000,2026-08-01T11:00:00Z`, 'TOTAL,3100', 'ROWCOUNT,2']);
    const report = await importSettlementCsv(prisma, svc, csv, { source: 'staged-test-good' });
    expect(report).toMatchObject({ status: 'PUBLISHED', fileRows: 2, credited: 2, totalGyd: 3100, trailerTotalGyd: 3100, trailerMismatch: false, replayed: false });
    expect(await money(sub.id)).toEqual({ credits: 2, ledger: 2, observations: 2 });
    const stored = await prisma.settlementImport.findUniqueOrThrow({ where: { id: report.importId } });
    expect(stored.status).toBe('PUBLISHED');
    expect((stored.results as Array<{ status: string }>).map((r) => r.status)).toEqual(['accepted', 'accepted']);
    expect(stored.fileHash).toBe(settlementFileHash(csv));
    const again = await importSettlementCsv(prisma, svc, csv, { source: 'staged-test-good-again' });
    expect(again).toMatchObject({ importId: report.importId, replayed: true, credited: 0, duplicates: 2 });
    expect(await money(sub.id)).toEqual({ credits: 2, ledger: 2, observations: 2 });
  });

  it('publication is one compare-and-set: two publishers of a staged import credit its rows once', async () => {
    const { sub, san } = await makeVendorSub();
    process.env['SETTLEMENT_PUBLISH_KILL'] = '1';
    const held = await importSettlementCsv(prisma, svc, file([`${txn()},${san},2100,2026-08-01T10:00:00Z`, 'TOTAL,2100']), { source: 'staged-test-race' });
    expect(held.status).toBe('HELD');
    expect(await money(sub.id)).toEqual({ credits: 0, ledger: 0, observations: 0 });
    delete process.env['SETTLEMENT_PUBLISH_KILL'];
    const [a, b] = await Promise.all([publishSettlementImport(prisma, svc, held.importId), publishSettlementImport(prisma, svc, held.importId)]);
    expect([a.credited, b.credited].sort()).toEqual([0, 1]);
    // The loser did not run the rows at all — it answered the winner's import.
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await money(sub.id)).toEqual({ credits: 1, ledger: 1, observations: 1 });
  });

  it('the publication hold stages and validates but credits nothing; releasing it publishes', async () => {
    const { sub, san } = await makeVendorSub();
    process.env['SETTLEMENT_PUBLISH_KILL'] = '1';
    const held = await importSettlementCsv(prisma, svc, file([`${txn()},${san},2100,2026-08-01T10:00:00Z`]), { source: 'staged-test-hold' });
    expect(held.status).toBe('HELD');
    expect((await prisma.settlementImport.findUniqueOrThrow({ where: { id: held.importId } })).status).toBe('STAGED');
    expect(await money(sub.id)).toEqual({ credits: 0, ledger: 0, observations: 0 });
    delete process.env['SETTLEMENT_PUBLISH_KILL'];
    const released = await publishSettlementImport(prisma, svc, held.importId);
    expect(released).toMatchObject({ status: 'PUBLISHED', credited: 1 });
    expect(await money(sub.id)).toEqual({ credits: 1, ledger: 1, observations: 1 });
  });

  it('the parser is pure and strict: it names every reason with its line', () => {
    const parsed = parseSettlementCsv(file(['A1,4729058836,2100,2026-08-01T10:00:00Z', 'A2,4729058836,-5,2026-08-01T10:00:00Z', 'A1,4729058836,2100,2026-08-01T10:00:00Z', 'TOTAL,2100']), DEFAULT_HEADER_MAP);
    expect(parsed.rows.map((r) => r.txnId)).toEqual(['A1']);
    expect(parsed.rejections.map((r) => `${r.line}:${r.reason.split(':')[0]}`)).toEqual(['3:AMOUNT_NOT_POSITIVE', '4:DUPLICATE_TXN_ID_IN_FILE']);
    expect(parseSettlementCsv('transaction_id,amount\nx,1', DEFAULT_HEADER_MAP).rejections[0]?.reason).toMatch(/HEADERS_UNRECOGNIZED/);
  });
});

describe('[M-20 · operations] the scan', () => {
  it('finds a rejected file whose provider id nonetheless credited by another path, and a published import that does not balance', async () => {
    const { sub, san } = await makeVendorSub();
    const id = txn();
    // The rejected file's id was credited by the webhook channel meanwhile.
    const rejected = await importSettlementCsv(prisma, svc, file([`${id},${san},2100,2026-08-01T10:00:00Z`, 'TOTAL,1']), { source: 'staged-test-scan-rejected' });
    expect(rejected.status).toBe('REJECTED');
    await prisma.mmgAgentPayment.create({ data: { channel: 'MMG_SETTLEMENT_FILE', externalId: id, mmgTxnId: id, sanRaw: san, amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'MATCHED', subscriptionId: sub.id, raw: {} } });
    // A published import whose results lost a row.
    const good = await importSettlementCsv(prisma, svc, file([`${txn()},${san},2100,2026-08-01T10:00:00Z`, 'TOTAL,2100']), { source: 'staged-test-scan-unbalanced' });
    expect(good.status).toBe('PUBLISHED');
    await prisma.settlementImport.update({ where: { id: good.importId }, data: { results: [] } });
    const scan = await scanSettlementImports(prisma);
    expect(scan.rejectedButCredited).toContain(rejected.importId);
    expect(scan.unbalanced).toContain(good.importId);
  });
});

describe('[G5-F6 · operations] the repair pass finishes a publication that stopped part-way', () => {
  const realIngest = AgentCashService.prototype.ingest;
  /** Publish `csv` with its second row dying before the ingest runs; the
   *  publisher fails and marks the import INTERRUPTED. */
  async function interrupted(csv: string, source: string): Promise<string> {
    let calls = 0;
    const outage = vi.spyOn(AgentCashService.prototype, 'ingest').mockImplementation(async function (this: AgentCashService, ...args: Parameters<AgentCashService['ingest']>) {
      calls += 1;
      if (calls === 2) throw new Error('Connection terminated unexpectedly');
      return realIngest.apply(this, args);
    });
    try {
      await expect(importSettlementCsv(prisma, svc, csv, { source })).rejects.toThrow('Connection terminated unexpectedly');
    } finally {
      outage.mockRestore();
    }
    return (await prisma.settlementImport.findUniqueOrThrow({ where: { tenantId_fileHash: { tenantId: 'swift-default', fileHash: settlementFileHash(csv) } } })).id;
  }
  const silentPastTheLease = () => new Date(Date.now() - PUBLICATION_LEASE_MS - 60_000);

  it('a publisher killed mid-file says nothing and falls silent: once its lease lapses the pass finishes it, every row once, and the scan stops naming it', async () => {
    const { sub, san } = await makeVendorSub();
    const csv = file([`${txn()},${san},2100,2026-08-01T10:00:00Z`, `${txn()},${san},1000,2026-08-01T11:00:00Z`, 'TOTAL,3100', 'ROWCOUNT,2']);
    const id = await interrupted(csv, 'staged-test-g5f6-killed');
    // What a killed process leaves: no word, PUBLISHING, a heartbeat gone quiet.
    await prisma.settlementImport.update({ where: { id }, data: { status: 'PUBLISHING', updatedAt: silentPastTheLease() } });
    expect(await money(sub.id)).toEqual({ credits: 1, ledger: 1, observations: 1 });
    expect((await scanSettlementImports(prisma)).stuck).toContain(id);

    expect(await resumeInterruptedSettlementImports(prisma, svc, { importIds: [id] })).toEqual({ resumed: [id], failed: [] });
    const done = await prisma.settlementImport.findUniqueOrThrow({ where: { id } });
    expect({ status: done.status, credited: done.credited, results: (done.results as Array<{ status: string }>).map((r) => r.status) })
      .toEqual({ status: 'PUBLISHED', credited: 2, results: ['accepted', 'accepted'] });
    expect(await money(sub.id)).toEqual({ credits: 2, ledger: 2, observations: 2 });
    expect((await scanSettlementImports(prisma)).stuck).not.toContain(id);
    // A second pass has nothing to do and moves nothing.
    expect(await resumeInterruptedSettlementImports(prisma, svc, { importIds: [id] })).toEqual({ resumed: [], failed: [] });
    expect(await money(sub.id)).toEqual({ credits: 2, ledger: 2, observations: 2 });
  });

  it('a live publication is never taken over: while its heartbeat is fresh the pass and a re-import of its file leave it to its publisher', async () => {
    const { sub, san } = await makeVendorSub();
    const csv = file([`${txn()},${san},2100,2026-08-01T10:00:00Z`, 'TOTAL,2100']);
    process.env['SETTLEMENT_PUBLISH_KILL'] = '1';
    const held = await importSettlementCsv(prisma, svc, csv, { source: 'staged-test-g5f6-live' });
    delete process.env['SETTLEMENT_PUBLISH_KILL'];
    // A publisher has just claimed it and is at work.
    expect((await prisma.settlementImport.updateMany({ where: { id: held.importId, status: 'STAGED' }, data: { status: 'PUBLISHING' } })).count).toBe(1);

    expect(await resumeInterruptedSettlementImports(prisma, svc, { importIds: [held.importId] })).toEqual({ resumed: [], failed: [] });
    const again = await importSettlementCsv(prisma, svc, csv, { source: 'staged-test-g5f6-live-again' });
    expect(again).toMatchObject({ importId: held.importId, status: 'PUBLISHING', replayed: true, credited: 0, duplicates: 0 });
    expect(await money(sub.id)).toEqual({ credits: 0, ledger: 0, observations: 0 });
    expect((await scanSettlementImports(prisma)).stuck).not.toContain(held.importId);

    // Silent past the lease, it has died: now the pass finishes it.
    await prisma.settlementImport.update({ where: { id: held.importId }, data: { updatedAt: silentPastTheLease() } });
    expect(await resumeInterruptedSettlementImports(prisma, svc, { importIds: [held.importId] })).toEqual({ resumed: [held.importId], failed: [] });
    expect((await prisma.settlementImport.findUniqueOrThrow({ where: { id: held.importId } })).status).toBe('PUBLISHED');
    expect(await money(sub.id)).toEqual({ credits: 1, ledger: 1, observations: 1 });
  });

  it('while publication is held an interrupted import waits: the pass and a re-import credit nothing and the scan names it; lifted, the pass finishes it', async () => {
    const { sub, san } = await makeVendorSub();
    const csv = file([`${txn()},${san},2100,2026-08-01T10:00:00Z`, `${txn()},${san},1000,2026-08-01T11:00:00Z`, 'TOTAL,3100']);
    const id = await interrupted(csv, 'staged-test-g5f6-held');
    expect((await prisma.settlementImport.findUniqueOrThrow({ where: { id } })).status).toBe('INTERRUPTED');

    process.env['SETTLEMENT_PUBLISH_KILL'] = '1';
    expect(await resumeInterruptedSettlementImports(prisma, svc, { importIds: [id] })).toEqual({ resumed: [], failed: [] });
    expect(await importSettlementCsv(prisma, svc, csv, { source: 'staged-test-g5f6-held-again' })).toMatchObject({ importId: id, status: 'HELD', credited: 0 });
    expect(await money(sub.id)).toEqual({ credits: 1, ledger: 1, observations: 1 });
    expect((await scanSettlementImports(prisma)).stuck).toContain(id);

    delete process.env['SETTLEMENT_PUBLISH_KILL'];
    expect(await resumeInterruptedSettlementImports(prisma, svc, { importIds: [id] })).toEqual({ resumed: [id], failed: [] });
    expect((await prisma.settlementImport.findUniqueOrThrow({ where: { id } })).status).toBe('PUBLISHED');
    expect(await money(sub.id)).toEqual({ credits: 2, ledger: 2, observations: 2 });
  });
});

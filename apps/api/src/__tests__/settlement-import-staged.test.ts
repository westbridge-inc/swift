import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma, PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { AgentCashService } from '../modules/billing/agent-cash.service';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { importSettlementCsv, publishSettlementImport, parseSettlementCsv, scanSettlementImports, settlementFileHash, DEFAULT_HEADER_MAP, resumeInterruptedSettlementImports, PUBLICATION_LEASE_MS, PUBLICATION_RETRY_BACKOFF_MS } from '../modules/billing/settlement-import';
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

afterEach(() => {
  delete process.env['SETTLEMENT_PUBLISH_KILL'];
  delete process.env['SETTLEMENT_PUBLICATION_LEASE_MS'];
});

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
  /** The lease runs on the database clock [AX314-F2], so a test ages it there. */
  const dbNow = async () => (await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`)[0]!.now;
  const quietFor = async (id: string, ms: number, status?: 'PUBLISHING' | 'INTERRUPTED') => {
    const now = await dbNow();
    await prisma.settlementImport.update({ where: { id }, data: { updatedAt: new Date(now.getTime() - ms), ...(status ? { status } : {}) } });
  };
  /** Time passes for these imports, their order kept. */
  const shiftBack = (ids: string[], ms: number) =>
    prisma.$executeRaw`UPDATE "settlement_imports" SET "updatedAt" = "updatedAt" - (${ms} * INTERVAL '1 millisecond') WHERE "id" IN (${Prisma.join(ids)})`;
  const SILENT = PUBLICATION_LEASE_MS + 60_000;

  it('a publisher killed mid-file says nothing and falls silent: once its lease lapses the pass finishes it, every row once, and the scan stops naming it', async () => {
    const { sub, san } = await makeVendorSub();
    const csv = file([`${txn()},${san},2100,2026-08-01T10:00:00Z`, `${txn()},${san},1000,2026-08-01T11:00:00Z`, 'TOTAL,3100', 'ROWCOUNT,2']);
    const id = await interrupted(csv, 'staged-test-g5f6-killed');
    // What a killed process leaves: no word, PUBLISHING, a heartbeat gone quiet.
    await quietFor(id, SILENT, 'PUBLISHING');
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
    await quietFor(held.importId, SILENT);
    expect(await resumeInterruptedSettlementImports(prisma, svc, { importIds: [held.importId] })).toEqual({ resumed: [held.importId], failed: [] });
    expect((await prisma.settlementImport.findUniqueOrThrow({ where: { id: held.importId } })).status).toBe('PUBLISHED');
    expect(await money(sub.id)).toEqual({ credits: 1, ledger: 1, observations: 1 });
  });

  it('while publication is held an interrupted import waits: the pass and a re-import credit nothing and the scan names it; lifted, the pass finishes it', async () => {
    const { sub, san } = await makeVendorSub();
    const csv = file([`${txn()},${san},2100,2026-08-01T10:00:00Z`, `${txn()},${san},1000,2026-08-01T11:00:00Z`, 'TOTAL,3100']);
    const id = await interrupted(csv, 'staged-test-g5f6-held');
    expect((await prisma.settlementImport.findUniqueOrThrow({ where: { id } })).status).toBe('INTERRUPTED');
    // Past its retry backoff, so only the hold keeps the pass away.
    await quietFor(id, PUBLICATION_RETRY_BACKOFF_MS + 60_000);

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

  // ── AX314: fencing, the database clock, fair repair ──────────────────────
  const realCredit = AgentCashService.prototype.credit;
  /** A door a row's credit waits at, until the test opens it. */
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
  /** Stage (held) a three-row file; publication starts when the test says. */
  async function stagedThreeRows(label: string) {
    const { sub, san } = await makeVendorSub();
    const csv = file([`${txn()},${san},2100,2026-08-01T10:00:00Z`, `${txn()},${san},1000,2026-08-01T11:00:00Z`, `${txn()},${san},700,2026-08-01T12:00:00Z`, 'TOTAL,3800', 'ROWCOUNT,3']);
    process.env['SETTLEMENT_PUBLISH_KILL'] = '1';
    const held = await importSettlementCsv(prisma, svc, csv, { source: `staged-test-g5f6-${label}` });
    delete process.env['SETTLEMENT_PUBLISH_KILL'];
    return { sub, importId: held.importId };
  }

  // Publisher A stops at row 2's credit, its observation persisted; it stays
  // silent past its lease and B takes the import over; then A wakes. The
  // credit calls, in order: A row 1 (1), A row 2 (2), then B's rows.
  const interleavings = [
    { name: 'A wakes while B is about to credit the same row', aDoor: 2, bDoor: 3 },
    { name: 'A wakes after B credited that row, while B is still at work', aDoor: 2, bDoor: 4 },
  ];
  for (const { name, aDoor, bDoor } of interleavings) {
    it(`[AX314-F1] a publisher paused past its lease is fenced out when it wakes (${name}): it stops cleanly and marks nothing, the owner finishes, every row once`, async () => {
      const { sub, importId } = await stagedThreeRows(`fenced-${bDoor}`);
      const doors = new Map([[aDoor, door()], [bDoor, door()]]);
      let calls = 0;
      const paused = vi.spyOn(AgentCashService.prototype, 'credit').mockImplementation(async function (this: AgentCashService, ...args: Parameters<AgentCashService['credit']>) {
        const d = doors.get((calls += 1));
        if (d) { d.reached(); await d.opened; }
        return realCredit.apply(this, args);
      });
      try {
        const a = publishSettlementImport(prisma, svc, importId);
        a.catch(() => undefined); // awaited below; a failed run must not leave it unhandled
        await within(doors.get(aDoor)!.isReached);
        await quietFor(importId, SILENT); // A is silent past its lease
        const b = publishSettlementImport(prisma, svc, importId);
        b.catch(() => undefined);
        await within(doors.get(bDoor)!.isReached);
        doors.get(aDoor)!.open(); // A wakes
        const aDone = await within(a);
        expect(aDone).toMatchObject({ importId, replayed: true, credited: 0 });
        // B still owns it: A marked nothing.
        expect((await prisma.settlementImport.findUniqueOrThrow({ where: { id: importId } })).status).toBe('PUBLISHING');
        doors.get(bDoor)!.open();
        expect(await within(b)).toMatchObject({ importId, status: 'PUBLISHED', replayed: false, credited: 3 });
      } finally {
        // Nothing left paused and nothing left spied on, even when it failed.
        for (const d of doors.values()) d.open();
        paused.mockRestore();
      }
      const done = await prisma.settlementImport.findUniqueOrThrow({ where: { id: importId } });
      expect({ status: done.status, credited: done.credited, results: (done.results as Array<{ status: string }>).map((r) => r.status) })
        .toEqual({ status: 'PUBLISHED', credited: 3, results: ['accepted', 'accepted', 'accepted'] });
      expect(await money(sub.id)).toEqual({ credits: 3, ledger: 3, observations: 3 });
    });
  }

  it('[AX314-F2] the lease is read on the database clock: this server 10 minutes AHEAD still leaves a live publication alone; 10 minutes BEHIND, it still takes over a dead one', async () => {
    const { sub, san } = await makeVendorSub();
    const liveCsv = file([`${txn()},${san},2100,2026-08-01T10:00:00Z`, 'TOTAL,2100']);
    const deadCsv = file([`${txn()},${san},1000,2026-08-01T11:00:00Z`, 'TOTAL,1000']);
    process.env['SETTLEMENT_PUBLISH_KILL'] = '1';
    const live = await importSettlementCsv(prisma, svc, liveCsv, { source: 'staged-test-g5f6-skew-live' });
    const dead = await importSettlementCsv(prisma, svc, deadCsv, { source: 'staged-test-g5f6-skew-dead' });
    delete process.env['SETTLEMENT_PUBLISH_KILL'];
    await quietFor(live.importId, 0, 'PUBLISHING'); // its publisher wrote its heartbeat just now
    await quietFor(dead.importId, SILENT, 'PUBLISHING'); // its publisher went quiet six minutes ago
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 10 * 60_000);
      expect(await resumeInterruptedSettlementImports(prisma, svc, { importIds: [live.importId] })).toEqual({ resumed: [], failed: [] });
      expect(await importSettlementCsv(prisma, svc, liveCsv, { source: 'staged-test-g5f6-skew-live-again' })).toMatchObject({ importId: live.importId, status: 'PUBLISHING', replayed: true, credited: 0 });
      vi.setSystemTime(Date.now() - 20 * 60_000);
      expect(await resumeInterruptedSettlementImports(prisma, svc, { importIds: [dead.importId] })).toEqual({ resumed: [dead.importId], failed: [] });
    } finally {
      vi.useRealTimers();
    }
    expect((await prisma.settlementImport.findUniqueOrThrow({ where: { id: live.importId } })).status).toBe('PUBLISHING');
    expect((await prisma.settlementImport.findUniqueOrThrow({ where: { id: dead.importId } })).status).toBe('PUBLISHED');
    expect(await money(sub.id)).toEqual({ credits: 1, ledger: 1, observations: 1 });
  });

  /** Interrupt one-row files, oldest first; the rows listed in `broken` fail
   *  on every later attempt too. */
  async function interruptedOneRowFiles(label: string, san: string, count: number, broken: Set<string>) {
    let outage = true;
    const failing = vi.spyOn(AgentCashService.prototype, 'ingest').mockImplementation(async function (this: AgentCashService, ...args: Parameters<AgentCashService['ingest']>) {
      if (outage || broken.has(args[0].externalId)) throw new Error('WALLET_CURRENCY_MISMATCH');
      return realIngest.apply(this, args);
    });
    const ids: string[] = [];
    const txns: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const t = txn();
      txns.push(t);
      const csv = file([`${t},${san},${1000 + i},2026-08-01T10:00:00Z`, `TOTAL,${1000 + i}`]);
      await expect(importSettlementCsv(prisma, svc, csv, { source: `staged-test-g5f6-${label}-${i}` })).rejects.toThrow('WALLET_CURRENCY_MISMATCH');
      ids.push((await prisma.settlementImport.findUniqueOrThrow({ where: { tenantId_fileHash: { tenantId: 'swift-default', fileHash: settlementFileHash(csv) } } })).id);
    }
    outage = false;
    return { ids, txns, failing };
  }

  it('[AX314-F3] the repair pass is fair: twenty imports that fail every time cannot starve the twenty-first — least recently attempted goes first', async () => {
    const { sub, san } = await makeVendorSub();
    const broken = new Set<string>();
    const { ids, txns, failing } = await interruptedOneRowFiles('fair', san, 21, broken);
    try {
      txns.slice(0, 20).forEach((t) => broken.add(t)); // twenty of them fail on every attempt
      // All stopped long enough ago; the twenty before the twenty-first.
      for (const [i, id] of ids.entries()) await quietFor(id, PUBLICATION_RETRY_BACKOFF_MS + (ids.length - i) * 60_000);
      const first = await resumeInterruptedSettlementImports(prisma, svc, { importIds: ids, limit: 20 });
      expect({ resumed: first.resumed, failed: [...first.failed].sort() }).toEqual({ resumed: [], failed: ids.slice(0, 20).sort() });
      // Time passes for all of them, beyond the backoff; the twenty-first is now the least recently attempted.
      await shiftBack(ids, PUBLICATION_RETRY_BACKOFF_MS + 60_000);
      const second = await resumeInterruptedSettlementImports(prisma, svc, { importIds: ids, limit: 20 });
      expect(second.resumed).toEqual([ids[20]]);
    } finally {
      failing.mockRestore();
    }
    expect((await prisma.settlementImport.findUniqueOrThrow({ where: { id: ids[20]! } })).status).toBe('PUBLISHED');
    expect(await money(sub.id)).toEqual({ credits: 1, ledger: 1, observations: 1 });
  });

  it('[AX314-F3] an import whose resume just failed is left alone for the backoff, then tried again', async () => {
    const { san } = await makeVendorSub();
    const broken = new Set<string>();
    const { ids: [id], txns, failing } = await interruptedOneRowFiles('backoff', san, 1, broken);
    try {
      broken.add(txns[0]!);
      await quietFor(id!, PUBLICATION_RETRY_BACKOFF_MS + 60_000);
      expect(await resumeInterruptedSettlementImports(prisma, svc, { importIds: [id!] })).toEqual({ resumed: [], failed: [id] });
      expect(await resumeInterruptedSettlementImports(prisma, svc, { importIds: [id!] })).toEqual({ resumed: [], failed: [] });
      await shiftBack([id!], PUBLICATION_RETRY_BACKOFF_MS + 60_000);
      expect(await resumeInterruptedSettlementImports(prisma, svc, { importIds: [id!] })).toEqual({ resumed: [], failed: [id] });
    } finally {
      failing.mockRestore();
    }
    expect((await prisma.settlementImport.findUniqueOrThrow({ where: { id: id! } })).status).toBe('INTERRUPTED');
  });

  // ── AX337-F2: every lease write judges and stamps itself on the database clock
  /** A lease short enough to lapse inside a test (heartbeat: a quarter of it). */
  const TEST_LEASE_MS = 3_000;
  /** Wait until `since` is older than the lease, on the database clock. */
  const untilLapsed = async (since: Date) => {
    const deadline = Date.now() + 15_000;
    while ((await dbNow()).getTime() - since.getTime() <= TEST_LEASE_MS + 250) {
      if (Date.now() > deadline) throw new Error('the lease never lapsed on the database clock');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  it('[AX337-F2] a publisher paused past its lease wakes to a refused heartbeat: it stops cleanly and stamps nothing, and the repair pass finishes the file, every row once', async () => {
    process.env['SETTLEMENT_PUBLICATION_LEASE_MS'] = String(TEST_LEASE_MS);
    const { sub, importId } = await stagedThreeRows('paused-heartbeat');
    const stall = door();
    let calls = 0;
    // Row 1 is credited; then the publisher stalls (a long pause, a frozen
    // process) before it can write its heartbeat.
    const stalling = vi.spyOn(AgentCashService.prototype, 'ingest').mockImplementation(async function (this: AgentCashService, ...args: Parameters<AgentCashService['ingest']>) {
      const res = await realIngest.apply(this, args);
      if ((calls += 1) === 1) { stall.reached(); await stall.opened; }
      return res;
    });
    try {
      const a = publishSettlementImport(prisma, svc, importId);
      a.catch(() => undefined); // awaited below; a failed run must not leave it unhandled
      await within(stall.isReached);
      const claimed = await prisma.settlementImport.findUniqueOrThrow({ where: { id: importId } });
      expect(claimed.status).toBe('PUBLISHING');
      // Nobody takes it over; its lease simply lapses on the database clock.
      await untilLapsed(claimed.updatedAt);
      stall.open();
      expect(await within(a)).toMatchObject({ importId, replayed: true, credited: 0 });
      // Refused, not stamped with an old time: the import is exactly as the
      // publisher left it when it stalled.
      const after = await prisma.settlementImport.findUniqueOrThrow({ where: { id: importId } });
      expect({ status: after.status, updatedAt: after.updatedAt.toISOString() }).toEqual({ status: 'PUBLISHING', updatedAt: claimed.updatedAt.toISOString() });
    } finally {
      stall.open();
      stalling.mockRestore();
    }
    expect(await money(sub.id)).toEqual({ credits: 1, ledger: 1, observations: 1 });
    // Its lapsed lease is plain to see: the repair pass takes it over and finishes it.
    expect(await resumeInterruptedSettlementImports(prisma, svc, { importIds: [importId] })).toEqual({ resumed: [importId], failed: [] });
    const done = await prisma.settlementImport.findUniqueOrThrow({ where: { id: importId } });
    expect({ status: done.status, credited: done.credited, results: (done.results as Array<{ status: string }>).map((r) => r.status) })
      .toEqual({ status: 'PUBLISHED', credited: 3, results: ['accepted', 'accepted', 'accepted'] });
    expect(await money(sub.id)).toEqual({ credits: 3, ledger: 3, observations: 3 });
  });

  it('[AX337-F2] a live publisher renews its lease with every heartbeat: a file that outlasts the lease finishes under one owner, and the repair pass never takes it over', async () => {
    process.env['SETTLEMENT_PUBLICATION_LEASE_MS'] = String(TEST_LEASE_MS);
    const { sub, importId } = await stagedThreeRows('live-heartbeat');
    let claimedAt: Date | undefined;
    // Every row takes almost half the lease, so the file outlasts it: only
    // the heartbeats keep the lease alive.
    const slow = vi.spyOn(AgentCashService.prototype, 'ingest').mockImplementation(async function (this: AgentCashService, ...args: Parameters<AgentCashService['ingest']>) {
      claimedAt ??= (await prisma.settlementImport.findUniqueOrThrow({ where: { id: importId } })).updatedAt;
      const res = await realIngest.apply(this, args);
      await new Promise((resolve) => setTimeout(resolve, TEST_LEASE_MS * 0.45));
      return res;
    });
    try {
      const a = publishSettlementImport(prisma, svc, importId);
      a.catch(() => undefined);
      await within((async () => { while (!claimedAt) await new Promise((resolve) => setTimeout(resolve, 20)); })());
      // Longer than the lease since the claim, with the publisher still at work.
      await untilLapsed(claimedAt!);
      expect(await resumeInterruptedSettlementImports(prisma, svc, { importIds: [importId] })).toEqual({ resumed: [], failed: [] });
      expect(await within(a)).toMatchObject({ importId, status: 'PUBLISHED', replayed: false, credited: 3 });
    } finally {
      slow.mockRestore();
    }
    expect(await money(sub.id)).toEqual({ credits: 3, ledger: 3, observations: 3 });
  });
});

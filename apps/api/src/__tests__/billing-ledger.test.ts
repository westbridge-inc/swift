import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { postLedger, topupPostings, ensureLedgerAccounts } from '../modules/billing/ledger';
import { runBillingInvariants } from '../modules/billing/invariants';

// ---------------------------------------------------------------------------
// TOLLGATE PART 17 / BE-13 — the double-entry ledger's laws are enforced by
// the DATABASE: unbalanced transactions cannot commit, rows cannot be edited
// or deleted, each entry carries exactly one positive side. Every live credit
// path posts balanced books in the same transaction, and the nightly
// invariant proves wallet == ledger. Raw-SQL objects are invisible to the
// db-push'd CI schema, so beforeAll self-installs them (the established
// pattern — see integrity-foundation.test.ts).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

let app: FastifyInstance;
let billing: BillingService;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdSubIds: string[] = [];
let seq = 0;
const phoneBase = 592_009_100_000 + Math.floor(Math.random() * 800_000);
const run = nanoid(8).toLowerCase();

async function installLedgerLaws() {
  await app.prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_entries_nonneg') THEN
        ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_nonneg" CHECK ("debit" >= 0 AND "credit" >= 0);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_entries_one_side') THEN
        ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_one_side" CHECK (("debit" = 0) <> ("credit" = 0));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prepaid_balance_nonneg') THEN
        ALTER TABLE "prepaid_balances" ADD CONSTRAINT "prepaid_balance_nonneg" CHECK ("balance" >= 0);
      END IF;
    END $$;`);
  await app.prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION assert_ledger_txn_balanced() RETURNS trigger AS $$
    DECLARE
      tid text;
      imbalance numeric;
    BEGIN
      tid := COALESCE(NEW."transactionId", OLD."transactionId");
      SELECT COALESCE(SUM("debit" - "credit"), 0) INTO imbalance
      FROM "ledger_entries" WHERE "transactionId" = tid;
      IF imbalance <> 0 THEN
        RAISE EXCEPTION 'LEDGER_UNBALANCED: transaction % is off by %', tid, imbalance;
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;`);
  await app.prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION deny_ledger_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'LEDGER_APPEND_ONLY: % on % is forbidden — post a reversing transaction', TG_OP, TG_TABLE_NAME;
    END;
    $$ LANGUAGE plpgsql;`);
  await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "ledger_txn_balanced" ON "ledger_entries"`);
  await app.prisma.$executeRawUnsafe(`
    CREATE CONSTRAINT TRIGGER "ledger_txn_balanced"
    AFTER INSERT ON "ledger_entries"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_ledger_txn_balanced()`);
  await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "ledger_entries_append_only" ON "ledger_entries"`);
  await app.prisma.$executeRawUnsafe(`
    CREATE TRIGGER "ledger_entries_append_only"
    BEFORE UPDATE OR DELETE ON "ledger_entries"
    FOR EACH ROW EXECUTE FUNCTION deny_ledger_mutation()`);
  await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "ledger_transactions_append_only" ON "ledger_transactions"`);
  await app.prisma.$executeRawUnsafe(`
    CREATE TRIGGER "ledger_transactions_append_only"
    BEFORE UPDATE OR DELETE ON "ledger_transactions"
    FOR EACH ROW EXECUTE FUNCTION deny_ledger_mutation()`);
}

async function makeVendorSub(over: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Ledger', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  createdUserIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Ledger Vendor ${seq}`, slug: `ledg-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 700_000 + seq}`,
      addressLine1: '17 Balance St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH',
      currentPeriodStart: new Date(Date.now() - WEEK), currentPeriodEnd: new Date(Date.now() + WEEK), nextBillingDate: new Date(Date.now() + WEEK),
      ...over,
    } as never,
  });
  createdSubIds.push(sub.id);
  return { sub };
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

  await installLedgerLaws();
  await ensureLedgerAccounts(app.prisma);
  // users.tenantId FK — fresh (unseeded) test databases need the default tenant
  await app.prisma.tenant.upsert({
    where: { id: 'swift-default' },
    update: {},
    create: { id: 'swift-default', name: 'Swift', slug: 'swift-default' },
  });

  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

afterAll(async () => {
  // Ledger rows are append-only BY LAW — they stay. Everything else cleans up;
  // orphaned subledger rows are invisible to the invariants (no wallet row).
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

describe('BE-13 — the database enforces the books', () => {
  it('an unbalanced transaction cannot COMMIT (deferred constraint trigger)', async () => {
    await expect(
      app.prisma.$transaction([
        app.prisma.$executeRawUnsafe(
          `INSERT INTO "ledger_transactions" ("id", "idempotencyKey", "description") VALUES ('ltx_unbal_${run}', 'unbal:${run}', 'deliberately lopsided')`,
        ),
        app.prisma.$executeRawUnsafe(
          `INSERT INTO "ledger_entries" ("id", "transactionId", "accountCode", "debit", "credit") VALUES ('len_unbal_${run}', 'ltx_unbal_${run}', 'FEE_REVENUE', 100, 0)`,
        ),
      ]),
    ).rejects.toThrow(/LEDGER_UNBALANCED/);
    const orphan = await app.prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: `unbal:${run}` } });
    expect(orphan).toBeNull(); // the whole transaction rolled back
  });

  it('an entry with both sides — or neither side — dies on the CHECK', async () => {
    await expect(
      app.prisma.$executeRawUnsafe(
        `INSERT INTO "ledger_entries" ("id", "transactionId", "accountCode", "debit", "credit") VALUES ('len_both_${run}', 'ltx_none_${run}', 'FEE_REVENUE', 50, 50)`,
      ),
    ).rejects.toThrow(/ledger_entries_one_side|violates/);
    await expect(
      app.prisma.$executeRawUnsafe(
        `INSERT INTO "ledger_entries" ("id", "transactionId", "accountCode", "debit", "credit") VALUES ('len_zero_${run}', 'ltx_none_${run}', 'FEE_REVENUE', 0, 0)`,
      ),
    ).rejects.toThrow(/ledger_entries_one_side|violates/);
  });

  it('ledger rows are append-only: UPDATE and DELETE are refused by the database', async () => {
    const posted = await postLedger(app.prisma, {
      idempotencyKey: `append:${run}`,
      description: 'append-only probe',
      entries: [
        { account: 'CLEARING_MMG', debit: 10 },
        { account: 'WALLET_LIABILITY', subledgerId: `probe-${run}`, credit: 10 },
      ],
    });
    expect(posted).toBeTruthy();
    await expect(
      app.prisma.$executeRawUnsafe(`UPDATE "ledger_entries" SET "debit" = 999 WHERE "transactionId" = '${posted!.id}'`),
    ).rejects.toThrow(/LEDGER_APPEND_ONLY/);
    await expect(
      app.prisma.$executeRawUnsafe(`DELETE FROM "ledger_entries" WHERE "transactionId" = '${posted!.id}'`),
    ).rejects.toThrow(/LEDGER_APPEND_ONLY/);
    await expect(
      app.prisma.$executeRawUnsafe(`DELETE FROM "ledger_transactions" WHERE "id" = '${posted!.id}'`),
    ).rejects.toThrow(/LEDGER_APPEND_ONLY/);
  });

  it('postLedger refuses malformed postings before they reach the database', async () => {
    await expect(
      postLedger(app.prisma, { idempotencyKey: `bad1:${run}`, description: 'one-legged', entries: [{ account: 'FEE_REVENUE', credit: 5 }] }),
    ).rejects.toThrow(/LEDGER_MALFORMED/);
    await expect(
      postLedger(app.prisma, {
        idempotencyKey: `bad2:${run}`, description: 'lopsided',
        entries: [{ account: 'CLEARING_MMG', debit: 10 }, { account: 'FEE_REVENUE', credit: 9 }],
      }),
    ).rejects.toThrow(/LEDGER_UNBALANCED/);
    await expect(
      postLedger(app.prisma, {
        idempotencyKey: `bad3:${run}`, description: 'unknown account',
        entries: [{ account: 'SLUSH_FUND', debit: 10 }, { account: 'FEE_REVENUE', credit: 10 }],
      }),
    ).rejects.toThrow(/LEDGER_UNKNOWN_ACCOUNT/);
  });

  it('a replayed posting is a metered no-op (LAW M-4)', async () => {
    const key = `replay:${run}`;
    const entries = topupPostings(`replay-sub-${run}`, 777);
    const first = await postLedger(app.prisma, { idempotencyKey: key, description: 'first', entries });
    const second = await postLedger(app.prisma, { idempotencyKey: key, description: 'second delivery', entries });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(await app.prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(1);
  });
});

describe('M-13 — live credit paths post balanced books in the same transaction', () => {
  it('recordTopUp posts CLEARING→WALLET once, replay-safe, receipt intact', async () => {
    const { sub } = await makeVendorSub();
    const clientKey = `ck-${run}`;
    await billing.recordTopUp(sub.id, 5000, 'ledger-test-admin', 'MMG-REF-1', clientKey);
    await billing.recordTopUp(sub.id, 5000, 'ledger-test-admin', 'MMG-REF-1', clientKey); // replay

    const txn = await app.prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey: `ledger:topup:${sub.id}:${clientKey}` },
      include: { entries: true },
    });
    expect(txn).toBeTruthy();
    expect(txn!.entries).toHaveLength(2);
    const debit = txn!.entries.find((e) => Number(e.debit) > 0)!;
    const credit = txn!.entries.find((e) => Number(e.credit) > 0)!;
    expect(debit.accountCode).toBe('CLEARING_MMG');
    expect(Number(debit.debit)).toBe(5000);
    expect(credit.accountCode).toBe('WALLET_LIABILITY');
    expect(credit.subledgerId).toBe(sub.id);
    expect(Number(credit.credit)).toBe(5000);

    const balance = await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } });
    expect(Number(balance.balance)).toBe(5000); // replay did not double-credit
  });

  it('a prepaid weekly charge consumes the wallet on the books; wallet == ledger end-to-end', async () => {
    const { sub } = await makeVendorSub({ nextBillingDate: new Date(Date.now() - 60_000), currentPeriodEnd: new Date(Date.now() - 60_000) });
    await billing.recordTopUp(sub.id, 5000, 'ledger-test-admin', undefined, `charge-${run}`);
    const outcome = await billing.billSubscription(await subWithRelations(sub.id));
    expect(outcome).toBe('succeeded');

    const periodKey = new Date(Date.now() - 60_000).toISOString().slice(0, 10);
    const txn = await app.prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey: `ledger:success:${sub.id}:${periodKey}` },
      include: { entries: true },
    });
    expect(txn).toBeTruthy();
    const debit = txn!.entries.find((e) => Number(e.debit) > 0)!;
    const credit = txn!.entries.find((e) => Number(e.credit) > 0)!;
    expect(debit.accountCode).toBe('WALLET_LIABILITY');
    expect(debit.subledgerId).toBe(sub.id);
    expect(Number(debit.debit)).toBe(2100);
    expect(credit.accountCode).toBe('FEE_REVENUE');

    // The projection law: wallet balance == WALLET_LIABILITY subledger, exactly.
    const balance = await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: sub.id } });
    expect(Number(balance.balance)).toBe(2900);
    const report = await runBillingInvariants(app.prisma);
    expect(report.ledgerWalletMismatches.map((m) => m.subscriptionId)).not.toContain(sub.id);
    expect(report.walletMismatches.map((m) => m.subscriptionId)).not.toContain(sub.id);
  });

  it('a wallet credited around the ledger is caught by the drift detector (S0)', async () => {
    const { sub } = await makeVendorSub();
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: sub.id, balance: 7777 } }); // bypass — the exact bug class M-13 exists for
    const report = await runBillingInvariants(app.prisma);
    const drift = report.ledgerWalletMismatches.find((m) => m.subscriptionId === sub.id);
    expect(drift).toBeTruthy();
    expect(drift!.walletBalance).toBe(7777);
    expect(drift!.ledgerBalance).toBe(0);
  });

  it('the trial balance holds across all real activity (Σdebits == Σcredits)', async () => {
    const report = await runBillingInvariants(app.prisma);
    expect(report.ledgerTrialImbalance).toBeNull();
  });
});

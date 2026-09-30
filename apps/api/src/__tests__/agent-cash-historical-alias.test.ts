import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { AgentCashService } from '../modules/billing/agent-cash.service';
import { BillingService } from '../modules/billing/billing.service';
import type { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { ensureSan } from '../modules/billing/san.service';
import { importSettlementCsv } from '../modules/billing/settlement-import';

const prisma = new PrismaClient();
const migration = readFileSync(join(process.cwd(), 'prisma/migrations/20260930140000_mmg_one_live_identity/migration.sql'), 'utf8');
const statements = migration.split('-- statement-breakpoint').map((s) => s.replace(/^--.*$/gm, '').trim())
  .filter((s) => s !== 'BEGIN;' && s !== 'COMMIT;');
afterAll(() => prisma.$disconnect());

// All schema, fixture and real money writes roll back together. Service
// transactions use this connection so the exact migration's uncommitted
// schema is visible; none of the credit/receipt/ledger methods are mocked.
function inTransaction(tx: Prisma.TransactionClient): PrismaClient {
  const client = new Proxy(tx, { get(target, key) {
    if (key === '$transaction') return (fn: (client: Prisma.TransactionClient) => unknown) => fn(client);
    return Reflect.get(target, key);
  } });
  return client as PrismaClient;
}
async function legacyFixture(run: (tx: Prisma.TransactionClient, db: PrismaClient) => Promise<void>) {
  const rollback = new Error('ROLLBACK_ALIAS_FIXTURE');
  try { await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('DROP TRIGGER IF EXISTS provider_payments_historical_alias_guard ON provider_payments');
    await tx.$executeRawUnsafe('DROP TABLE IF EXISTS provider_payment_aliases');
    await tx.$executeRawUnsafe('DROP FUNCTION IF EXISTS provider_payments_guard_historical_alias()');
    await tx.$executeRawUnsafe('DROP FUNCTION IF EXISTS provider_payment_aliases_immutable()');
    await tx.$executeRawUnsafe('DROP INDEX IF EXISTS provider_payments_one_live_canonical');
    await tx.$executeRawUnsafe('DROP INDEX IF EXISTS "provider_payments_provider_providerTxnId_idx"');
    await tx.$executeRawUnsafe('DROP FUNCTION IF EXISTS mmg_txn_canon(text)');
    await tx.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "provider_payments_provider_providerTxnId_key" ON provider_payments (provider, "providerTxnId")');
    await run(tx, inTransaction(tx));
    throw rollback;
  }, { timeout: 60_000 }); } catch (error) { if (error !== rollback) throw error; }
}
async function applyMigration(tx: Prisma.TransactionClient) {
  for (const statement of statements) await tx.$executeRawUnsafe(statement);
}
async function account(db: PrismaClient) {
  const tag = nanoid(10);
  const user = await db.user.create({ data: { phone: `+592${Math.floor(1_000_000_000 + Math.random() * 8_000_000_000)}`, firstName: 'Alias', lastName: 'Fixture', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
  const owner = await db.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await db.vendor.create({ data: {
    ownerId: owner.id, name: 'Alias fixture', slug: `alias-${tag.toLowerCase()}`, vendorType: 'RESTAURANT', phone: user.phone,
    addressLine1: 'Fixture road', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
  } });
  const sub = await db.subscription.create({ data: {
    vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH',
    currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000), nextBillingDate: new Date(Date.now() + 7 * 86_400_000),
  } });
  const notifications = { send: vi.fn().mockResolvedValue(undefined) } as unknown as NotificationService;
  const billing = new BillingService(db, notifications, getPaymentProvider());
  return { sub, san: await ensureSan(db, sub.id), billing, svc: new AgentCashService(db, billing) };
}
async function money(db: PrismaClient, subscriptionId: string) {
  const events = await db.billingEvent.findMany({ where: { subscriptionId, type: 'PREPAID_TOPUP' }, orderBy: { id: 'asc' } });
  return {
    events, receipts: await db.feeReceipt.findMany({ where: { subscriptionId }, orderBy: { id: 'asc' } }),
    ledger: await db.ledgerTransaction.findMany({ where: { idempotencyKey: { in: events.map((e) => `ledger:${e.idempotencyKey}`) } }, orderBy: { id: 'asc' } }),
    wallet: await db.prepaidBalance.findUnique({ where: { subscriptionId } }),
  };
}

describe('[SX394] original stored aliases survive the exact migration', () => {
  it.each(['repair', 'attach', 'held-transitive', 'foreign-tenant', 'invisible-target'] as const)('%s never credits the unlinked old stored spelling again', async (mode) => {
    await legacyFixture(async (tx, db) => {
      const { sub, san, billing, svc } = await account(db);
      const raw = `ALIAS-${nanoid(10)}-straße`;
      const stored = raw.toUpperCase(); // The actual pre-migration writer's historical output.
      const initial = await db.mmgAgentPayment.create({ data: {
        channel: 'MMG_AGENT_WEBHOOK', externalId: raw, mmgTxnId: raw, sanRaw: san, amount: 2100,
        currencyCode: 'GYD', paidAt: new Date(), status: 'MATCHED', subscriptionId: sub.id, raw: {},
      } });
      const identity = await db.providerPayment.create({ data: {
        provider: 'MMG', providerTxnId: stored, amount: 2100, currencyCode: 'GYD', status: 'CREDITED', creditedPaymentId: initial.id, subscriptionId: sub.id,
      } });
      await db.mmgAgentPayment.update({ where: { id: initial.id }, data: { providerPaymentId: identity.id } });
      await billing.recordTopUpInTransaction(tx, { subscriptionId: sub.id, amount: 2100, recordedBy: 'alias-fixture', eventKey: `agent-cash:pp:${identity.id}` });
      const aliasKeys = [stored];
      if (mode === 'held-transitive') {
        let previous = raw;
        for (const n of [1, 2]) {
          const key = `${stored}-SIBLING-${n}`;
          const sibling = await db.providerPayment.create({ data: { provider: 'MMG', providerTxnId: key, amount: 2100, currencyCode: 'GYD', status: 'OPEN' } });
          await db.mmgAgentPayment.create({ data: { channel: 'MANUAL_ADMIN', externalId: `MANUAL:${key}`, mmgTxnId: previous, providerPaymentId: sibling.id, sanRaw: san, amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'RECEIVED', raw: {} } });
          previous = key; aliasKeys.push(key);
        }
      }
      const foreign = mode === 'foreign-tenant' || mode === 'invisible-target' ? await db.tenant.create({ data: { name: 'Alias foreign fixture', slug: `alias-other-${nanoid(8).toLowerCase()}` } }) : null;
      const pending = await db.mmgAgentPayment.create({ data: {
        tenantId: foreign?.id ?? 'swift-default', channel: 'MMG_AGENT_WEBHOOK', externalId: stored, mmgTxnId: stored,
        sanRaw: san, amount: 2100, currencyCode: 'GYD', paidAt: new Date(), createdAt: new Date(Date.now() - 600_000),
        status: mode === 'attach' ? 'UNMATCHED' : 'RECEIVED', failureCode: mode === 'attach' ? 'UNFINISHED' : null, raw: {},
      } });
      const before = await money(db, sub.id);
      expect(before.events).toHaveLength(1); expect(before.ledger).toHaveLength(1);
      await applyMigration(tx);
      if (mode === 'invisible-target') {
        // The existing app role is NOBYPASSRLS. Only this transaction changes
        // role; no role, grant, or fixture outside the assigned DB is changed.
        await tx.$executeRawUnsafe('SET LOCAL ROLE swift_app');
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${foreign!.id}, true)`;
        try {
          expect(await tx.$queryRaw`SELECT has_table_privilege(current_user, 'provider_payment_aliases', 'SELECT') AS readable,
            has_table_privilege(current_user, 'provider_payment_aliases', 'INSERT') AS insertable,
            has_table_privilege(current_user, 'provider_payment_aliases', 'UPDATE') AS editable,
            has_table_privilege(current_user, 'provider_payment_aliases', 'DELETE') AS deletable`)
            .toEqual([{ readable: true, insertable: false, editable: false, deletable: false }]);
          expect(await tx.$queryRaw`SELECT id FROM provider_payments WHERE id=${identity.id}`).toEqual([]);
          expect(await tx.$queryRaw`SELECT "providerPaymentId" FROM provider_payment_aliases WHERE provider='MMG' AND "aliasKey"=mmg_txn_canon(${stored})`)
            .toEqual([{ providerPaymentId: identity.id }]);
          await svc.finishStrandedPayments({ paymentIds: [pending.id] });
        } finally { await tx.$executeRawUnsafe('RESET ROLE'); }
      } else if (mode === 'attach') await expect(svc.attach(pending.id, sub.id, 'alias-test')).rejects.toThrow('PROVIDER_ID_CONFLICT');
      else await svc.finishStrandedPayments({ paymentIds: [pending.id] });
      expect(await money(db, sub.id)).toEqual(before);
      expect(await db.providerPayment.count({ where: { providerTxnId: { startsWith: stored.slice(0, stored.indexOf('-STRASSE')) }, status: { not: 'HELD_DUPLICATE' } } })).toBe(1);
      expect(await db.mmgAgentPayment.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ providerPaymentId: null, status: 'UNMATCHED', ...(mode === 'attach' ? {} : { failureCode: 'PROVIDER_ID_CONFLICT' }) });
      for (const alias of aliasKeys) {
        const saved = await tx.$queryRaw<Array<{ providerPaymentId: string }>>`SELECT "providerPaymentId" FROM provider_payment_aliases WHERE provider='MMG' AND "aliasKey"=mmg_txn_canon(${alias})`;
        expect(saved).toEqual([{ providerPaymentId: identity.id }]);
      }
      if (mode === 'held-transitive') {
        // Different incoming spellings and channels cannot sidestep the
        // reservation, even though none is still a stored live identity key.
        for (const spelling of [stored.toLowerCase(), ` ${stored} `, `\t${stored}\t`]) {
          expect(await svc.ingest({ externalId: `MANUAL:${spelling}`, channel: 'MANUAL_ADMIN', sanRaw: san, amount: 2100, currencyCode: 'GYD', paidAt: new Date(), raw: {} }))
            .toMatchObject({ status: 'received_unmatched', failureCode: 'PROVIDER_ID_CONFLICT' });
          const report = await importSettlementCsv(db, svc, `transaction_id,account_number,amount,paid_at\n${spelling},${san},2100,2026-09-01T10:00:00Z`, { source: 'sx394-alias-test' });
          expect(report.status).toBe('PUBLISHED'); expect(report.credited).toBe(0);
        }
        expect(await money(db, sub.id)).toEqual(before);
        const current = await db.providerPayment.findUniqueOrThrow({ where: { id: identity.id } });
        expect(await svc.ingest({ externalId: `MANUAL:${raw}`, channel: 'MANUAL_ADMIN', sanRaw: san, amount: 2100, currencyCode: 'GYD', paidAt: new Date(), raw: {} }))
          .toMatchObject({ status: 'reconciled', originalPaymentId: initial.id });
        expect(current.status).toBe('CREDITED');
      }
    });
  });

  it.each(['delete-alias', 'reassign-alias', 'insert-alias', 'delete-survivor', 'rename-survivor'] as const)('historical reservation survives attempted %s', async (mode) => {
    await legacyFixture(async (tx, db) => {
      const key = `DURABLE-${nanoid(10)}`;
      const owner = await db.providerPayment.create({ data: { provider: 'MMG', providerTxnId: key, amount: 2100, currencyCode: 'GYD' } });
      await applyMigration(tx);
      const [alias] = await tx.$queryRaw<Array<{ aliasKey: string }>>`SELECT "aliasKey" FROM provider_payment_aliases WHERE "providerPaymentId"=${owner.id}`;
      expect(alias?.aliasKey).toBeTruthy();
      await tx.$executeRawUnsafe('SAVEPOINT durable_alias');
      const change = mode === 'delete-alias' ? tx.$executeRaw`DELETE FROM provider_payment_aliases WHERE "providerPaymentId"=${owner.id}`
        : mode === 'reassign-alias' ? tx.$executeRaw`UPDATE provider_payment_aliases SET "aliasKey"=${`${alias!.aliasKey}-NEW`} WHERE "providerPaymentId"=${owner.id}`
        : mode === 'insert-alias' ? tx.$executeRaw`INSERT INTO provider_payment_aliases (provider,"aliasKey","providerPaymentId") VALUES ('MMG',${`${alias!.aliasKey}-NEW`},${owner.id})`
        : mode === 'delete-survivor' ? db.providerPayment.delete({ where: { id: owner.id } })
        : db.providerPayment.update({ where: { id: owner.id }, data: { id: nanoid() } });
      // Distinguish the FK guard from a cascaded child's immutability guard:
      // changing RESTRICT to CASCADE must fail this test for the right reason.
      if (mode === 'delete-survivor' || mode === 'rename-survivor') await expect(change).rejects.toMatchObject({ code: 'P2003' });
      else await expect(change).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT durable_alias');
      expect(await tx.$queryRaw`SELECT "providerPaymentId" FROM provider_payment_aliases WHERE provider='MMG' AND "aliasKey"=${alias!.aliasKey}`)
        .toEqual([{ providerPaymentId: owner.id }]);
    });
  });

  it.each(['insert', 'key-update', 'provider-update', 'status-update'] as const)('the database refuses %s into a reserved historical alias', async (mode) => {
    await legacyFixture(async (tx, db) => {
      const raw = `GUARD-${nanoid(10)}-straße`, old = raw.toUpperCase();
      const owner = await db.providerPayment.create({ data: { provider: 'MMG', providerTxnId: old, amount: 2100, currencyCode: 'GYD', status: 'CREDITED', creditedPaymentId: 'historical-fixture' } });
      await db.mmgAgentPayment.create({ data: { channel: 'MMG_AGENT_WEBHOOK', externalId: raw, mmgTxnId: raw, providerPaymentId: owner.id, sanRaw: 'fixture', amount: 2100, currencyCode: 'GYD', paidAt: new Date(), status: 'MATCHED', raw: {} } });
      await applyMigration(tx);
      const candidate = mode === 'insert' ? null : await db.providerPayment.create({ data: { provider: mode === 'provider-update' ? 'OTHER' : 'MMG', providerTxnId: mode === 'key-update' ? `${old}-OTHER` : old, amount: 2100, currencyCode: 'GYD', status: mode === 'status-update' ? 'HELD_DUPLICATE' : 'OPEN' } });
      await tx.$executeRawUnsafe('SAVEPOINT alias_guard');
      const write = mode === 'insert'
        ? db.providerPayment.create({ data: { provider: 'MMG', providerTxnId: old, amount: 2100, currencyCode: 'GYD' } })
        : db.providerPayment.update({ where: { id: candidate!.id }, data: mode === 'key-update' ? { providerTxnId: old } : mode === 'provider-update' ? { provider: 'MMG' } : { status: 'OPEN' } });
      await expect(write).rejects.toThrow();
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT alias_guard');
    });
  });

  it.each(['distinct', 'equal'] as const)('settlement uses SQL %s reference equivalence before publication', async (mode) => {
    await legacyFixture(async (tx, db) => {
      const { sub, san, svc } = await account(db);
      await applyMigration(tx);
      const first = ` \tFILE-${nanoid(10)}-straße\t `;
      const second = mode === 'distinct' ? first.toUpperCase() : `\t${first}\t`;
      const report = await importSettlementCsv(db, svc, `transaction_id,account_number,amount,paid_at\n${first},${san},2100,2026-09-01T10:00:00Z\n${second},${san},2100,2026-09-01T10:00:00Z\nTOTAL,4200`, { source: 'sx394-alias-test' });
      expect(report.status).toBe(mode === 'distinct' ? 'PUBLISHED' : 'REJECTED');
      const staged = await db.settlementImport.findUniqueOrThrow({ where: { id: report.importId } });
      expect((staged.rows as Array<{ txnId: string }>).map((r) => r.txnId)).toEqual([first, second]);
      const facts = await money(db, sub.id);
      expect(facts.events).toHaveLength(mode === 'distinct' ? 2 : 0);
      expect(facts.ledger).toHaveLength(mode === 'distinct' ? 2 : 0);
      if (mode === 'equal') expect(await db.mmgAgentPayment.count({ where: { mmgTxnId: { in: [first, second] } } })).toBe(0);
    });
  });
});

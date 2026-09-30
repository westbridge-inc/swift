import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';

const prisma = new PrismaClient();
const migrationName = '20260930140000_mmg_one_live_identity';
const migration = readFileSync(join(process.cwd(), 'prisma/migrations', migrationName, 'migration.sql'), 'utf8');
const statements = migration.split('-- statement-breakpoint').map((s) => s.replace(/^--.*$/gm, '').trim())
  .filter((s) => s !== 'BEGIN;' && s !== 'COMMIT;');
afterAll(() => prisma.$disconnect());

describe('[AX384] canonical identity migration on pre-migration money facts', () => {
  it('holds legacy duplicates, preserves credits, rekeys JS drift, and records multi-CREDITED finance alerts; rollback restores the starting schema', async () => {
    const rollback = new Error('ROLLBACK_TEST_FIXTURES');
    const prefix = `MIG-${nanoid(12)}`;
    await expect(prisma.$transaction(async (tx) => {
      // Reconstruct the old schema inside this transaction. Every DDL and
      // fixture change rolls back, including when an assertion fails.
      await tx.$executeRawUnsafe('DROP INDEX provider_payments_one_live_canonical');
      await tx.$executeRawUnsafe('DROP INDEX "provider_payments_provider_providerTxnId_idx"');
      await tx.$executeRawUnsafe('DROP FUNCTION mmg_txn_canon(text)');
      await tx.$executeRawUnsafe('CREATE UNIQUE INDEX "provider_payments_provider_providerTxnId_key" ON provider_payments (provider, "providerTxnId")');
      const snapshots = async () => ({
        events: await tx.billingEvent.count(), receipts: await tx.feeReceipt.count(),
        ledger: await tx.ledgerTransaction.count(),
        wallets: await tx.prepaidBalance.findMany({ orderBy: { id: 'asc' } }),
      });
      const before = await snapshots();
      const seed = async (key: string, raw: string, status: 'OPEN' | 'CREDITED', createdAt: Date) => {
        const id = nanoid();
        const observationId = nanoid();
        await tx.providerPayment.create({ data: {
          id, provider: 'MMG', providerTxnId: key, amount: 2100, currencyCode: 'GYD', status, createdAt,
          creditedPaymentId: status === 'CREDITED' ? observationId : null,
        } });
        await tx.mmgAgentPayment.create({ data: {
          id: observationId, channel: 'MMG_AGENT_WEBHOOK', externalId: `${prefix}-${observationId}`, mmgTxnId: raw,
          providerPaymentId: id, amount: 2100, currencyCode: 'GYD', status: status === 'CREDITED' ? 'MATCHED' : 'RECEIVED',
          paidAt: createdAt, createdAt, sanRaw: 'migration-test', raw: {},
        } });
        return { id, observationId };
      };
      const older = new Date('2026-01-01T00:00:00Z');
      const newer = new Date('2026-01-02T00:00:00Z');
      const legacy = await seed(`\t${prefix}-ONE\t`, `\t${prefix}-ONE\t`, 'CREDITED', newer);
      const open = await seed(`${prefix}-ONE`, `${prefix}-ONE`, 'OPEN', older);
      const multiFirst = await seed(`\t${prefix}-MULTI\t`, `\t${prefix}-MULTI\t`, 'CREDITED', older);
      const multiSecond = await seed(`${prefix}-MULTI`, `${prefix}-MULTI`, 'CREDITED', newer);
      const firstOpen = await seed(`\t${prefix}-OPEN\t`, `\t${prefix}-OPEN\t`, 'OPEN', older);
      const secondOpen = await seed(`${prefix}-OPEN`, `${prefix}-OPEN`, 'OPEN', newer);
      const drift: Array<{ live: { id: string }; held: { id: string }; canonical: string }> = [];
      for (const suffix of ['straße', 'ﬁle', '\u00a0ref\u00a0']) {
        const raw = suffix.startsWith('\u00a0') ? `\u00a0${prefix}-${suffix}\u00a0` : `${prefix}-${suffix}`;
        const { canonical } = (await tx.$queryRaw<Array<{ canonical: string }>>`SELECT upper(regexp_replace(${raw}, U&'^[[:space:]\\00A0\\202F\\FEFF]+|[[:space:]\\00A0\\202F\\FEFF]+$', '', 'g')) AS canonical`)[0]!;
        const live = await seed(raw.trim().toUpperCase(), raw, 'CREDITED', newer);
        const held = await seed(suffix.startsWith('\u00a0') ? raw.toUpperCase() : canonical, raw, 'OPEN', older);
        drift.push({ live, held, canonical: canonical! });
      }
      for (const sql of statements) await tx.$executeRawUnsafe(sql);
      expect((await tx.$queryRaw<Array<{ lock_timeout: string }>>`SHOW lock_timeout`)[0]?.lock_timeout).toBe('10s');
      expect((await tx.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM pg_locks
        WHERE pid = pg_backend_pid() AND mode = 'ShareRowExclusiveLock'
          AND relation IN ('provider_payments'::regclass, 'mmg_agent_payments'::regclass)`)[0]?.count).toBe(2);
      expect((await tx.$queryRaw<Array<{ volatility: string }>>`SELECT provolatile::text AS volatility FROM pg_proc WHERE oid = 'mmg_txn_canon(text)'::regprocedure`)[0]?.volatility).toBe('i');
      const provider = (id: string) => tx.providerPayment.findUniqueOrThrow({ where: { id } });
      expect(await provider(legacy.id)).toMatchObject({ status: 'CREDITED', providerTxnId: `${prefix}-ONE`.toUpperCase(), creditedPaymentId: legacy.observationId });
      expect(await provider(open.id)).toMatchObject({ status: 'HELD_DUPLICATE', creditedPaymentId: null });
      expect(await tx.mmgAgentPayment.findUniqueOrThrow({ where: { id: open.observationId } })).toMatchObject({ status: 'UNMATCHED', failureCode: 'PROVIDER_ID_CONFLICT', providerPaymentId: open.id });
      expect(await provider(firstOpen.id)).toMatchObject({ status: 'OPEN' });
      expect(await provider(secondOpen.id)).toMatchObject({ status: 'HELD_DUPLICATE' });
      for (const d of drift) {
        expect(await provider(d.live.id)).toMatchObject({ status: 'CREDITED', providerTxnId: d.canonical });
        expect(await provider(d.held.id)).toMatchObject({ status: 'HELD_DUPLICATE' });
      }
      expect(await provider(multiSecond.id)).toMatchObject({ status: 'HELD_DUPLICATE', creditedPaymentId: multiSecond.observationId, amount: expect.anything() });
      expect(await tx.mmgAgentPayment.findUniqueOrThrow({ where: { id: multiSecond.observationId } })).toMatchObject({ status: 'MATCHED' });
      const alert = await tx.auditLog.findFirstOrThrow({ where: { entityId: multiFirst.id, action: 'FINANCE_ALERT_PROVIDER_ID_CONFLICT' } });
      expect(alert.changes).toMatchObject({ failureCode: 'PROVIDER_ID_CONFLICT', historicalDoubleCredit: true, creditedCount: 2, requiresFinanceReview: true });
      expect(await tx.auditLog.count({ where: { entityId: { in: [legacy.id, multiFirst.id, firstOpen.id, ...drift.map((d) => d.live.id)] } } })).toBe(6);
      expect(await snapshots()).toEqual(before);
      // The index is exercised, not merely inspected. A second live spelling
      // is rejected without aborting this transaction, using ON CONFLICT.
      expect(await tx.$executeRaw`INSERT INTO provider_payments (id, provider, "providerTxnId", amount, "currencyCode", "updatedAt")
        VALUES (${nanoid()}, 'MMG', ${` ${prefix}-ONE `}, 2100, 'GYD', CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`).toBe(0);
      throw rollback;
    }, { timeout: 30_000 })).rejects.toBe(rollback);
    expect(await prisma.providerPayment.count({ where: { providerTxnId: { contains: prefix } } })).toBe(0);
    const [index] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT indexname AS name FROM pg_indexes WHERE indexname = 'provider_payments_one_live_canonical'`;
    expect(index?.name).toBe('provider_payments_one_live_canonical');
  });
});

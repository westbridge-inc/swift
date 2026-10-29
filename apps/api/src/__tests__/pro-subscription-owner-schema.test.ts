import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { testPhone } from './helpers/fixture-ids';
import { TENANT_LINEAGE_TABLES, tenantLineageDdl } from '../lib/tenant-rls';

// [BILL-PRO PR1] An independent service provider (a pro) can own a weekly-fee
// subscription in the database, with the same money lineage as a store:
// its own billing clock (never a mover's shared one), its owner fixed once
// money evidence exists, its tenant taken from the pro's user, and never two
// owners. Nothing in the app creates such a row yet (that is PR3, behind
// PRO_WEEKLY_FEE, off); this suite proves the database is ready and refuses
// every malformed shape.
//
// Every case runs inside a transaction that is rolled back at the end (after
// forcing the deferred checks), so the suite leaves no rows behind.

const db = new PrismaClient();
const TENANT = 'swift-default';
const MIGRATION = '20261029030000_pro_subscription_owner';
const DIR = join(__dirname, '..', '..', 'prisma', 'migrations', MIGRATION);
const DAY = 86_400_000;

class RolledBack extends Error {}
type Tx = Prisma.TransactionClient;

/** Run `body`, force the deferred constraint triggers, then roll everything back. */
async function rolledBack<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  try {
    await db.$transaction(async (tx) => {
      out = await body(tx);
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      throw new RolledBack();
    }, { timeout: 30_000 });
  } catch (err) {
    if (!(err instanceof RolledBack)) throw err;
  }
  return out as T;
}

async function person(tx: Tx, roles: string[] = ['CUSTOMER']) {
  const user = await tx.user.create({ data: {
    phone: testPhone(), firstName: 'Pro', lastName: 'Owner', tenantId: TENANT, countryCode: 'GY',
    roles: roles as never[], activeRole: roles[0] as never,
  } });
  return user.id;
}
async function pro(tx: Tx) {
  const userId = await person(tx);
  const id = `sp-${randomUUID()}`;
  await tx.$executeRaw`INSERT INTO service_providers (id, "userId", trade, "updatedAt") VALUES (${id}, ${userId}, 'plumber', now())`;
  return { id, userId };
}
async function rider(tx: Tx) {
  const userId = await person(tx, ['MOVER']);
  const r = await tx.rider.create({ data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  return { id: r.id, userId };
}
const due = new Date(Date.now() + 3 * DAY);
async function proSub(tx: Tx, serviceProviderId: string, extra: Prisma.Sql = Prisma.empty) {
  const id = `sub-${randomUUID()}`;
  await tx.$executeRaw`INSERT INTO subscriptions (id, "serviceProviderId", type, "weeklyRate", "currentPeriodStart", "currentPeriodEnd", "nextBillingDate", "updatedAt")
    VALUES (${id}, ${serviceProviderId}, 'INDEPENDENT_PRO', 8000, ${new Date(due.getTime() - 7 * DAY)}, ${due}, ${due}, now())`;
  if (extra !== Prisma.empty) await tx.$executeRaw`UPDATE subscriptions SET ${extra} WHERE id = ${id}`;
  return id;
}
async function clock(tx: Tx, subscriptionId: string, moverPayerUserId: string | null = null, tenantId = TENANT) {
  const id = `clk-${randomUUID()}`;
  await tx.$executeRaw`INSERT INTO billing_dunning_clocks (id, "subscriptionId", "tenantId", "moverPayerUserId", "dueAt", "runningSince", "updatedAt")
    VALUES (${id}, ${subscriptionId}, ${tenantId}, ${moverPayerUserId}, ${due}, ${due}, now())`;
  return id;
}
const coverageGap = async (tx: Tx) => Number((await tx.$queryRaw<Array<{ n: bigint }>>`SELECT billing_confirmation_missing_coverage() AS n`)[0]!.n);

beforeAll(async () => { await db.$connect(); });
afterAll(async () => { await db.$disconnect(); });

describe('a pro can own a weekly-fee subscription (schema + money lineage)', () => {
  it('the payer is the pro, in the pro user\'s tenant, typed INDEPENDENT_PRO', async () => {
    const seen = await rolledBack(async (tx) => {
      const p = await pro(tx);
      const sub = await proSub(tx, p.id);
      const payer = await tx.$queryRaw<Array<{ userId: string; tenantId: string }>>`SELECT * FROM billing_clock_payer(${sub})`;
      return { payer, userId: p.userId };
    });
    expect(seen.payer).toEqual([{ userId: seen.userId, tenantId: TENANT }]);
  });

  it('a pro has its own billing clock (no mover payer), like a store, and it counts as covered', async () => {
    const gaps = await rolledBack(async (tx) => {
      const before = await coverageGap(tx);
      const p = await pro(tx);
      const sub = await proSub(tx, p.id);
      const uncovered = await coverageGap(tx);
      await clock(tx, sub);
      return { before, uncovered, covered: await coverageGap(tx) };
    });
    expect(gaps.uncovered).toBe(gaps.before + 1);
    expect(gaps.covered).toBe(gaps.before);
  });

  it("a pro's clock can never be a mover's shared clock", async () => {
    await expect(rolledBack(async (tx) => {
      const p = await pro(tx);
      const sub = await proSub(tx, p.id);
      await clock(tx, sub, p.userId);
    })).rejects.toThrow(/Billing clock ownership unavailable/);
  });

  it("a pro's clock in another tenant is refused", async () => {
    await expect(rolledBack(async (tx) => {
      const p = await pro(tx);
      const sub = await proSub(tx, p.id);
      await clock(tx, sub, null, `other-${randomUUID()}`);
    })).rejects.toThrow(/Billing clock ownership unavailable/);
  });

  it('once a clock exists, the pro owner cannot be swapped', async () => {
    await expect(rolledBack(async (tx) => {
      const p = await pro(tx);
      const other = await pro(tx);
      const sub = await proSub(tx, p.id);
      await clock(tx, sub);
      await tx.$executeRaw`UPDATE subscriptions SET "serviceProviderId" = ${other.id} WHERE id = ${sub}`;
    })).rejects.toThrow(/pro subscription ownership is immutable/);
  });

  it("once a clock exists, the pro profile cannot be handed to another person", async () => {
    await expect(rolledBack(async (tx) => {
      const p = await pro(tx);
      const sub = await proSub(tx, p.id);
      await clock(tx, sub);
      const someoneElse = await person(tx);
      await tx.$executeRaw`UPDATE service_providers SET "userId" = ${someoneElse} WHERE id = ${p.id}`;
    })).rejects.toThrow(/pro fee profile ownership is immutable/);
  });

  it('a collection contact on a pro subscription takes the pro user\'s tenant', async () => {
    const tenant = await rolledBack(async (tx) => {
      const p = await pro(tx);
      const sub = await proSub(tx, p.id);
      const id = `cc-${randomUUID()}`;
      await tx.$executeRaw`INSERT INTO collection_contacts (id, "subscriptionId", outcome, "byAdminId") VALUES (${id}, ${sub}, 'REACHED', 'admin-test')`;
      return (await tx.$queryRaw<Array<{ tenantId: string | null }>>`SELECT "tenantId" FROM collection_contacts WHERE id = ${id}`)[0]!.tenantId;
    });
    expect(tenant).toBe(TENANT);
  });

  it("MMG payer evidence on a pro subscription must name the pro's user", async () => {
    const evidence = (tx: Tx, sub: string, accountId: string) => tx.$executeRaw`INSERT INTO mmg_payer_evidence (id, "tenantId", "accountId", "actorRole", "payerHash", tier, source, digest, "subscriptionId")
      VALUES (${`ev-${randomUUID()}`}, ${TENANT}, ${accountId}, 'PROVIDER', 'h', 'DECLARED', 'test', 'd', ${sub})`;
    await expect(rolledBack(async (tx) => {
      const p = await pro(tx);
      await evidence(tx, await proSub(tx, p.id), p.userId);
      return 'accepted';
    })).resolves.toBe('accepted');
    await expect(rolledBack(async (tx) => {
      const p = await pro(tx);
      await evidence(tx, await proSub(tx, p.id), await person(tx));
    })).rejects.toThrow(/payer subscription mismatch/);
  });
});

describe('the owner rules', () => {
  it('a subscription never has two owners', async () => {
    const riderSub = async (tx: Tx) => {
      const r = await rider(tx);
      const sub = `sub-${randomUUID()}`;
      await tx.$executeRaw`INSERT INTO subscriptions (id, "riderId", type, "weeklyRate", "currentPeriodStart", "currentPeriodEnd", "nextBillingDate", "updatedAt")
        VALUES (${sub}, ${r.id}, 'DELIVERY_RIDER', 6000, now(), now() + interval '7 days', now(), now())`;
      return { sub, userId: r.userId };
    };
    // born with two
    await expect(rolledBack(async (tx) => {
      const p = await pro(tx);
      const r = await rider(tx);
      await proSub(tx, p.id, Prisma.sql`"riderId" = ${r.id}`);
    })).rejects.toThrow(/subscriptions_at_most_one_owner|subscriptions_pro_owner_shape|born with exactly one owner/);
    // a second mover owner added later (the CHECK itself)
    await expect(rolledBack(async (tx) => {
      const { sub, userId } = await riderSub(tx);
      const d = await tx.driver.create({ data: { userId, vehicleType: 'CAR', vehicleMake: 'Test', vehicleModel: 'Fixture', vehicleYear: 2020, vehicleColor: 'White',
        licensePlate: `HPRO-${randomUUID().slice(0, 8)}`, driverLicenseUrl: 'storage://test/dl', vehicleInsuranceUrl: 'storage://test/insurance' } });
      await tx.$executeRaw`UPDATE subscriptions SET "driverId" = ${d.id} WHERE id = ${sub}`;
    })).rejects.toThrow(/subscriptions_at_most_one_owner/);
    // a pro added to an existing rider subscription
    await expect(rolledBack(async (tx) => {
      const { sub } = await riderSub(tx);
      const sp = await pro(tx);
      await tx.$executeRaw`UPDATE subscriptions SET "serviceProviderId" = ${sp.id} WHERE id = ${sub}`;
    })).rejects.toThrow(/pro subscription ownership is immutable/);
  });

  it('a new subscription is born with exactly one owner', async () => {
    await expect(rolledBack(async (tx) => {
      await tx.$executeRaw`INSERT INTO subscriptions (id, type, "weeklyRate", "currentPeriodStart", "currentPeriodEnd", "nextBillingDate", "updatedAt")
        VALUES (${`sub-${randomUUID()}`}, 'DELIVERY_RIDER', 6000, now(), now() + interval '7 days', now(), now())`;
    })).rejects.toThrow(/born with exactly one owner/);
  });

  it('the pro type and the pro owner go together', async () => {
    await expect(rolledBack(async (tx) => {
      const p = await pro(tx);
      await tx.$executeRaw`INSERT INTO subscriptions (id, "serviceProviderId", type, "weeklyRate", "currentPeriodStart", "currentPeriodEnd", "nextBillingDate", "updatedAt")
        VALUES (${`sub-${randomUUID()}`}, ${p.id}, 'SERVICE_PROVIDER', 8000, now(), now() + interval '7 days', now(), now())`;
    })).rejects.toThrow(/subscriptions_pro_owner_shape/);
    await expect(rolledBack(async (tx) => {
      const r = await rider(tx);
      await tx.$executeRaw`INSERT INTO subscriptions (id, "riderId", type, "weeklyRate", "currentPeriodStart", "currentPeriodEnd", "nextBillingDate", "updatedAt")
        VALUES (${`sub-${randomUUID()}`}, ${r.id}, 'INDEPENDENT_PRO', 8000, now(), now() + interval '7 days', now(), now())`;
    })).rejects.toThrow(/subscriptions_pro_owner_shape/);
  });

  it('existing owners keep their rules: a store clock never names a mover payer, a rider clock must', async () => {
    await expect(rolledBack(async (tx) => {
      const r = await rider(tx);
      const sub = `sub-${randomUUID()}`;
      await tx.$executeRaw`INSERT INTO subscriptions (id, "riderId", type, "weeklyRate", "currentPeriodStart", "currentPeriodEnd", "nextBillingDate", "updatedAt")
        VALUES (${sub}, ${r.id}, 'DELIVERY_RIDER', 6000, ${new Date(due.getTime() - 7 * DAY)}, ${due}, ${due}, now())`;
      await clock(tx, sub, null);
    })).rejects.toThrow(/Billing clock ownership unavailable/);
  });
});

describe('the migration', () => {
  const read = (name: string) => { try { return readFileSync(join(DIR, name), 'utf8'); } catch { return ''; } };
  const migration = read('migration.sql');
  const rollback = read('rollback.sql');
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

  it('carries the code\'s own collection_contacts lineage text (tenant-rls.ts)', () => {
    const i = TENANT_LINEAGE_TABLES.findIndex((r) => r.table === 'collection_contacts');
    for (const s of tenantLineageDdl().slice(i * 3, i * 3 + 3)) expect(flat(migration)).toContain(flat(s));
    expect(TENANT_LINEAGE_TABLES[i]!.parentTenantSql).toContain('service_providers');
  });

  it('validates the owner rule only when no row breaks it, and never uses the new enum value in its own transaction', () => {
    expect(migration).toMatch(/ADD CONSTRAINT subscriptions_at_most_one_owner CHECK \(num_nonnulls\("riderId", ?"driverId", ?"vendorId", ?"serviceProviderId"\) <= 1\) NOT VALID/);
    expect(migration).toMatch(/VALIDATE CONSTRAINT subscriptions_at_most_one_owner/);
    expect(migration.replace(/ADD VALUE IF NOT EXISTS 'INDEPENDENT_PRO'/, '')).not.toMatch(/'INDEPENDENT_PRO'::"SubscriptionType"/);
  });

  it('has a guarded rollback that restores the previous functions and removes its own ledger row', () => {
    expect(rollback).toMatch(/BEGIN;/);
    expect(rollback).toMatch(/SET LOCAL row_security = off/);
    expect(rollback).toMatch(/PRO_SUBSCRIPTIONS_IN_USE/);
    expect(rollback).toContain(`"migration_name" = '${MIGRATION}'`);
    for (const fn of ['billing_clock_payer', 'billing_clock_lineage', 'billing_confirmation_missing_coverage', 'safeb_payer_lineage', 'collection_contacts_tenant_matches_owner']) {
      expect(rollback, fn).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\(`));
    }
    expect(rollback).toMatch(/DROP TRIGGER billing_parent_lineage ON service_providers/);
    expect(rollback).toMatch(/DROP COLUMN "serviceProviderId"/);
  });
});

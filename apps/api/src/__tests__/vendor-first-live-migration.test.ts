import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// [RETIER PR-A · COORD security review on #2245] vendors."firstLiveAt": expand-only, one nullable column, backfilled
// for every store that shows it has been live (ACTIVE, verified, holding a subscription, or with an order), and a
// rollback in one transaction that removes exactly its ledger row.
const NAME = '20261030220000_vendor_first_live_at';
const DIR = path.join(__dirname, '../../prisma/migrations', NAME);
const code = (sql: string) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

describe(`[RETIER PR-A] ${NAME}`, () => {
  it('exists with its rollback', () => {
    expect(existsSync(path.join(DIR, 'migration.sql'))).toBe(true);
    expect(existsSync(path.join(DIR, 'rollback.sql'))).toBe(true);
  });

  it('forward adds one nullable column and marks only stores that show they have been live', () => {
    const sql = code(readFileSync(path.join(DIR, 'migration.sql'), 'utf8'));
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b|NOT NULL/);
    expect(sql).toContain('ALTER TABLE "vendors" ADD COLUMN "firstLiveAt" TIMESTAMP(3);');
    expect(sql).toContain('WHERE v."firstLiveAt" IS NULL');
    for (const mark of [`v."status" = 'ACTIVE'`, 'v."isVerified" = true', 'FROM "subscriptions" s WHERE s."vendorId" = v."id"', 'FROM "orders" o WHERE o."vendorId" = v."id"']) {
      expect(sql).toContain(mark);
    }
    // a SUSPENDED status alone never marks a store live (a store can be suspended before it ever went live)
    expect(sql).not.toMatch(/SUSPENDED/);
  });

  it('rollback drops the column in one transaction and removes exactly its ledger row', () => {
    const sql = code(readFileSync(path.join(DIR, 'rollback.sql'), 'utf8'));
    expect(sql.indexOf('BEGIN;')).toBeGreaterThanOrEqual(0);
    expect(sql).toContain('DROP COLUMN IF EXISTS "firstLiveAt"');
    expect(sql).toContain(`"migration_name" = '${NAME}'`);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
  });
});

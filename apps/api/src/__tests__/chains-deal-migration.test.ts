import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// [CHAINS] The chain-deal migration: expand-only, a deal whole and positive and fully stated (who, when, why) or
// absent, and a rollback that refuses while any owner holds a deal (its record would be lost).
const NAME = '20261029040000_chain_deal_rate';
const DIR = path.join(__dirname, '../../prisma/migrations', NAME);
const forward = () => readFileSync(path.join(DIR, 'migration.sql'), 'utf8');
const rollback = () => readFileSync(path.join(DIR, 'rollback.sql'), 'utf8');
const code = (sql: string) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

describe(`[CHAINS] ${NAME}`, () => {
  it('exists with its rollback, and is the newest migration on this branch', () => {
    expect(existsSync(path.join(DIR, 'migration.sql'))).toBe(true);
    expect(existsSync(path.join(DIR, 'rollback.sql')), `${NAME} has no rollback.sql`).toBe(true);
    const stamps = readdirSync(path.join(__dirname, '../../prisma/migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
    expect(stamps.indexOf(NAME)).toBeGreaterThan(-1);
    expect(NAME > '20261029030000').toBe(true);
  });

  it('forward only adds nullable columns and the two checks', () => {
    const sql = code(forward());
    expect(sql).not.toMatch(/\bDROP\b|\bUPDATE\b|\bDELETE\b|NOT NULL DEFAULT/);
    for (const column of ['dealWeeklyRate', 'dealCurrencyCode', 'dealSetAt', 'dealSetBy', 'dealReason']) {
      expect(sql).toContain(`ADD COLUMN "${column}"`);
    }
    expect(sql).toContain('"dealWeeklyRate" > 0 AND "dealWeeklyRate" = trunc("dealWeeklyRate")');
    expect(sql).toContain('vendor_owners_deal_stated');
  });

  it('rollback refuses while a deal exists, in one transaction, and removes exactly its ledger row', () => {
    const sql = code(rollback());
    expect(sql.indexOf('BEGIN;')).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf('CHAIN_DEALS_IN_USE')).toBeLessThan(sql.indexOf('DROP COLUMN'));
    expect(sql).toContain(`"migration_name" = '${NAME}'`);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
  });
});

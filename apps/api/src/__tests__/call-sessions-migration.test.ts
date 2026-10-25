import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { rlsDdlFor, TENANT_LINEAGE_TABLES, tenantLineageDdl } from '../lib/tenant-rls';

// ---------------------------------------------------------------------------
// [O-1] The call bridge's one table ships after every migration it was written
// against (and above the pending STORE-VAT stamp), with its rollback, its
// tenant wall and lineage exactly as the registry writes them, and no column
// that could hold a phone number.
// ---------------------------------------------------------------------------

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const NAME = '20261025090000_call_sessions';
const DIR = path.join(MIGRATIONS, NAME);
/** The newest migration on main when the bridge was written, and the newest pending stamp then (STORE-VAT). */
const NEWEST_ON_MAIN = '20261021150000_advertiser_member_acceptance';
const NEWEST_PENDING_STAMP = '20261024060000';
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const migration = () => readFileSync(path.join(DIR, 'migration.sql'), 'utf8');

describe('the call_sessions migration', () => {
  it('ships once, with its rollback', () => {
    expect(existsSync(path.join(DIR, 'migration.sql')), `${NAME} is missing`).toBe(true);
    expect(existsSync(path.join(DIR, 'rollback.sql')), `${NAME} has no rollback.sql`).toBe(true);
    expect(readdirSync(MIGRATIONS).filter((d) => d.endsWith('_call_sessions'))).toEqual([NAME]);
  });

  it('sorts after main and above the pending stamps', () => {
    expect(readdirSync(MIGRATIONS)).toContain(NEWEST_ON_MAIN);
    expect(NAME > NEWEST_ON_MAIN).toBe(true);
    expect(NAME > NEWEST_PENDING_STAMP).toBe(true);
  });

  it('installs the tenant wall and the tenant lineage exactly as the registry writes them', () => {
    const sql = normalise(migration());
    for (const statement of rlsDdlFor('call_sessions')) expect(sql).toContain(normalise(statement));
    const rule = TENANT_LINEAGE_TABLES.find((r) => r.table === 'call_sessions');
    expect(rule, 'call_sessions is not in TENANT_LINEAGE_TABLES').toBeTruthy();
    for (const statement of tenantLineageDdl().filter((s) => s.includes(rule!.trigger))) expect(sql).toContain(normalise(statement));
  });

  it('one live call per order, and the laws of a row', () => {
    const sql = normalise(migration());
    expect(sql).toContain('CREATE UNIQUE INDEX "call_sessions_one_live_per_order" ON "call_sessions"("orderId") WHERE "endedAt" IS NULL;');
    expect(sql).toMatch(/"calleeRole" <> "callerRole"/);
    expect(sql).toMatch(/\("status" = 'CONNECTED'\) = \("connectedAt" IS NOT NULL\)/);
    expect(sql).toMatch(/"status" NOT IN \('NOT_CONNECTED', 'FAILED'\) OR "endedAt" IS NOT NULL/);
    expect(sql).toContain('REFERENCES "orders"("id") ON DELETE CASCADE');
  });

  it('has no column that could hold a phone number', () => {
    const table = migration().split('CREATE TABLE "call_sessions" (')[1]!.split(');')[0]!;
    const columns = [...table.matchAll(/^\s+"(\w+)"/gm)].map((m) => m[1]!);
    expect(columns.length).toBeGreaterThan(10);
    expect(columns.filter((c) => /phone|number|msisdn|e164|to$|from$/i.test(c))).toEqual([]);
  });

  it('the rollback refuses while any call exists, reads past the forced wall, removes exactly what the migration made, and its own ledger row', () => {
    const rollback = readFileSync(path.join(DIR, 'rollback.sql'), 'utf8');
    const sql = migration();
    expect(rollback).toMatch(/IF EXISTS \(SELECT 1 FROM "call_sessions"\) THEN\s+RAISE EXCEPTION/);
    expect(rollback).toMatch(/^BEGIN;(?:\s*--[^\n]*)*\s*SET LOCAL row_security = off;/m);
    const created = [...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (\w+)\(/g)].map((m) => m[1]).sort();
    const dropped = [...rollback.matchAll(/DROP FUNCTION (\w+)\(/g)].map((m) => m[1]).sort();
    expect(dropped).toEqual(created);
    expect([...rollback.matchAll(/DROP TABLE "(\w+)"/g)].map((m) => m[1])).toEqual(['call_sessions']);
    expect(rollback).not.toMatch(/DROP (?:TABLE|COLUMN|TYPE|INDEX)[^;]*"(?!call_sessions")\w+"/);
    expect(rollback).toContain(`"migration_name" = '${NAME}'`);
  });
});

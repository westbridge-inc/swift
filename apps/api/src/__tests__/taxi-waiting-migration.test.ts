import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { rlsDdlFor, TENANT_LINEAGE_TABLES, tenantLineageDdl } from '../lib/tenant-rls';

// ---------------------------------------------------------------------------
// [TAXI waiting charge · revived 14 Oct] The migration ships, after everything
// it builds on, with its rollback.
//
// The waiting-charge branch was written on 4 Oct. Main gained migrations after
// that, up to 20261012185001_card_completion_evidence. Prisma applies pending
// migrations in name order, so the waiting table is re-timestamped to sort
// after every migration it was written against, and it carries its rollback
// beside it (house rule since September). The suites install the schema
// through the migration, but nothing pinned the file itself: this does.
// ---------------------------------------------------------------------------

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const NAME = '20261014090000_taxi_ride_waiting';
const DIR = path.join(MIGRATIONS, NAME);
/** The newest migration on main when the branch was revived. */
const NEWEST_ON_MAIN_AT_REVIVE = '20261012185001_card_completion_evidence';
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('the waiting-charge migration', () => {
  it('ships once, under its revived name, with its rollback; the 4 Oct name is gone', () => {
    expect(existsSync(path.join(DIR, 'migration.sql')), `${NAME} is missing`).toBe(true);
    expect(existsSync(path.join(DIR, 'rollback.sql')), `${NAME} has no rollback.sql`).toBe(true);
    const named = readdirSync(MIGRATIONS).filter((d) => d.endsWith('_taxi_ride_waiting'));
    expect(named).toEqual([NAME]);
  });

  it('sorts after every migration it was written against', () => {
    expect(readdirSync(MIGRATIONS)).toContain(NEWEST_ON_MAIN_AT_REVIVE);
    expect(NAME > NEWEST_ON_MAIN_AT_REVIVE).toBe(true);
  });

  it('installs the tenant wall and the tenant lineage exactly as the registry writes them', () => {
    const sql = normalise(readFileSync(path.join(DIR, 'migration.sql'), 'utf8'));
    for (const statement of rlsDdlFor('taxi_ride_waiting')) expect(sql).toContain(normalise(statement));
    const rule = TENANT_LINEAGE_TABLES.find((r) => r.table === 'taxi_ride_waiting');
    expect(rule, 'taxi_ride_waiting is not in TENANT_LINEAGE_TABLES').toBeTruthy();
    for (const statement of tenantLineageDdl().filter((s) => s.includes(rule!.trigger))) expect(sql).toContain(normalise(statement));
  });

  it('the rollback refuses while any ride holds waiting terms or a charge, removes exactly what the migration made, and its own ledger row', () => {
    const rollback = readFileSync(path.join(DIR, 'rollback.sql'), 'utf8');
    const migration = readFileSync(path.join(DIR, 'migration.sql'), 'utf8');
    expect(rollback).toMatch(/IF EXISTS \(SELECT 1 FROM "taxi_ride_waiting"\) THEN\s+RAISE EXCEPTION/);
    // [OPUS S3] The table's row-level security is FORCED: the guard must read
    // every row, or a non-bypass role passes it blind (the repo convention).
    expect(rollback).toMatch(/^BEGIN;(?:\s*--[^\n]*)*\s*SET LOCAL row_security = off;/m);
    // Every object the migration creates is dropped, and nothing else is.
    const created = [...migration.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (\w+)\(/g)].map((m) => m[1]).sort();
    const dropped = [...rollback.matchAll(/DROP FUNCTION (\w+)\(/g)].map((m) => m[1]).sort();
    expect(dropped).toEqual(created);
    expect([...rollback.matchAll(/DROP TABLE "(\w+)"/g)].map((m) => m[1])).toEqual(['taxi_ride_waiting']);
    expect(rollback).not.toMatch(/DROP (?:TABLE|COLUMN|TYPE|INDEX)[^;]*"(?!taxi_ride_waiting")\w+"/);
    expect(rollback).toContain(`"migration_name" = '${NAME}'`);
    expect(rollback).not.toContain('20261004120000');
  });
});

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { rlsDdlFor, TENANT_LINEAGE_TABLES, TENANT_TABLES, tenantLineageDdl } from '../lib/tenant-rls';
import { BOOKING_EXCLUSION, bookingResourceDdl, MAX_BOOKING_CAPACITY, RETIRED_ITEM_SLOT_KEY } from '../modules/booking/one-at-a-time';

// ---------------------------------------------------------------------------
// [BOOK-S1] The "one provider, one time" migration ships once, after main,
// with its rollback; it carries the database's half of the rule, the tenant
// wall and the tenant lineage exactly as the code writes them (the test
// installer heals a db-push database with the same text); its pre-flight
// refuses loudly and releases nothing; its rollback refuses to lose a
// business's setting. The forward + rollback run on a copy with a seeded
// overlap is the lane's evidence (it needs a database of its own).
// ---------------------------------------------------------------------------

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const NAME = '20261028120000_booking_one_provider_one_time';
const DIR = path.join(MIGRATIONS, NAME);
/** The newest migration on main when this was written, and the newest pending stamp then (CARS-DELIVER). */
const NEWEST_ON_MAIN = '20261027230000_stock_in_store_sale';
const NEWEST_PENDING_STAMP = '20261027160000';
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const migration = () => readFileSync(path.join(DIR, 'migration.sql'), 'utf8');
const rollback = () => readFileSync(path.join(DIR, 'rollback.sql'), 'utf8');

describe('the one-provider-one-time migration', () => {
  it('ships once, with its rollback, after main and above the pending stamps', () => {
    expect(existsSync(path.join(DIR, 'migration.sql')), `${NAME} is missing`).toBe(true);
    expect(existsSync(path.join(DIR, 'rollback.sql')), `${NAME} has no rollback.sql`).toBe(true);
    expect(readdirSync(MIGRATIONS).filter((d) => d.endsWith('_booking_one_provider_one_time'))).toEqual([NAME]);
    expect(readdirSync(MIGRATIONS)).toContain(NEWEST_ON_MAIN);
    expect(NAME > NEWEST_ON_MAIN).toBe(true);
    expect(NAME > NEWEST_PENDING_STAMP).toBe(true);
  });

  it('runs its read-only pre-flight first: overlaps and empty bookings stop it, by name, before anything changes', () => {
    const sql = migration();
    const preflight = sql.indexOf('DO $preflight$');
    expect(preflight).toBeGreaterThan(0);
    // Nothing but comments and the lock timeout comes before it.
    const before = sql.slice(0, preflight).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--'));
    expect(before).toEqual(["SET lock_timeout = '10s';"]);
    const block = sql.slice(preflight, sql.indexOf('END $preflight$;'));
    expect(block).toMatch(/RAISE EXCEPTION 'BOOKING_OVERLAPS_EXIST:/);
    expect(block).toMatch(/RAISE EXCEPTION 'BOOKING_EMPTY_RANGE:/);
    // It reads only: never cancels, moves or deletes a booking.
    expect(block).not.toMatch(/\b(UPDATE|DELETE|INSERT|ALTER|DROP)\b/);
    // Overlap is judged per business, across listings, on live rows, end-exclusive.
    expect(normalise(block)).toContain('ON c."vendorId" = a."vendorId" AND a.id < c.id AND a."slotStart" < c."slotEnd" AND c."slotStart" < a."slotEnd"');
    expect(normalise(block)).toContain(`WHERE b."status" <> 'CANCELLED'`);
    // And nothing in the whole forward file releases a booking.
    expect(sql).not.toMatch(/SET\s+"?status"?\s*=/i);
  });

  it('back-fills the business from the listing and the tenant from the business, then makes the business required', () => {
    const sql = normalise(migration());
    expect(sql).toContain('UPDATE "bookings" b SET "vendorId" = i."vendorId" FROM "items" i WHERE i.id = b."itemId";');
    expect(sql).toContain('UPDATE "bookings" b SET "tenantId" = v."tenantId" FROM "vendors" v WHERE v.id = b."vendorId" AND b."tenantId" <> v."tenantId";');
    expect(sql.indexOf('ALTER TABLE "bookings" ALTER COLUMN "vendorId" SET NOT NULL;')).toBeGreaterThan(sql.indexOf('UPDATE "bookings" b SET "vendorId"'));
    // Every existing booking was made while its business took one at a time.
    expect(sql).toContain('ADD COLUMN "exclusive" BOOLEAN NOT NULL DEFAULT true');
    expect(sql).toContain('ADD COLUMN "bookingCapacity" INTEGER NOT NULL DEFAULT 1;');
  });

  it('carries the business-time DDL, the tenant wall and the tenant lineage exactly as the code writes them', () => {
    const sql = normalise(migration());
    for (const statement of bookingResourceDdl()) expect(sql).toContain(normalise(statement));
    for (const statement of rlsDdlFor('bookings')) expect(sql).toContain(normalise(statement));
    const rule = TENANT_LINEAGE_TABLES.find((r) => r.table === 'bookings');
    expect(rule, 'bookings is not in TENANT_LINEAGE_TABLES').toMatchObject({ parent: 'vendors', fk: 'vendorId' });
    for (const statement of tenantLineageDdl().filter((s) => s.includes(rule!.trigger))) expect(sql).toContain(normalise(statement));
    expect(TENANT_TABLES).toContain('bookings');
  });

  it('the exclusion is per business over the slot as [start, end), on live rows made under capacity 1', () => {
    const ddl = normalise(bookingResourceDdl().join(';\n'));
    expect(ddl).toContain(`ADD CONSTRAINT "${BOOKING_EXCLUSION}" EXCLUDE USING gist ("vendorId" WITH =, tsrange("slotStart", "slotEnd") WITH &&) WHERE ("status" <> 'CANCELLED' AND "exclusive");`);
    expect(ddl).toContain('CREATE EXTENSION IF NOT EXISTS btree_gist');
    expect(ddl).toContain(`DROP INDEX IF EXISTS "${RETIRED_ITEM_SLOT_KEY}"`);
    expect(ddl).toContain('CHECK ("slotEnd" > "slotStart")');
    expect(ddl).toContain(`CHECK ("bookingCapacity" BETWEEN 1 AND ${MAX_BOOKING_CAPACITY})`);
  });

  it('the rollback refuses while it would lose something, reads past the forced wall, removes what the migration made, and its own applied ledger row', () => {
    const back = rollback();
    const lines = back.split('\n').map((l) => l.trim());
    const begin = lines.indexOf('BEGIN;');
    expect(begin, 'rollback.sql has no BEGIN;').toBeGreaterThanOrEqual(0);
    expect(lines.slice(begin + 1).find((l) => l !== '' && !l.startsWith('--'))).toBe('SET LOCAL row_security = off;');
    expect(back).toMatch(/IF EXISTS \(SELECT 1 FROM "vendors" WHERE "bookingCapacity" <> 1\) THEN\s+RAISE EXCEPTION 'BOOKING_CAPACITY_IN_USE:/);
    expect(back).toMatch(/RAISE EXCEPTION 'BOOKING_SHARED_SLOTS:/);
    // Every function the migration made is dropped; no booking is cancelled or deleted.
    const created = [...migration().matchAll(/CREATE (?:OR REPLACE )?FUNCTION (\w+)\(/g)].map((m) => m[1]).sort();
    const dropped = [...back.matchAll(/DROP FUNCTION (\w+)\(/g)].map((m) => m[1]).sort();
    expect(dropped).toEqual(created);
    expect(back).not.toMatch(/DELETE FROM "?bookings"?|UPDATE "?bookings"?/);
    expect(back).toContain(`CREATE UNIQUE INDEX "${RETIRED_ITEM_SLOT_KEY}" ON "bookings"("itemId", "slotStart") WHERE "status" <> 'CANCELLED';`);
    expect(back).toContain(`"migration_name" = '${NAME}' AND "rolled_back_at" IS NULL`);
  });
});

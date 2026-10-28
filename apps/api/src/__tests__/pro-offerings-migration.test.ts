import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { rlsDdlFor, TENANT_LINEAGE_TABLES, TENANT_TABLES, tenantLineageDdl } from '../lib/tenant-rls';
import {
  providerTimeDdl,
  QUOTE_JOB_MIN_BLOCK_MINUTES,
  SERVICE_JOB_EXCLUSION,
  SERVICE_JOB_RANGE_SQL,
} from '../modules/services/provider-time';

// ---------------------------------------------------------------------------
// [BOOK-P1] The "offerings and hours" migration ships once, after main and the
// pending stamps, with its rollback; it carries the database's half of one pro,
// one time, the tenant wall and the tenant lineage exactly as the code writes
// them (the test installer heals a db-push database with the same text); its
// pre-flight refuses loudly and releases nothing; its rollback refuses to lose
// a provider's setting. The forward + rollback run on a copy with a seeded
// overlap is the lane's evidence (it needs a database of its own).
// ---------------------------------------------------------------------------

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const NAME = '20261029010000_pro_offerings_hours';
const DIR = path.join(MIGRATIONS, NAME);
/** The newest migration on main when this was written, and the newest pending stamp then (BOOK-S no-show). */
const NEWEST_ON_MAIN = '20261028120000_booking_one_provider_one_time';
const NEWEST_PENDING_STAMP = '20261028230000';
const NEW_TABLES = ['service_offerings', 'service_provider_time_off'] as const;
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const migration = () => readFileSync(path.join(DIR, 'migration.sql'), 'utf8');
const rollback = () => readFileSync(path.join(DIR, 'rollback.sql'), 'utf8');

describe('the offerings-and-hours migration', () => {
  it('ships once, with its rollback, after main and above the pending stamps', () => {
    expect(existsSync(path.join(DIR, 'migration.sql')), `${NAME} is missing`).toBe(true);
    expect(existsSync(path.join(DIR, 'rollback.sql')), `${NAME} has no rollback.sql`).toBe(true);
    expect(readdirSync(MIGRATIONS).filter((d) => d.endsWith('_pro_offerings_hours'))).toEqual([NAME]);
    expect(readdirSync(MIGRATIONS)).toContain(NEWEST_ON_MAIN);
    expect(NAME > NEWEST_ON_MAIN).toBe(true);
    expect(NAME > NEWEST_PENDING_STAMP).toBe(true);
  });

  it('runs its read-only pre-flight first: live jobs of one provider that overlap stop it, by name, before anything changes', () => {
    const sql = migration();
    const preflight = sql.indexOf('DO $preflight$');
    expect(preflight).toBeGreaterThan(0);
    const before = sql.slice(0, preflight).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--'));
    expect(before).toEqual(["SET lock_timeout = '10s';"]);
    const block = sql.slice(preflight, sql.indexOf('END $preflight$;'));
    expect(block).toMatch(/RAISE EXCEPTION 'SERVICE_JOB_OVERLAPS_EXIST:/);
    // It reads every row or fails: never blind behind the forced wall.
    expect(block).toContain("PERFORM set_config('row_security', 'off', true);");
    // It reads only: never cancels, moves or releases a job.
    expect(block.replace("set_config('row_security', 'off', true)", '')).not.toMatch(/\b(UPDATE|DELETE|INSERT|ALTER|DROP)\b/);
    // Overlap is judged per provider, on live jobs, end-exclusive, with the quote job's minimum block.
    const b = normalise(block);
    expect(b).toContain(`j."scheduledFor" + interval '${QUOTE_JOB_MIN_BLOCK_MINUTES} minute' AS e`);
    expect(b).toContain(`WHERE j."scheduledFor" IS NOT NULL AND j."status" IN ('SCHEDULED', 'IN_PROGRESS')`);
    expect(b).toContain('ON c."providerId" = a."providerId" AND a.id < c.id AND a.s < c.e AND c.s < a.e');
    // And nothing in the whole forward file releases a job or moves its time.
    expect(sql).not.toMatch(/SET\s+"?(status|scheduledFor)"?\s*=/i);
  });

  it('adds the columns and tables Prisma-shaped: a quote job keeps a null end and no service', () => {
    const sql = normalise(migration());
    expect(sql).toContain('ALTER TABLE "service_jobs" ADD COLUMN "endsAt" TIMESTAMP(3), ADD COLUMN "offeringId" TEXT;');
    expect(sql).toContain('ALTER TABLE "service_providers" ADD COLUMN "weeklyHours" JSONB;');
    expect(sql).toContain('"price" DECIMAL(12,2) NOT NULL');
    expect(sql).toContain('ALTER TABLE "service_jobs" ADD CONSTRAINT "service_jobs_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "service_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;');
    for (const t of NEW_TABLES) expect(sql).toContain(`CREATE INDEX "${t}_tenantId_idx" ON "${t}"("tenantId");`);
    // No back-fill: every existing job is a quote job.
    expect(sql).not.toMatch(/UPDATE "service_jobs"/);
  });

  it('carries the provider-time DDL, the tenant wall and the tenant lineage exactly as the code writes them', () => {
    const sql = normalise(migration());
    for (const statement of providerTimeDdl()) expect(sql).toContain(normalise(statement));
    for (const t of NEW_TABLES) {
      for (const statement of rlsDdlFor(t)) expect(sql).toContain(normalise(statement));
      const rule = TENANT_LINEAGE_TABLES.find((r) => r.table === t);
      expect(rule, `${t} is not in TENANT_LINEAGE_TABLES`).toMatchObject({ parent: 'service_providers', fk: 'providerId' });
      for (const statement of tenantLineageDdl().filter((s) => s.includes(rule!.trigger))) expect(sql).toContain(normalise(statement));
      expect(TENANT_TABLES).toContain(t);
    }
  });

  it('the exclusion is per provider over the time each live job holds, [start, end) or the minimum block', () => {
    const ddl = normalise(providerTimeDdl().join(';\n'));
    expect(ddl).toContain(`ADD CONSTRAINT "${SERVICE_JOB_EXCLUSION}" EXCLUDE USING gist ("providerId" WITH =, ${SERVICE_JOB_RANGE_SQL} WITH &&) WHERE ("scheduledFor" IS NOT NULL AND "status" IN ('SCHEDULED', 'IN_PROGRESS'));`);
    expect(ddl).toContain('CREATE EXTENSION IF NOT EXISTS btree_gist');
    expect(ddl).toContain('CHECK ("endsAt" IS NULL OR ("scheduledFor" IS NOT NULL AND "endsAt" > "scheduledFor"))');
    expect(ddl).toContain('CHECK ("durationMinutes" BETWEEN 5 AND 600)');
    expect(ddl).toContain('CHECK ("price" > 0)');
    // The identical-start unique is not retired (an identical start is an overlap too).
    expect(migration()).not.toMatch(/service_jobs_provider_slot_live_key/);
  });

  it('the rollback refuses while it would lose something, reads past the forced wall, removes what the migration made, and its own applied ledger row', () => {
    const back = rollback();
    const lines = back.split('\n').map((l) => l.trim());
    const begin = lines.indexOf('BEGIN;');
    expect(begin, 'rollback.sql has no BEGIN;').toBeGreaterThanOrEqual(0);
    expect(lines.slice(begin + 1).find((l) => l !== '' && !l.startsWith('--'))).toBe('SET LOCAL row_security = off;');
    for (const code of ['PRO_OFFERINGS_IN_USE', 'PRO_TIME_OFF_IN_USE', 'PRO_HOURS_IN_USE', 'PRO_BOOKED_JOBS_EXIST']) {
      expect(back).toMatch(new RegExp(`RAISE EXCEPTION '${code}:`));
    }
    const created = [...migration().matchAll(/CREATE (?:OR REPLACE )?FUNCTION (\w+)\(/g)].map((m) => m[1]).sort();
    const dropped = [...back.matchAll(/DROP FUNCTION (\w+)\(/g)].map((m) => m[1]).sort();
    expect(dropped).toEqual(created);
    for (const t of NEW_TABLES) expect(back).toContain(`DROP TABLE "${t}";`);
    expect(back).toContain(`DROP CONSTRAINT "${SERVICE_JOB_EXCLUSION}";`);
    expect(back).toContain('ALTER TABLE "service_jobs" DROP COLUMN "endsAt", DROP COLUMN "offeringId";');
    expect(back).not.toMatch(/DELETE FROM "?service_jobs"?|UPDATE "?service_jobs"?/);
    expect(back).toContain(`"migration_name" = '${NAME}' AND "rolled_back_at" IS NULL`);
  });
});

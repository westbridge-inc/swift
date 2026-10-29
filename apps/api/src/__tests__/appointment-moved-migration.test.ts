import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// [BOOK-P3 · COORD ruling 29 Oct 2026 (b)] The two "moved by the business / provider" stamps ship once, after main,
// with their rollback: two nullable columns, no backfill (a move made before has no window, the rule it was made
// under), nothing else touched.
// ---------------------------------------------------------------------------

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const NAME = '20261029060000_appointment_moved_free_cancel';
const DIR = path.join(MIGRATIONS, NAME);
/** The newest migration on main when this was written, and the newest pending stamp then (BILL-PRO PR1 + others). */
const NEWEST_ON_MAIN = '20261029020000_pos_export_sync';
const NEWEST_PENDING_STAMP = '20261029041000';
const statements = (sql: string) => sql.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--'));

describe('the appointment-moved migration', () => {
  it('ships once, with its rollback, after main and above the pending stamps', () => {
    expect(existsSync(path.join(DIR, 'migration.sql')), `${NAME} is missing`).toBe(true);
    expect(existsSync(path.join(DIR, 'rollback.sql')), `${NAME} has no rollback.sql`).toBe(true);
    expect(readdirSync(MIGRATIONS).filter((d) => d.endsWith('_appointment_moved_free_cancel'))).toEqual([NAME]);
    expect(readdirSync(MIGRATIONS)).toContain(NEWEST_ON_MAIN);
    expect(NAME > NEWEST_ON_MAIN).toBe(true);
    expect(NAME > NEWEST_PENDING_STAMP).toBe(true);
  });

  it('adds exactly the two nullable stamps, and the rollback drops exactly them', () => {
    expect(statements(readFileSync(path.join(DIR, 'migration.sql'), 'utf8'))).toEqual([
      'ALTER TABLE "orders" ADD COLUMN "appointmentMovedAt" TIMESTAMP(3);',
      'ALTER TABLE "service_jobs" ADD COLUMN "providerMovedAt" TIMESTAMP(3);',
    ]);
    expect(statements(readFileSync(path.join(DIR, 'rollback.sql'), 'utf8'))).toEqual([
      'ALTER TABLE "service_jobs" DROP COLUMN IF EXISTS "providerMovedAt";',
      'ALTER TABLE "orders" DROP COLUMN IF EXISTS "appointmentMovedAt";',
    ]);
  });

  it('the schema carries the same two optional columns', () => {
    const schema = readFileSync(path.resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
    expect(schema).toMatch(/^\s+appointmentMovedAt DateTime\?$/m);
    expect(schema).toMatch(/^\s+providerMovedAt\s+DateTime\?$/m);
  });
});

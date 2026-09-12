import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { TENANT_LINEAGE_TABLES, vendorTenantMoveDdl } from '../lib/tenant-rls';

// ---------------------------------------------------------------------------
// [PR1197-S1-04] THE MIGRATION IS THE ONLY THING THAT INSTALLS THIS IN PRODUCTION.
//
// `qr-tenant-lineage.test.ts` installs the DDL itself, from the TypeScript
// registry, so that it passes on a db-push machine that never ran a migration.
// That is deliberate and right — and it means the suite grades `tenant-rls.ts`
// and NEVER grades the migration. `prisma migrate diff` compares schema objects,
// not triggers, so the drift check cannot see the loss either.
//
// Consequence, measured: `rm -r` the migration directory and every test in the
// repository stayed green, while production silently had no QR lineage wall.
// The control that ships was the one thing nothing was pinning.
//
// So the migration FILES are graded against the generator they were produced
// from. This is the tool `readiness.test.ts` already uses on migration bytes,
// applied where it was missing.
// ---------------------------------------------------------------------------

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const QR_LINEAGE = path.join(MIGRATIONS, '20260907190000_qr_tenant_lineage');
const VENDOR_MOVE = path.join(MIGRATIONS, '20260908020000_vendor_tenant_move_guard');

/** The five tables whose lineage this PR closes. */
const QR_LINEAGE_TABLES = ['qr_codes', 'slug_redirects', 'pending_attributions', 'attribution_claims', 'scan_events'];

const read = (dir: string) => readFileSync(path.join(dir, 'migration.sql'), 'utf8');
/** Postgres and psql are whitespace-insensitive here; the test should be too. */
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('[PR1197-S1-04] the shipped migration really installs the lineage wall', () => {
  it('both migration directories exist', () => {
    // Named individually so a deletion says WHICH control left the build.
    expect(existsSync(path.join(QR_LINEAGE, 'migration.sql')), `${QR_LINEAGE} is missing — production would have no QR lineage triggers`).toBe(true);
    expect(existsSync(path.join(VENDOR_MOVE, 'migration.sql')), `${VENDOR_MOVE} is missing — a vendor could again walk away from its printed codes`).toBe(true);
  });

  it('the QR migration creates a trigger for every credit table the registry names', () => {
    const sql = read(QR_LINEAGE);
    for (const table of QR_LINEAGE_TABLES) {
      const rule = TENANT_LINEAGE_TABLES.find((r) => r.table === table);
      expect(rule, `${table} is not in TENANT_LINEAGE_TABLES — the registry and this census disagree`).toBeTruthy();
      expect(sql, `${table} has no CREATE TRIGGER in the shipped migration`).toContain(`CREATE TRIGGER ${rule!.trigger}`);
      expect(sql, `${table}'s trigger function is not created by the shipped migration`).toContain(`FUNCTION ${rule!.trigger}()`);
    }
  });

  it('the vendor-move migration is byte-equivalent to its generator', () => {
    // Generated, not hand-written, so drift between the two is impossible to
    // introduce accidentally — and visible immediately when introduced on purpose.
    const shipped = normalise(read(VENDOR_MOVE));
    for (const statement of vendorTenantMoveDdl()) {
      expect(shipped, `a statement from vendorTenantMoveDdl() is not in the shipped migration:\n${statement.slice(0, 120)}...`).toContain(normalise(statement));
    }
  });

  it('the guard and the supported move both ship — one without the other is a trap', () => {
    const sql = read(VENDOR_MOVE);
    expect(sql).toContain('CREATE TRIGGER vendors_tenant_move_guard');
    expect(sql).toContain('FUNCTION move_vendor_tenant(');
  });

  it('no later migration quietly drops these triggers', () => {
    // A DROP in a subsequent migration would leave every test green — the suites
    // install their own DDL — while production lost the wall.
    const names = [...QR_LINEAGE_TABLES.map((t) => TENANT_LINEAGE_TABLES.find((r) => r.table === t)!.trigger), 'vendors_tenant_move_guard'];
    const later = readdirSync(MIGRATIONS)
      .filter((d) => d > '20260908020000_vendor_tenant_move_guard' && existsSync(path.join(MIGRATIONS, d, 'migration.sql')));
    const offenders: string[] = [];
    for (const dir of later) {
      const sql = readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
      for (const n of names) {
        // A DROP is only a removal when nothing re-creates it in the same file.
        if (new RegExp(`DROP TRIGGER[^;]*${n}`).test(sql) && !new RegExp(`CREATE TRIGGER ${n}`).test(sql)) offenders.push(`${dir}: ${n}`);
      }
    }
    expect(offenders, 'a later migration removes a lineage trigger without re-creating it').toEqual([]);
  });
});

/**
 * The purge-fence rollback is operational, not a Prisma migration, so the
 * migration history must stay true after it runs: an empty fence rolled back
 * must leave no ledger row behind, or a later `prisma migrate deploy` would
 * report "no pending migrations" and the platform would run without the fence
 * while its history says otherwise.
 *
 * Driven end to end on a scratch database of its own on the test server:
 * real `prisma migrate deploy`, the checked-in rollback script through
 * `prisma db execute`, and a second deploy.
 *
 * [DS625] A later migration replaces two of the fence's guard functions. Rolling
 * the fence back drops those functions, so it removes that migration's history
 * row too, and the next deploy re-applies both; the later migration's own
 * rollback restores the functions exactly as the fence wrote them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { PrismaClient } from '@prisma/client';

const MIGRATION = '20260930190000_document_purge_hold_fence';
const DS625 = '20261001120000_document_hold_guard_subject_wide';
const GUARDS = ['document_extraction_guard', 'document_hold_purge_guard'] as const;
const BASE_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const withDb = (db: string): string => { const u = new URL(BASE_URL); u.pathname = `/${db}`; return u.toString(); };
const SCRATCH = `swift_test_rbk_${nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
const SCRATCH_URL = withDb(SCRATCH);
const prismaCli = createRequire(join(process.cwd(), 'package.json')).resolve('prisma/build/index.js');
const migrationBytes = readFileSync(join(process.cwd(), 'prisma', 'migrations', MIGRATION, 'migration.sql'));
const rollbackSql = readFileSync(join(process.cwd(), 'prisma', 'rollbacks', `${MIGRATION}.sql`), 'utf8');
const ds625Bytes = readFileSync(join(process.cwd(), 'prisma', 'migrations', DS625, 'migration.sql'));
const ds625RollbackSql = readFileSync(join(process.cwd(), 'prisma', 'rollbacks', `${DS625}.sql`), 'utf8');
/** The exact body (pg_proc.prosrc) each migration file gives the two guard functions. */
const bodiesIn = (sql: string) => Object.fromEntries(GUARDS.map((name) => {
  const m = new RegExp(`FUNCTION ${name}\\(\\) RETURNS trigger LANGUAGE plpgsql AS \\$\\$([\\s\\S]*?)\\$\\$;`).exec(sql);
  if (!m) throw new Error(`${name} not in migration`);
  return [name, m[1]!];
}));
const fenceBodies = bodiesIn(migrationBytes.toString('utf8'));
const ds625Bodies = bodiesIn(ds625Bytes.toString('utf8'));

let maint: PrismaClient;
let scratch: PrismaClient;
let tmp: string;

function prisma(args: string[]) {
  const run = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 240_000,
    env: { ...process.env, DATABASE_URL: SCRATCH_URL },
  });
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}
function executeSql(name: string, sql: string) {
  const file = join(tmp, name);
  writeFileSync(file, sql);
  return prisma(['db', 'execute', '--file', file, '--url', SCRATCH_URL]);
}
async function state() {
  const [row] = await scratch.$queryRawUnsafe<Array<{
    fence: boolean; ledger: number; checksum: string | null; subjectwide: boolean;
    ds625Ledger: number; ds625Checksum: string | null; guardFunctions: number;
  }>>(`
    SELECT to_regclass('public.document_purge_claim') IS NOT NULL AS fence,
      (SELECT count(*)::int FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION}' AND finished_at IS NOT NULL) AS ledger,
      (SELECT checksum FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION}' AND finished_at IS NOT NULL) AS checksum,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'doc_legal_hold' AND column_name = 'subjectWide') AS subjectwide,
      (SELECT count(*)::int FROM "_prisma_migrations" WHERE migration_name = '${DS625}' AND finished_at IS NOT NULL) AS "ds625Ledger",
      (SELECT checksum FROM "_prisma_migrations" WHERE migration_name = '${DS625}' AND finished_at IS NOT NULL) AS "ds625Checksum",
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('${GUARDS.join("','")}')) AS "guardFunctions"`);
  return row!;
}
async function liveBodies() {
  const rows = await scratch.$queryRawUnsafe<Array<{ proname: string; prosrc: string }>>(`
    SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('${GUARDS.join("','")}') ORDER BY p.proname`);
  return Object.fromEntries(rows.map((r) => [r.proname, r.prosrc]));
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'swift-purge-rollback-'));
  maint = new PrismaClient({ datasourceUrl: withDb('postgres') });
  await maint.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH}"`);
  scratch = new PrismaClient({ datasourceUrl: SCRATCH_URL });
});
afterAll(async () => {
  await scratch?.$disconnect();
  await maint?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`).catch(() => undefined);
  await maint?.$disconnect();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('purge-fence rollback keeps the migration history true', () => {
  it('an acknowledged empty rollback removes the fence AND its ledger row, so the next deploy re-applies it with the same checksum', async () => {
    const checksum = createHash('sha256').update(migrationBytes).digest('hex');
    const ds625Checksum = createHash('sha256').update(ds625Bytes).digest('hex');

    const first = prisma(['migrate', 'deploy']);
    expect(first.status, first.output).toBe(0);
    const deployed = await state();
    expect(deployed).toMatchObject({ fence: true, ledger: 1, checksum, ds625Ledger: 1, ds625Checksum, guardFunctions: 2 });
    expect(await liveBodies()).toEqual(ds625Bodies);

    // No stopped-worker acknowledgement: refused, nothing changes.
    const refused = executeSql('rollback-unacknowledged.sql', rollbackSql);
    expect(refused.status).not.toBe(0);
    expect(refused.output).toMatch(/explicit stopped-worker acknowledgement/);
    expect(await state()).toEqual(deployed);

    // Acknowledged, empty fence: the schema AND the history come back together — the
    // later migration that replaced two of the fence's functions included.
    const rolled = executeSql('rollback-acknowledged.sql', `SET app.document_purge_workers_stopped = 'true';\n${rollbackSql}`);
    expect(rolled.status, rolled.output).toBe(0);
    const removed = { fence: false, ledger: 0, checksum: null, subjectwide: false, ds625Ledger: 0, ds625Checksum: null, guardFunctions: 0 };
    expect(await state()).toEqual(removed);
    // With no fence there is nothing for the later rollback to restore: refused, nothing changes.
    const orphaned = executeSql('ds625-rollback-without-fence.sql', ds625RollbackSql);
    expect(orphaned.status).not.toBe(0);
    expect(orphaned.output).toMatch(/the document purge fence is not installed/);
    expect(await state()).toEqual(removed);

    // The history no longer claims either, so the next deploy re-applies both exactly.
    const again = prisma(['migrate', 'deploy']);
    expect(again.status, again.output).toBe(0);
    expect(again.output).not.toMatch(/No pending migrations/);
    expect(await state()).toEqual(deployed);
    expect(await liveBodies()).toEqual(ds625Bodies);
  }, 600_000);

  it('[DS625] the guard rollback restores the fence functions exactly, removes its own history row, and the next deploy re-applies it', async () => {
    const ready = prisma(['migrate', 'deploy']);
    expect(ready.status, ready.output).toBe(0);
    const deployed = await state();
    expect(deployed).toMatchObject({ fence: true, ledger: 1, ds625Ledger: 1, guardFunctions: 2 });

    const rolled = executeSql('ds625-rollback.sql', ds625RollbackSql);
    expect(rolled.status, rolled.output).toBe(0);
    expect(await state()).toEqual({ ...deployed, ds625Ledger: 0, ds625Checksum: null });
    expect(await liveBodies()).toEqual(fenceBodies);

    const again = prisma(['migrate', 'deploy']);
    expect(again.status, again.output).toBe(0);
    expect(again.output).toMatch(new RegExp(DS625));
    expect(await state()).toEqual(deployed);
    expect(await liveBodies()).toEqual(ds625Bodies);
  }, 600_000);
});

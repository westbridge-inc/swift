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
const BASE_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const withDb = (db: string): string => { const u = new URL(BASE_URL); u.pathname = `/${db}`; return u.toString(); };
const SCRATCH = `swift_test_rbk_${nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
const SCRATCH_URL = withDb(SCRATCH);
const prismaCli = createRequire(join(process.cwd(), 'package.json')).resolve('prisma/build/index.js');
const migrationBytes = readFileSync(join(process.cwd(), 'prisma', 'migrations', MIGRATION, 'migration.sql'));
const rollbackSql = readFileSync(join(process.cwd(), 'prisma', 'rollbacks', `${MIGRATION}.sql`), 'utf8');

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
  const [row] = await scratch.$queryRawUnsafe<Array<{ fence: boolean; ledger: number; checksum: string | null; subjectwide: boolean }>>(`
    SELECT to_regclass('public.document_purge_claim') IS NOT NULL AS fence,
      (SELECT count(*)::int FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION}' AND finished_at IS NOT NULL) AS ledger,
      (SELECT checksum FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION}' AND finished_at IS NOT NULL) AS checksum,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'doc_legal_hold' AND column_name = 'subjectWide') AS subjectwide`);
  return row!;
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

    const first = prisma(['migrate', 'deploy']);
    expect(first.status, first.output).toBe(0);
    const deployed = await state();
    expect(deployed).toMatchObject({ fence: true, ledger: 1, checksum });

    // No stopped-worker acknowledgement: refused, nothing changes.
    const refused = executeSql('rollback-unacknowledged.sql', rollbackSql);
    expect(refused.status).not.toBe(0);
    expect(refused.output).toMatch(/explicit stopped-worker acknowledgement/);
    expect(await state()).toEqual(deployed);

    // Acknowledged, empty fence: the schema AND the history come back together.
    const rolled = executeSql('rollback-acknowledged.sql', `SET app.document_purge_workers_stopped = 'true';\n${rollbackSql}`);
    expect(rolled.status, rolled.output).toBe(0);
    expect(await state()).toEqual({ fence: false, ledger: 0, checksum: null, subjectwide: false });

    // The history no longer claims the fence, so the next deploy re-applies it exactly.
    const again = prisma(['migrate', 'deploy']);
    expect(again.status, again.output).toBe(0);
    expect(again.output).not.toMatch(/No pending migrations/);
    expect(await state()).toEqual(deployed);
  }, 600_000);
});

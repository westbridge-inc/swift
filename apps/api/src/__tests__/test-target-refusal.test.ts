import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { refuseNonTestDatabaseInVitest, TestTargetLockError } from '../lib/test-target-lock';
import { createScopedProcessClient } from '../plugins/prisma';
import { testPrismaClient } from './helpers/test-prisma-client';

// [AUD-G7-040] Inside a vitest worker, no Prisma client is ever built on a
// database that is not a disposable test target — whichever config, harness
// or per-file `|| …/swift` fallback produced the URL. Outside vitest nothing
// changes: a deployed process builds its client exactly as before.

const DEV_DB = 'postgresql://swift:swift@localhost:5434/swift';
const REAL_LOOKING = 'postgresql://app:secret@db.internal.example:5432/swift';
const refusal = (fn: () => unknown): TestTargetLockError | null => {
  try { fn(); return null; } catch (error) { return error as TestTargetLockError; }
};

describe('[AUD-G7-040] a test builds Prisma clients on disposable databases only', () => {
  it('inside vitest: the development database, a non-loopback host and an unset URL are refused', () => {
    const vitest = { VITEST: 'true' };
    for (const url of [DEV_DB, REAL_LOOKING, undefined]) {
      const error = refusal(() => refuseNonTestDatabaseInVitest('DATABASE_URL', url, vitest));
      expect(error, String(url)).toBeInstanceOf(TestTargetLockError);
      expect(error!.code).toBe('TARGET_REFUSED');
    }
    expect(refusal(() => refuseNonTestDatabaseInVitest('DATABASE_URL', 'postgresql://swift:swift@localhost:5434/swift_test_lane', vitest))).toBeNull();
    expect(refusal(() => refuseNonTestDatabaseInVitest('DATABASE_URL', 'postgresql://x:y@127.0.0.1:1/service_free', { ...vitest, TEST_TARGET_DB_ALLOWLIST: 'service_free' }))).toBeNull();
  });

  it('outside vitest it does nothing at all, whatever the URL', () => {
    for (const url of [DEV_DB, REAL_LOOKING, undefined, 'not a url']) {
      expect(refusal(() => refuseNonTestDatabaseInVitest('DATABASE_URL', url, { NODE_ENV: 'production' }))).toBeNull();
      expect(refusal(() => refuseNonTestDatabaseInVitest('SYSTEM_DATABASE_URL', url, {}))).toBeNull();
    }
  });

  it('the process client and the raw test client both refuse the development database in this worker', () => {
    expect(refusal(() => createScopedProcessClient({ datasourceUrl: DEV_DB }))?.code).toBe('TARGET_REFUSED');
    expect(refusal(() => testPrismaClient(DEV_DB))?.code).toBe('TARGET_REFUSED');
  });

  it('a process outside vitest still builds its client on any URL, exactly as before (the plugin module, imported for real)', () => {
    const load = (extra: Record<string, string>) => spawnSync(join(process.cwd(), 'node_modules/.bin/tsx'), [
      '-e', "import('./src/plugins/prisma.ts').then(() => console.log('BUILT'), (e) => { console.log('THREW ' + String(e)); process.exit(3); })",
    ], { encoding: 'utf8', timeout: 90_000, env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'test', DATABASE_URL: REAL_LOOKING, ...extra } });
    const outside = load({});
    expect(outside.status, outside.stdout + outside.stderr).toBe(0);
    expect(outside.stdout).toContain('BUILT');
    const inside = load({ VITEST: 'true' });
    expect(inside.status).toBe(3);
    expect(inside.stdout).toContain('[TARGET_REFUSED]');
  });

  // Ratchet: raw PrismaClient constructions in test files only go down. A new
  // test takes testPrismaClient(), which checks the URL first. [18 Oct: 119]
  it('no test file adds a raw PrismaClient construction (use testPrismaClient())', () => {
    const RAW_CEILING = 119;
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.test\.ts$/.test(name) ? [path] : [];
    });
    const raw = files(join(__dirname, '..')).reduce((sum, file) => sum + (readFileSync(file, 'utf8').match(/new PrismaClient\(/g)?.length ?? 0), 0);
    expect(raw).toBeGreaterThan(0);
    expect(raw).toBeLessThanOrEqual(RAW_CEILING);
  });
});

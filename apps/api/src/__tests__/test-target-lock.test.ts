import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { prismaPlugin, systemPrismaClient, setSystemPrismaClient } from '../plugins/prisma';
import {
  assessTestTarget, destructiveGuardExtension, grantSuiteCapability, isDdl, isUnscopedMutation, resetSuiteCapabilitiesForTests, TEST_TARGET_DEFAULTS, TestTargetLockError,
  withSuiteCapability,
} from '../lib/test-target-lock';
import { environmentForTests } from './setup/target-lock';

// ---------------------------------------------------------------------------
// [R048-001] The test target lock, tested by making it REFUSE.
//
// The structural proof is a pure table. The bootstrap is spawned as a real
// process with hostile environments and must exit before it could have opened
// a socket (a host that would fail DNS proves it: a connection attempt would
// have said so). The destructive guard is driven through a real Prisma client
// on the locked test database: an unscoped delete and raw DDL are refused
// unless the suite granted itself the capability.
// ---------------------------------------------------------------------------

const GOOD = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://swift:swift@localhost:5434/swift_test', REDIS_URL: 'redis://localhost:6382/15' };
const problemsOf = (env: Record<string, string | undefined>) => { const a = assessTestTarget(env); return a.ok ? [] : a.problems; };

afterEach(() => resetSuiteCapabilitiesForTests());

describe('the structural proof', () => {
  it('accepts a loopback, disposable Postgres target and a non-zero Redis database — and nothing less', () => {
    const ok = assessTestTarget(GOOD);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.target).toEqual({ pgHost: 'localhost', pgPort: 5434, database: 'swift_test', pgUser: 'swift', redisHost: 'localhost', redisPort: 6382, redisDb: 15 });
    expect(assessTestTarget({ ...GOOD, DATABASE_URL: 'postgresql://swift:swift@127.0.0.1:5432/swift_test2' }).ok).toBe(true);
    expect(assessTestTarget({ ...GOOD, REDIS_URL: 'redis://127.0.0.1:6379?db=14' }).ok).toBe(true);
    expect(assessTestTarget({ ...GOOD, DATABASE_URL: 'postgresql://swift:swift@db:5432/swift_test', REDIS_URL: 'redis://cache:6379/15', TEST_TARGET_HOST_ALLOWLIST: 'db, cache' }).ok).toBe(true);
    expect(assessTestTarget({ ...GOOD, DATABASE_URL: 'postgresql://swift:swift@localhost:5434/my_scratch', TEST_TARGET_DB_ALLOWLIST: 'my_scratch' }).ok).toBe(true);
    expect(TEST_TARGET_DEFAULTS.REDIS_URL).toMatch(/\/15$/);
    expect(assessTestTarget({ NODE_ENV: 'test', ...TEST_TARGET_DEFAULTS }).ok).toBe(true);
  });

  it('refuses a production-looking host, a non-loopback host, an unapproved database name, Redis database 0, a missing URL and a non-test NODE_ENV — each by name', () => {
    expect(problemsOf({ ...GOOD, DATABASE_URL: 'postgresql://u:p@db.prod.internal:5432/swift_test' }).join(' ')).toMatch(/looks like a real deployment/);
    expect(problemsOf({ ...GOOD, DATABASE_URL: 'postgresql://u:p@swift-db.rds.amazonaws.com:5432/swift_test' }).join(' ')).toMatch(/looks like a real deployment/);
    expect(problemsOf({ ...GOOD, DATABASE_URL: 'postgresql://u:p@10.0.0.9:5432/swift_test' }).join(' ')).toMatch(/not loopback/);
    expect(problemsOf({ ...GOOD, DATABASE_URL: 'postgresql://swift:swift@localhost:5434/swift' }).join(' ')).toMatch(/not a disposable test database/);
    expect(problemsOf({ ...GOOD, DATABASE_URL: 'postgresql://swift:swift@localhost:5434/swift_production' }).join(' ')).toMatch(/not a disposable test database/);
    expect(problemsOf({ ...GOOD, REDIS_URL: 'redis://localhost:6382' }).join(' ')).toMatch(/database 0/);
    expect(problemsOf({ ...GOOD, REDIS_URL: 'redis://localhost:6382/0' }).join(' ')).toMatch(/database 0/);
    expect(problemsOf({ ...GOOD, REDIS_URL: 'redis://cache.prod.internal:6379/15' }).join(' ')).toMatch(/looks like a real deployment/);
    expect(problemsOf({ ...GOOD, REDIS_URL: undefined }).join(' ')).toMatch(/REDIS_URL is unset/);
    expect(problemsOf({ ...GOOD, DATABASE_URL: undefined }).join(' ')).toMatch(/DATABASE_URL is unset/);
    expect(problemsOf({ ...GOOD, DATABASE_URL: 'mysql://u:p@localhost/swift_test' }).join(' ')).toMatch(/must be a postgres URL/);
    expect(problemsOf({ ...GOOD, NODE_ENV: 'development' }).join(' ')).toMatch(/NODE_ENV must be "test"/);
    // several problems are all named, not only the first
    expect(problemsOf({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@db.prod.internal:5432/swift', REDIS_URL: 'redis://localhost:6382' }).length).toBeGreaterThanOrEqual(4);
  });

  it('a SYSTEM_DATABASE_URL — the second socket — is held to the same proof', () => {
    const ok = assessTestTarget({ ...GOOD, SYSTEM_DATABASE_URL: 'postgresql://swift:swift@127.0.0.1:5434/swift_test' });
    expect(ok.ok).toBe(true);
    const bad = assessTestTarget({ ...GOOD, SYSTEM_DATABASE_URL: 'postgresql://app:x@db.prod.swift.gy:5432/swift' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.join('\n')).toMatch(/SYSTEM_DATABASE_URL host "db.prod.swift.gy" looks like a real deployment/);
    const foreign = assessTestTarget({ ...GOOD, SYSTEM_DATABASE_URL: 'postgresql://swift:swift@localhost:5434/swift' });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.problems.join('\n')).toMatch(/SYSTEM_DATABASE_URL database "swift" is not a disposable test database/);
  });

  it('the environment for a bare run uses the disposable defaults; an exported URL is judged as exported', () => {
    expect(environmentForTests({})).toMatchObject({ DATABASE_URL: TEST_TARGET_DEFAULTS.DATABASE_URL, REDIS_URL: TEST_TARGET_DEFAULTS.REDIS_URL, NODE_ENV: 'test' });
    expect(environmentForTests({ DATABASE_URL: 'postgresql://u:p@db.prod.internal/swift' })['DATABASE_URL']).toBe('postgresql://u:p@db.prod.internal/swift');
  });
});

describe('the bootstrap exits before opening a socket', () => {
  const setupScript = resolve(process.cwd(), 'src/__tests__/setup/target-lock.ts');
  const tsx = resolve(process.cwd(), 'node_modules/.bin/tsx');
  const spawn = (env: Record<string, string | undefined>) => spawnSync(tsx, [setupScript, '--check'], {
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries({ PATH: process.env['PATH'], HOME: process.env['HOME'], ...env }).filter(([, v]) => v !== undefined)) as Record<string, string>,
    timeout: 60_000,
  });

  it('a production-looking host, an unapproved database, Redis database 0 and an externally supplied hostile URL each refuse with exit 1 and the refusal text — never a connection error', () => {
    const cases: Array<[string, Record<string, string | undefined>, RegExp]> = [
      ['production-looking host', { NODE_ENV: 'test', DATABASE_URL: 'postgresql://u:p@db.prod.invalid:5432/swift_test', REDIS_URL: GOOD.REDIS_URL }, /looks like a real deployment/],
      ['unapproved database', { NODE_ENV: 'test', DATABASE_URL: 'postgresql://swift:swift@localhost:5434/swift', REDIS_URL: GOOD.REDIS_URL }, /not a disposable test database/],
      ['redis database 0', { NODE_ENV: 'test', DATABASE_URL: GOOD.DATABASE_URL, REDIS_URL: 'redis://localhost:6382' }, /database 0/],
      ['a shell-exported non-loopback URL', { NODE_ENV: 'test', DATABASE_URL: 'postgresql://u:p@10.9.9.9:5432/swift_test', REDIS_URL: GOOD.REDIS_URL }, /not loopback/],
    ];
    for (const [label, env, text] of cases) {
      const r = spawn(env);
      expect(r.status, label).toBe(1);
      expect(r.stderr, label).toMatch(text);
      expect(r.stderr, label).toContain('no connection was opened');
      expect(`${r.stdout}${r.stderr}`, label).not.toMatch(/ENOTFOUND|ECONNREFUSED|getaddrinfo|P1001/);
    }
  });

  it('the locked test target passes the gate and prints a fingerprint without a credential', () => {
    const r = spawn({ NODE_ENV: 'test', DATABASE_URL: process.env['DATABASE_URL'] ?? GOOD.DATABASE_URL, REDIS_URL: process.env['REDIS_URL'] ?? GOOD.REDIS_URL });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/^locked localhost:\d+\/swift_test\S* redis db \d+ run [0-9a-f-]{36}/);
    expect(r.stdout).not.toContain('swift:swift');
  });
});

describe('the destructive guard', () => {
  it('is installed on BOTH process clients by the plugin itself in test mode — app.prisma and the system client refuse without a grant', async () => {
    const app = Fastify({ logger: false });
    await app.register(prismaPlugin);
    await app.ready();
    try {
      await expect(app.prisma.adFreqCounter.deleteMany({})).rejects.toMatchObject({ code: 'UNSCOPED_MUTATION_REFUSED' });
      await expect(app.prisma.$executeRawUnsafe('CREATE TABLE "r048_plugin_scratch" (id text primary key)')).rejects.toMatchObject({ code: 'DDL_REFUSED' });
      await expect(app.prisma.user.deleteMany({ where: { id: 'no-such-row' } })).resolves.toMatchObject({ count: 0 });
      // the system client is constructed by the plugin module from SYSTEM_DATABASE_URL — same disposable target here
      const restoreSys = process.env['SYSTEM_DATABASE_URL'];
      process.env['SYSTEM_DATABASE_URL'] = process.env['DATABASE_URL'] ?? GOOD.DATABASE_URL;
      setSystemPrismaClient(null);
      try {
        const sys = systemPrismaClient();
        expect(sys).not.toBeNull();
        await expect(sys!.adFreqCounter.updateMany({ where: {}, data: { count: 0 } })).rejects.toMatchObject({ code: 'UNSCOPED_MUTATION_REFUSED' });
        await expect(sys!.$executeRawUnsafe('DROP TABLE IF EXISTS "r048_plugin_scratch"')).rejects.toMatchObject({ code: 'DDL_REFUSED' });
        await sys!.$disconnect();
      } finally {
        setSystemPrismaClient(null);
        if (restoreSys === undefined) delete process.env['SYSTEM_DATABASE_URL']; else process.env['SYSTEM_DATABASE_URL'] = restoreSys;
      }
    } finally {
      await app.close();
    }
  });

  const guarded = () => new PrismaClient({ datasourceUrl: process.env['DATABASE_URL'] ?? GOOD.DATABASE_URL }).$extends(destructiveGuardExtension());

  it('classifies namespace-blind mutations and DDL', () => {
    expect(isUnscopedMutation('deleteMany', {})).toBe(true);
    expect(isUnscopedMutation('deleteMany', undefined)).toBe(true);
    expect(isUnscopedMutation('deleteMany', { where: {} })).toBe(true);
    expect(isUnscopedMutation('updateMany', { where: {}, data: { x: 1 } })).toBe(true);
    expect(isUnscopedMutation('deleteMany', { where: { id: 'a' } })).toBe(false);
    expect(isUnscopedMutation('findMany', {})).toBe(false);
    expect(isDdl('CREATE TABLE "x" (id text)')).toBe(true);
    expect(isDdl('  alter table "y" add column z int')).toBe(true);
    expect(isDdl('SELECT 1; DROP TABLE "x"')).toBe(true);
    expect(isDdl('TRUNCATE "x"')).toBe(true);
    expect(isDdl('SET LOCAL ROLE probe')).toBe(false);
    expect(isDdl('SELECT "id" FROM "orders" FOR UPDATE')).toBe(false);
    expect(isDdl('DELETE FROM "x" WHERE id = $1')).toBe(false);
  });

  it('refuses an unscoped deleteMany and raw DDL; a scoped delete passes; the explicit capability opens each, for one block or for the suite', async () => {
    const prisma = guarded();
    try {
      await expect(prisma.adFreqCounter.deleteMany({})).rejects.toBeInstanceOf(TestTargetLockError);
      await expect(prisma.adFreqCounter.deleteMany({ where: {} })).rejects.toMatchObject({ code: 'UNSCOPED_MUTATION_REFUSED' });
      await expect(prisma.adFreqCounter.updateMany({ where: {}, data: { count: 0 } })).rejects.toMatchObject({ code: 'UNSCOPED_MUTATION_REFUSED' });
      await expect(prisma.user.deleteMany({ where: { id: 'no-such-row' } })).resolves.toMatchObject({ count: 0 });
      await expect(prisma.$executeRawUnsafe('CREATE TABLE "r048_scratch" (id text primary key)')).rejects.toMatchObject({ code: 'DDL_REFUSED' });
      await expect(prisma.$executeRaw`CREATE TABLE "r048_scratch" (id text primary key)`).rejects.toMatchObject({ code: 'DDL_REFUSED' });
      await expect(prisma.$queryRawUnsafe('DROP TABLE IF EXISTS "r048_scratch"')).rejects.toMatchObject({ code: 'DDL_REFUSED' });
      await expect(prisma.$queryRaw`DROP TABLE IF EXISTS "r048_scratch"`).rejects.toMatchObject({ code: 'DDL_REFUSED' });
      // not DDL: passes
      await expect(prisma.$queryRawUnsafe('SELECT 1 AS one')).resolves.toEqual([{ one: 1 }]);
      // one block
      await withSuiteCapability('ddl', async () => {
        await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "r048_scratch" (id text primary key)');
        await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "r048_scratch"');
      });
      await expect(prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "r048_scratch"')).rejects.toMatchObject({ code: 'DDL_REFUSED' });
      await withSuiteCapability('unscoped-mutation', async () => {
        await expect(prisma.adFreqCounter.deleteMany({})).resolves.toMatchObject({ count: expect.any(Number) });
      });
      // the suite-wide grant
      grantSuiteCapability('unscoped-mutation');
      await expect(prisma.adFreqCounter.deleteMany({})).resolves.toMatchObject({ count: expect.any(Number) });
      resetSuiteCapabilitiesForTests();
      await expect(prisma.adFreqCounter.deleteMany({})).rejects.toMatchObject({ code: 'UNSCOPED_MUTATION_REFUSED' });
    } finally {
      await prisma.$disconnect();
    }
  });
});

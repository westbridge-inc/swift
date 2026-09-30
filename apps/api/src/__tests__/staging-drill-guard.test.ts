import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { scopedPrisma } from '../plugins/prisma';
import {
  judgeDrillTarget, judgeDrillEnv, readDrillFacts, assertDrillTarget, DrillRefused,
  DRILL_MARKER, STAGING_DB_HOST, STAGING_DB_PORT, type DrillFacts,
} from '../modules/ops/drills/guard';

// ---------------------------------------------------------------------------
// [STG-DRILLS] The staging drill guard. Every drill entry point (fixtures, the
// run-once job trigger) asks it first, and it must refuse unless ALL of its
// conditions hold. The proof below is built so that each condition, flipped
// ALONE on an otherwise perfect staging target, is refused: take any one
// condition out of guard.ts and its test here goes red (mutation-proven in
// the PR). A production process is refused whatever else it gets right.
// ---------------------------------------------------------------------------

/** A perfect staging target: the pilot's loadtest posture, the stack's own Postgres, a staging identity. */
const staging = (): DrillFacts => ({
  env: {
    [DRILL_MARKER]: '1',
    NODE_ENV: 'loadtest',
    PILOT_ENV: 'staging',
    DATABASE_URL: 'postgresql://swift:pw@postgres:5432/swift',
    POSTGRES_DB: 'swift',
  },
  serverDatabase: 'swift',
  identity: { deploymentId: 'swift-staging-1', environment: 'staging' },
});

/** The CI/local test harness posture: loopback, a disposable swift_test database, a test identity. */
const harness = (): DrillFacts => ({
  env: {
    [DRILL_MARKER]: '1',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://swift:swift@localhost:5434/swift_test_stgd',
  },
  serverDatabase: 'swift_test_stgd',
  identity: { deploymentId: 'local-local', environment: 'test' },
});

/** One service's block of a Compose file (the same reader journeys-isolation.test.ts uses). */
const serviceBlock = (source: string, name: string) => {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return '';
  const next = lines.slice(start + 1).findIndex((line) => /^ {2}[\w-]+:|^[a-z]+:/.test(line));
  return lines.slice(start + 1, next < 0 ? undefined : start + 1 + next).join('\n');
};

const withEnv = (f: DrillFacts, patch: Record<string, string | undefined>): DrillFacts => ({ ...f, env: { ...f.env, ...patch } });
const code = (f: DrillFacts) => {
  const v = judgeDrillTarget(f);
  return v.ok ? 'OK' : v.code;
};

describe('[STG-DRILLS] the guard accepts exactly the two postures it was built for', () => {
  it('a staging target passes, naming the stack database and the staging identity', () => {
    const v = judgeDrillTarget(staging());
    expect(v).toEqual({ ok: true, target: { posture: 'staging', host: STAGING_DB_HOST, port: STAGING_DB_PORT, database: 'swift', deploymentId: 'swift-staging-1', environment: 'staging' } });
  });

  it('the test harness passes (how CI proves the drills)', () => {
    expect(judgeDrillTarget(harness())).toMatchObject({ ok: true, target: { posture: 'test', database: 'swift_test_stgd' } });
  });

  it('the staging expectations are deploy/docker-compose.yml, not a guess: the api and worker reach postgres:5432 and POSTGRES_DB', () => {
    const compose = readFileSync(join(process.cwd(), '../../deploy/docker-compose.yml'), 'utf8');
    for (const service of ['api', 'worker']) {
      const block = serviceBlock(compose, service);
      expect(block, `${service} is missing from deploy/docker-compose.yml`).not.toBe('');
      expect(block, service).toContain(`POSTGRES_HOST: ${STAGING_DB_HOST}`);
      expect(block, service).toContain(`POSTGRES_PORT: "${STAGING_DB_PORT}"`);
      expect(block, service).toContain('POSTGRES_DB: ${POSTGRES_DB:-swift}');
    }
  });
});

describe('[STG-DRILLS] production is refused, whatever else it gets right', () => {
  it('NODE_ENV=production with the marker, the stack database and a staging identity', () => {
    expect(code(withEnv(staging(), { NODE_ENV: 'production' }))).toBe('PRODUCTION_ENV');
    expect(code(withEnv(harness(), { NODE_ENV: 'production' }))).toBe('PRODUCTION_ENV');
  });

  it('a database that declares itself production', () => {
    expect(code({ ...staging(), identity: { deploymentId: 'swift-prod', environment: 'production' } })).toBe('PRODUCTION_MARKER');
    expect(code({ ...harness(), identity: { deploymentId: 'swift-prod', environment: 'Production' } })).toBe('PRODUCTION_MARKER');
  });

  it('a data classification that is not synthetic', () => {
    expect(code(withEnv(staging(), { LOAD_TEST_DATA_CLASSIFICATION: 'real' }))).toBe('PRODUCTION_MARKER');
    expect(code(withEnv(staging(), { LOAD_TEST_DATA_CLASSIFICATION: 'synthetic' }))).toBe('OK');
  });

  it('an unknown or missing NODE_ENV is never guessed', () => {
    expect(code(withEnv(staging(), { NODE_ENV: undefined }))).toBe('RUNTIME_MODE_INVALID');
    expect(code(withEnv(staging(), { NODE_ENV: 'prod' }))).toBe('RUNTIME_MODE_INVALID');
  });
});

describe('[STG-DRILLS] the staging marker is required', () => {
  it('missing, or anything but exactly "1"', () => {
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1']) {
      expect(code(withEnv(staging(), { [DRILL_MARKER]: value })), String(value)).toBe('MARKER_MISSING');
    }
  });

  it('the marker is judged before anything else is even looked at', () => {
    expect(code({ ...withEnv(staging(), { [DRILL_MARKER]: undefined, NODE_ENV: 'production' }), identity: null })).toBe('MARKER_MISSING');
  });
});

describe('[STG-DRILLS] only the staging pilot posture (or the test harness)', () => {
  it('development is not staging', () => {
    expect(code(withEnv(staging(), { NODE_ENV: 'development' }))).toBe('NOT_STAGING_ENV');
  });
  it('loadtest without PILOT_ENV=staging is not the pilot', () => {
    expect(code(withEnv(staging(), { PILOT_ENV: undefined }))).toBe('NOT_STAGING_ENV');
    expect(code(withEnv(staging(), { PILOT_ENV: 'production' }))).toBe('NOT_STAGING_ENV');
  });
});

describe('[STG-DRILLS] the wrong database is refused', () => {
  it('no URL, or not Postgres', () => {
    expect(code(withEnv(staging(), { DATABASE_URL: undefined }))).toBe('DATABASE_URL_INVALID');
    expect(code(withEnv(staging(), { DATABASE_URL: 'mysql://root@postgres:5432/swift' }))).toBe('DATABASE_URL_INVALID');
  });

  it('staging: any host but the stack’s own postgres service on 5432', () => {
    for (const url of [
      'postgresql://swift:pw@db.internal:5432/swift',
      'postgresql://swift:pw@localhost:5432/swift',
      'postgresql://swift:pw@10.0.0.7:5432/swift',
      'postgresql://swift:pw@postgres:5433/swift',
    ]) {
      expect(code(withEnv(staging(), { DATABASE_URL: url })), url).toBe('WRONG_DB_HOST');
    }
  });

  it('a managed or production-looking host is refused BY NAME in either posture (before the positive host check)', () => {
    for (const f of [
      withEnv(staging(), { DATABASE_URL: 'postgresql://swift:pw@swift-prod.abc.rds.amazonaws.com:5432/swift' }),
      withEnv(harness(), { DATABASE_URL: 'postgresql://swift:pw@db.swiftgy.com:5432/swift_test' }),
    ]) {
      const v = judgeDrillTarget(f);
      expect(v).toMatchObject({ ok: false, code: 'WRONG_DB_HOST' });
      expect((v as { reason: string }).reason).toContain('looks like a managed or production deployment');
    }
  });

  it('staging: a database that is not the one the stack declares, or named like production', () => {
    expect(code({ ...withEnv(staging(), { DATABASE_URL: 'postgresql://swift:pw@postgres:5432/other' }), serverDatabase: 'other' })).toBe('WRONG_DB_NAME');
    expect(code(withEnv(staging(), { POSTGRES_DB: undefined }))).toBe('WRONG_DB_NAME');
    expect(code({ ...withEnv(staging(), { DATABASE_URL: 'postgresql://swift:pw@postgres:5432/swift_prod', POSTGRES_DB: 'swift_prod' }), serverDatabase: 'swift_prod' })).toBe('WRONG_DB_NAME');
  });

  it('the test harness: loopback and a disposable swift_test database only', () => {
    expect(code(withEnv(harness(), { DATABASE_URL: 'postgresql://swift:swift@postgres:5432/swift_test_stgd' }))).toBe('WRONG_DB_HOST');
    expect(code({ ...withEnv(harness(), { DATABASE_URL: 'postgresql://swift:swift@localhost:5434/swift' }), serverDatabase: 'swift' })).toBe('WRONG_DB_NAME');
  });

  it('the server must answer the name the configuration gives', () => {
    expect(code({ ...staging(), serverDatabase: 'swift_restore_20260930' })).toBe('DB_MISMATCH');
    expect(code({ ...staging(), serverDatabase: null })).toBe('DB_MISMATCH');
  });
});

describe('[STG-DRILLS] the database must say what it is', () => {
  it('no deployment identity: an unidentified database is never a target', () => {
    expect(code({ ...staging(), identity: null })).toBe('IDENTITY_MISSING');
    expect(code({ ...harness(), identity: null })).toBe('IDENTITY_MISSING');
  });

  it('staging needs a staging identity; the harness a test one', () => {
    expect(code({ ...staging(), identity: { deploymentId: 'x', environment: 'test' } })).toBe('WRONG_IDENTITY');
    expect(code({ ...harness(), identity: { deploymentId: 'x', environment: 'staging' } })).toBe('WRONG_IDENTITY');
  });
});

describe('[STG-DRILLS] the environment half refuses before any socket', () => {
  it('judgeDrillEnv needs no database facts and refuses the same env-level conditions', () => {
    expect(judgeDrillEnv(staging().env)).toMatchObject({ ok: true, target: { posture: 'staging' } });
    expect(judgeDrillEnv({ ...staging().env, [DRILL_MARKER]: undefined })).toMatchObject({ ok: false, code: 'MARKER_MISSING' });
    expect(judgeDrillEnv({ ...staging().env, NODE_ENV: 'production' })).toMatchObject({ ok: false, code: 'PRODUCTION_ENV' });
    expect(judgeDrillEnv({ ...staging().env, DATABASE_URL: 'postgresql://swift:pw@db.internal:5432/swift' })).toMatchObject({ ok: false, code: 'WRONG_DB_HOST' });
  });

  it('assertDrillTarget never reads the database for a process the environment already refuses', async () => {
    const untouchable = {
      $queryRaw: async () => { throw new Error('the database was queried'); },
      deploymentIdentity: { findUnique: async () => { throw new Error('the database was queried'); } },
    } as unknown as PrismaClient;
    for (const env of [{ ...staging().env, [DRILL_MARKER]: undefined }, { ...staging().env, NODE_ENV: 'production' }]) {
      const err = await assertDrillTarget(untouchable, env).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DrillRefused);
      expect((err as DrillRefused).code).toMatch(/MARKER_MISSING|PRODUCTION_ENV/);
    }
  });
});

describe('[STG-DRILLS] the facts come from the live connection', () => {
  const db = scopedPrisma as unknown as PrismaClient;

  it('readDrillFacts reads the server’s own database name and its deployment identity', async () => {
    const env = { ...process.env, [DRILL_MARKER]: '1' };
    const facts = await readDrillFacts(db, env);
    const configured = decodeURIComponent(new URL(process.env['DATABASE_URL'] as string).pathname.slice(1));
    expect(facts.serverDatabase).toBe(configured);
    const identity = await db.deploymentIdentity.findUnique({ where: { id: 'singleton' }, select: { deploymentId: true, environment: true } });
    expect(facts.identity).toEqual(identity ?? null);
  });
});

// ---------------------------------------------------------------------------
// [AX324 R1] Every connection the drills use is judged — not just DATABASE_URL.
// Under TENANT_RLS_BIND=1 the app re-issues system work (cleanup's runAsSystem
// deletes) on SYSTEM_DATABASE_URL. A staging primary with a production system
// login passed the old guard; each case below is refused now.
// ---------------------------------------------------------------------------
describe('[AX324 R1] the system connection is held to the same database and identity', () => {
  const SYS_SAME = 'postgresql://swift_sys:pw@postgres:5432/swift';
  const sameDb = { serverDatabase: 'swift', identity: { deploymentId: 'swift-staging-1', environment: 'staging' } };
  const withSystem = (f: DrillFacts, system: DrillFacts['system'], url = SYS_SAME): DrillFacts => ({ ...withEnv(f, { TENANT_RLS_BIND: '1', SYSTEM_DATABASE_URL: url }), system });

  it('env: a SYSTEM_DATABASE_URL naming another host, port or database is refused before any socket', () => {
    for (const url of [
      'postgresql://sys:pw@swift-prod.abc.rds.amazonaws.com:5432/swift',
      'postgresql://sys:pw@db.internal:5432/swift',
      'postgresql://sys:pw@postgres:5433/swift',
      'postgresql://sys:pw@postgres:5432/swift_live',
      'mysql://sys:pw@postgres:5432/swift',
      'not a url',
    ]) {
      expect(judgeDrillEnv({ ...staging().env, TENANT_RLS_BIND: '1', SYSTEM_DATABASE_URL: url }), url).toMatchObject({ ok: false, code: 'SYSTEM_DB_MISMATCH' });
    }
    expect(judgeDrillEnv({ ...harness().env, SYSTEM_DATABASE_URL: 'postgresql://sys:pw@localhost:5434/swift_test_other' })).toMatchObject({ ok: false, code: 'SYSTEM_DB_MISMATCH' });
  });

  it('env: a system login on the very same database is accepted, and flagged for the live read', () => {
    expect(judgeDrillEnv({ ...staging().env, TENANT_RLS_BIND: '1', SYSTEM_DATABASE_URL: SYS_SAME })).toMatchObject({ ok: true, target: { system: true } });
    expect(judgeDrillEnv(staging().env)).toMatchObject({ ok: true, target: { system: false } });
  });

  it('live: the AX324 scenario — a system connection that reaches production is refused', () => {
    expect(code(withSystem(staging(), { serverDatabase: 'swift', identity: { deploymentId: 'swift-prod', environment: 'production' } }))).toBe('PRODUCTION_MARKER');
  });

  it('live: a system connection answering another database, another deployment, or no identity is refused', () => {
    expect(code(withSystem(staging(), { ...sameDb, serverDatabase: 'swift_restore' }))).toBe('SYSTEM_DB_MISMATCH');
    expect(code(withSystem(staging(), { ...sameDb, identity: { deploymentId: 'swift-staging-2', environment: 'staging' } }))).toBe('SYSTEM_DB_MISMATCH');
    expect(code(withSystem(staging(), { ...sameDb, identity: { deploymentId: 'swift-staging-1', environment: 'test' } }))).toBe('SYSTEM_DB_MISMATCH');
    expect(code(withSystem(staging(), { ...sameDb, identity: null }))).toBe('SYSTEM_DB_MISMATCH');
  });

  it('live: a system connection the environment names but the guard never read is refused', () => {
    expect(code(withSystem(staging(), undefined))).toBe('SYSTEM_DB_UNVERIFIED');
    expect(code(withSystem(staging(), null))).toBe('SYSTEM_DB_UNVERIFIED');
  });

  it('live: the same database and identity through both logins passes', () => {
    expect(code(withSystem(staging(), sameDb))).toBe('OK');
    expect(code({ ...withSystem(harness(), { serverDatabase: 'swift_test_stgd', identity: { deploymentId: 'local-local', environment: 'test' } }, 'postgresql://sys:x@localhost:5434/swift_test_stgd') })).toBe('OK');
  });

  it('assertDrillTarget reads through the system client it is handed, and refuses on what it answers', async () => {
    const client = (db: string, identity: DrillFacts['identity']) => ({
      $queryRaw: async () => [{ db }],
      deploymentIdentity: { findUnique: async () => identity },
    }) as unknown as PrismaClient;
    const env = { ...staging().env, TENANT_RLS_BIND: '1', SYSTEM_DATABASE_URL: SYS_SAME };
    const primary = client('swift', { deploymentId: 'swift-staging-1', environment: 'staging' });
    const refused = await assertDrillTarget(primary, env, client('swift', { deploymentId: 'swift-prod', environment: 'production' })).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DrillRefused);
    expect((refused as DrillRefused).code).toBe('PRODUCTION_MARKER');
    const unread = await assertDrillTarget(primary, env).catch((e: unknown) => e);
    expect((unread as DrillRefused).code).toBe('SYSTEM_DB_UNVERIFIED');
    await expect(assertDrillTarget(primary, env, client('swift', { deploymentId: 'swift-staging-1', environment: 'staging' }))).resolves.toMatchObject({ posture: 'staging', deploymentId: 'swift-staging-1' });
  });
});

describe('[AX324 R1] Redis, the job context’s other socket, is the stack’s own', () => {
  it('staging: only the compose redis service; the harness: loopback; a managed host never', () => {
    expect(code(withEnv(staging(), { REDIS_URL: 'redis://redis:6379' }))).toBe('OK');
    expect(code(withEnv(staging(), { REDIS_URL: 'redis://cache.internal:6379' }))).toBe('WRONG_REDIS_HOST');
    expect(code(withEnv(staging(), { REDIS_URL: 'redis://localhost:6379' }))).toBe('WRONG_REDIS_HOST');
    expect(code(withEnv(staging(), { REDIS_URL: 'rediss://swift-prod.cache.amazonaws.com:6380' }))).toBe('WRONG_REDIS_HOST');
    expect(code(withEnv(staging(), { REDIS_URL: 'http://redis:6379' }))).toBe('WRONG_REDIS_HOST');
    expect(code(withEnv(harness(), { REDIS_URL: 'redis://localhost:6382/2' }))).toBe('OK');
    expect(code(withEnv(harness(), { REDIS_URL: 'redis://redis:6379' }))).toBe('WRONG_REDIS_HOST');
  });

  it('the staging expectation is deploy/docker-compose.yml, not a guess: the worker reaches redis://redis:6379', () => {
    const block = serviceBlock(readFileSync(join(process.cwd(), '../../deploy/docker-compose.yml'), 'utf8'), 'worker');
    expect(block).toContain('REDIS_URL: redis://redis:6379');
  });
});

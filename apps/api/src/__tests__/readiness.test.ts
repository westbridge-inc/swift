import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import {
  MOVER_AUTHORITY_CUTOVER_CHECKSUM,
  MOVER_AUTHORITY_CUTOVER_MIGRATION,
  MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS,
  MOVER_REVOCATION_OUTBOX_CHECKSUM,
  MOVER_REVOCATION_OUTBOX_MIGRATION,
  hasRequiredSchema,
  registerReadinessRoute,
  type RuntimeReadinessState,
} from '../plugins/readiness';

// ---------------------------------------------------------------------------
// Readiness probe (launch-readiness Phase 6): /ready is 200 only when every
// hard dependency is reachable AND the schema is migrated; 503 otherwise, so a
// booting or broken instance is kept out of the load balancer's rotation. No
// auth, no leaked internals.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const runtimeReadiness: RuntimeReadinessState = {
  checkQueues: () => true,
  checkConsumers: () => true,
};

// Mount the production route against the real plugins, so this cannot drift
// into a hand-copied, weaker probe.
beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  registerReadinessRoute(app, runtimeReadiness);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('readiness probe', () => {
  it('pins readiness to every exact single-statement online index migration', () => {
    for (const required of MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS) {
      const migration = readFileSync(resolve(
        process.cwd(),
        `prisma/migrations/${required.migration}/migration.sql`,
      ));
      expect(createHash('sha256').update(migration).digest('hex'))
        .toBe(required.checksum);

      const sql = migration.toString('utf8');
      const executable = sql
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim();
      expect(executable.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g)).toHaveLength(1);
      expect(executable.match(/;/g)).toHaveLength(1);
      expect(executable).not.toMatch(/\b(?:BEGIN|COMMIT|SET|RESET)\b/);
    }
  });

  it('pins readiness to the exact reviewed cutover migration bytes', () => {
    const migration = readFileSync(resolve(
      process.cwd(),
      'prisma/migrations/20260808021500_mover_location_authority_cutover/migration.sql',
    ));
    expect(createHash('sha256').update(migration).digest('hex'))
      .toBe(MOVER_AUTHORITY_CUTOVER_CHECKSUM);
  });

  it('pins readiness to the exact durable revocation migration bytes', () => {
    const migration = readFileSync(resolve(
      process.cwd(),
      'prisma/migrations/20260808023000_mover_revocation_outbox/migration.sql',
    ));
    expect(createHash('sha256').update(migration).digest('hex'))
      .toBe(MOVER_REVOCATION_OUTBOX_CHECKSUM);
  });

  it('returns 200 only when schema, Redis, queues, and all clocks are ready', async () => {
    const ready = Fastify({ logger: false });
    const nowMs = Date.now();
    const fakePrisma = {
      $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
        const sql = Array.from(parts).join(' ');
        if (sql.includes('information_schema.columns')) return [{ ok: true }];
        if (sql.includes('FROM "_prisma_migrations"')) return [{ ok: true }];
        return [{ nowMs: BigInt(nowMs) }];
      }),
    };
    const fakeRedis = {
      ping: vi.fn(async () => 'PONG'),
      time: vi.fn(async () => [String(Math.floor(nowMs / 1_000)), String((nowMs % 1_000) * 1_000)]),
    };
    ready.decorate('prisma', fakePrisma as never);
    ready.decorate('redis', fakeRedis as never);
    registerReadinessRoute(ready, { checkQueues: () => true, checkConsumers: () => true });

    try {
      const res = await ready.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ready).toBe(true);
      expect(body.deps.database).toBe(true);
      expect(body.deps.redis).toBe(true);
      expect(body.deps.queueInit).toBe(true);
      expect(body.deps.queueConsumers).toBe(true);
      expect(body.deps.realtime).toBe(true);
      expect(body.deps.clock).toBe(true);
    } finally {
      await ready.close();
    }
  });

  it('returns 503 when producers are healthy but no current consumer bundle is live', async () => {
    runtimeReadiness.checkConsumers = () => false;
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        ready: false,
        deps: { queueInit: true, queueConsumers: false },
      });
    } finally {
      runtimeReadiness.checkConsumers = () => true;
    }
  });

  it('returns 503 while queue initialization is partial or failed', async () => {
    runtimeReadiness.checkQueues = () => false;
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ready: false, deps: { queueInit: false } });
    } finally {
      runtimeReadiness.checkQueues = () => true;
    }
  });

  it('returns 503 when the realtime adapter has withdrawn readiness', async () => {
    runtimeReadiness.checkRealtime = () => false;
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ready: false, deps: { realtime: false } });
    } finally {
      runtimeReadiness.checkRealtime = () => true;
    }
  });

  it('returns 503 when required columns exist but the non-rolling cutover capability is absent', async () => {
    const partial = Fastify({ logger: false });
    const nowMs = Date.now();
    const fakePrisma = {
      $queryRaw: vi.fn((parts: TemplateStringsArray) => {
        const sql = Array.from(parts).join(' ');
        if (sql.includes('information_schema.columns')) {
          return Promise.resolve([{ ok: true }]);
        }
        if (sql.includes('FROM "_prisma_migrations"')) {
          return Promise.resolve([{ ok: false }]);
        }
        return Promise.resolve([{ nowMs: BigInt(nowMs) }]);
      }),
    };
    const fakeRedis = {
      ping: vi.fn(async () => 'PONG'),
      time: vi.fn(async () => [String(Math.floor(nowMs / 1_000)), String((nowMs % 1_000) * 1_000)]),
    };
    partial.decorate('prisma', fakePrisma as never);
    partial.decorate('redis', fakeRedis as never);
    registerReadinessRoute(partial, { checkQueues: () => true });

    try {
      const res = await partial.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ready: false, deps: { database: false } });
      expect(fakePrisma.$queryRaw).toHaveBeenCalled();
      const query = Array.from(fakePrisma.$queryRaw.mock.calls[0]![0]).join(' ');
      expect(query).toContain('_prisma_migrations');
      expect(fakePrisma.$queryRaw).toHaveBeenCalledTimes(3); // schema, ledger, clock
    } finally {
      await partial.close();
    }
  });

  it('requires the exact successful cutover ledger row and checksum', async () => {
    const queryRaw = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Array.from(parts).join(' ');
      if (sql.includes('information_schema.columns')) return [{ ok: true }];
      if (sql.includes('FROM "_prisma_migrations"')) {
        expect(values).toEqual([
          ...MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS.flatMap(
            ({ migration, checksum }) => [migration, checksum],
          ),
          MOVER_AUTHORITY_CUTOVER_MIGRATION,
          MOVER_AUTHORITY_CUTOVER_CHECKSUM,
          MOVER_REVOCATION_OUTBOX_MIGRATION,
          MOVER_REVOCATION_OUTBOX_CHECKSUM,
        ]);
        return [{ ok: false }];
      }
      throw new Error(`unexpected readiness query: ${sql}`);
    });

    await expect(hasRequiredSchema({ $queryRaw: queryRaw } as never)).resolves.toBe(false);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('keeps readiness bounded to schema and ledger capabilities', async () => {
    const queryRaw = vi.fn(async (parts: TemplateStringsArray) => {
      const sql = Array.from(parts).join(' ');
      if (sql.includes('information_schema.columns')) return [{ ok: true }];
      if (sql.includes('FROM "_prisma_migrations"')) return [{ ok: true }];
      throw new Error(`unexpected readiness query: ${sql}`);
    });

    await expect(hasRequiredSchema({ $queryRaw: queryRaw } as never)).resolves.toBe(true);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    const allSql = queryRaw.mock.calls
      .map(([parts]) => Array.from(parts).join(' '))
      .join('\n');
    expect(allSql).not.toContain('mover_authority_live_invariants');
    expect(allSql).not.toContain('FROM "orders"');
    expect(allSql).not.toContain('FROM "riders"');
    expect(allSql).not.toContain('FROM "drivers"');
  });

  it('requires both validated online-owner database constraints', async () => {
    const queryRaw = vi.fn(async (parts: TemplateStringsArray) => {
      const sql = Array.from(parts).join(' ');
      expect(sql).toContain('riders_online_requires_location_owner');
      expect(sql).toContain('drivers_online_requires_location_owner');
      expect(sql).toContain('c.convalidated = true');
      expect(sql).toContain("('riders_currentOrderId_idx', 'riders')");
      expect(sql).toContain("('drivers_currentRideId_idx', 'drivers')");
      expect(sql).toContain('i.indisvalid = true');
      expect(sql).toContain('i.indisready = true');
      return [{ ok: false }];
    });

    await expect(hasRequiredSchema({ $queryRaw: queryRaw } as never)).resolves.toBe(false);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('builds preparation indexes online and keeps bulk rewrites out of the final cutover', () => {
    const indexMigrations = MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS
      .map(({ migration }) => readFileSync(resolve(
        process.cwd(),
        `prisma/migrations/${migration}/migration.sql`,
      ), 'utf8'))
      .join('\n');
    const cutoverMigration = readFileSync(resolve(
      process.cwd(),
      'prisma/migrations/20260808021500_mover_location_authority_cutover/migration.sql',
    ), 'utf8');
    const certification = readFileSync(resolve(
      process.cwd(),
      'scripts/certify-mover-authority-cutover.ts',
    ), 'utf8');

    expect(indexMigrations.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g)).toHaveLength(6);
    expect(indexMigrations).not.toMatch(/(^|\n)BEGIN;/);
    expect(cutoverMigration).not.toMatch(/UPDATE\s+"(?:riders|drivers)"/);
    expect(cutoverMigration).not.toContain('COUNT(*)');
    expect(cutoverMigration.match(/EXISTS \(/g)?.length ?? 0).toBeGreaterThanOrEqual(14);
    expect(certification).toContain('CREATE INDEX "riders_currentOrderId_idx"');
    expect(certification).toContain('CREATE INDEX "drivers_currentRideId_idx"');
    expect(certification).toContain('verified-pin-timestamp-ride');
    expect(certification).toContain('unprepared-supply-and-pointer-refusal');
  });

  it('returns 503 when Redis time is materially skewed from DB/host time', async () => {
    const skewedSeconds = Math.floor(Date.now() / 1_000) - 60 * 60;
    const time = vi.spyOn(app.redis, 'time').mockResolvedValue([skewedSeconds, 0]);
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ready: false, deps: { clock: false } });
    } finally {
      time.mockRestore();
    }
  });

  it('bounds a wedged dependency instead of hanging the load-balancer probe', async () => {
    process.env['READINESS_DEPENDENCY_TIMEOUT_MS'] = '20';
    const ping = vi.spyOn(app.redis, 'ping').mockImplementation(() => new Promise(() => undefined));
    const startedAt = Date.now();
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ready: false, deps: { redis: false } });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      ping.mockRestore();
      delete process.env['READINESS_DEPENDENCY_TIMEOUT_MS'];
    }
  });

  it('leaks no internals (no versions, hostnames, connection strings)', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.body).not.toMatch(/postgres|redis:\/\/|password|localhost:5434/);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaClient } from '@prisma/client';
import {
  rescueIncentiveRefusal,
  enforceRescueIncentiveOffAtBoot,
} from '../modules/dispatch/rescue-incentive-guard';
import { buildSeedPlan, applySeedPlan, SeedRefused, type DesiredConfig, type SeedPlan } from '../modules/ops/seed-plan';
import { desiredPlatformConfig } from '../modules/ops/platform-config';
import { rescueIncentiveGyd } from '../modules/dispatch/rescue';
import { invalidateAlgoConfig } from '../modules/algo/algo-config';

// ---------------------------------------------------------------------------
// [Row 208 guard · GUARDRAILS §7] rescue.incentiveGyd is Swift's own money
// owed to a mover. Nothing pays it out yet and account deletion does not wait
// for it, so it must stay 0 until BOTH a payout path and a deletion block
// ship. Until now 0 held only as a code default: one algo_config row could
// switch it on. The guard refuses a non-zero value where config is written
// (the installer's seed plan), at boot (production readiness stays 503), and
// at the one place an offer reads it (production pays nothing).
// ---------------------------------------------------------------------------

const KEY = 'rescue.incentiveGyd';

describe('[Row 208] what counts as switching the rescue incentive on', () => {
  it('0 and an empty (JSON null) value are off; every other value is refused', () => {
    expect(rescueIncentiveRefusal(KEY, 0)).toBeNull();
    expect(rescueIncentiveRefusal(KEY, null)).toBeNull();
    for (const v of [500, 1, -1, 0.5, '500', '0', true, { amount: 500 }, [500]]) {
      expect(rescueIncentiveRefusal(KEY, v), JSON.stringify(v)).toMatch(/rescue\.incentiveGyd/);
    }
  });

  it('other keys are not this guard\'s business', () => {
    expect(rescueIncentiveRefusal('rescue.incentiveFromCascade', 3)).toBeNull();
  });
});

describe('[Row 208] the config write path refuses it', () => {
  const desiredWith = (value: unknown): DesiredConfig => {
    const base = desiredPlatformConfig();
    return { ...base, algoConfig: [...base.algoConfig, { tenantId: 'swift-default', key: KEY, value: value as never, founderGated: true, updatedBy: 'test' }] };
  };
  // The guard runs before any database read: an empty client proves it.
  const noDb = {} as unknown as PrismaClient;

  it('buildSeedPlan refuses a desired config that sets it non-zero', async () => {
    const err = await buildSeedPlan(noDb, 'postgresql://x@localhost/swift_test', desiredWith(500)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeedRefused);
    expect((err as SeedRefused).code).toBe('RESCUE_INCENTIVE_LOCKED');
  });

  it('applySeedPlan refuses it too, whatever plan it is handed', async () => {
    const err = await applySeedPlan(noDb, 'postgresql://x@localhost/swift_test', desiredWith(250), {} as SeedPlan).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeedRefused);
    expect((err as SeedRefused).code).toBe('RESCUE_INCENTIVE_LOCKED');
  });

  it('the shipped installer config passes the guard (it does not set the key at all)', () => {
    for (const row of desiredPlatformConfig().algoConfig) expect(rescueIncentiveRefusal(row.key, row.value)).toBeNull();
  });
});

type Row = { tenantId: string; key: string; value: unknown; version: number };
const prismaWith = (rows: Row[]) => ({
  algoConfig: {
    findMany: vi.fn(async () => rows.filter((r) => r.key === KEY).sort((a, b) => a.tenantId.localeCompare(b.tenantId) || b.version - a.version)),
    findFirst: vi.fn(async ({ where }: { where: { tenantId: string; key: string } }) =>
      rows.filter((r) => r.tenantId === where.tenantId && r.key === where.key).sort((a, b) => b.version - a.version)[0] ?? null),
  },
}) as unknown as PrismaClient;

describe('[Row 208] boot refuses it', () => {
  const log = () => ({ warn: vi.fn() });

  it('production: a tenant whose CURRENT version is non-zero fails the boot contract (readiness stays 503)', async () => {
    const prisma = prismaWith([{ tenantId: 't-a', key: KEY, value: 0, version: 1 }, { tenantId: 't-a', key: KEY, value: 500, version: 2 }]);
    await expect(enforceRescueIncentiveOffAtBoot(prisma, log(), { NODE_ENV: 'production' })).rejects.toThrow(/rescue\.incentiveGyd.*t-a/);
  });

  it('production: an older non-zero version that was set back to 0 boots', async () => {
    const prisma = prismaWith([{ tenantId: 't-a', key: KEY, value: 500, version: 1 }, { tenantId: 't-a', key: KEY, value: 0, version: 2 }]);
    await expect(enforceRescueIncentiveOffAtBoot(prisma, log(), { NODE_ENV: 'production' })).resolves.toEqual([]);
  });

  it('elsewhere it boots but names the tenant', async () => {
    const l = log();
    const prisma = prismaWith([{ tenantId: 't-b', key: KEY, value: 300, version: 4 }]);
    await expect(enforceRescueIncentiveOffAtBoot(prisma, l, { NODE_ENV: 'development' })).resolves.toEqual(['t-b']);
    expect(l.warn).toHaveBeenCalledTimes(1);
  });

  it('the server runs it inside the boot contract, before readiness is marked complete', () => {
    const server = readFileSync(join(process.cwd(), 'src/server.ts'), 'utf8');
    const guard = server.indexOf('await enforceRescueIncentiveOffAtBoot(app.prisma, app.log)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(server.indexOf('app.markBootContractsComplete()'));
  });
});

describe('[Row 208] an offer never carries it in production', () => {
  const env = process.env['NODE_ENV'];
  afterEach(() => { process.env['NODE_ENV'] = env; invalidateAlgoConfig(); });

  it('a non-zero row is read as 0 in production, and still as configured elsewhere', async () => {
    const prisma = prismaWith([{ tenantId: 't-c', key: KEY, value: 500, version: 1 }]);
    invalidateAlgoConfig();
    process.env['NODE_ENV'] = 'production';
    expect(await rescueIncentiveGyd(prisma, 3, 't-c')).toBe(0);
    invalidateAlgoConfig();
    process.env['NODE_ENV'] = 'development';
    expect(await rescueIncentiveGyd(prisma, 3, 't-c')).toBe(500);
  });
});

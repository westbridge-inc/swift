import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkers, QUEUE_NAMES, type JobContext } from '../jobs/queue';
import { NotificationService } from '../modules/notification/notification.service';

const state = vi.hoisted(() => ({ workers: new Map<string, (job: unknown) => Promise<unknown>>() }));
vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) { state.workers.set(name, processor); }
    on() { return this; }
    async close() {}
  },
}));
vi.mock('../modules/safety/sos.service', () => ({ SosService: class { async promoteExpiredGrace() { return []; } } }));
vi.mock('../modules/safety/ops-alert', () => ({
  syncOpsAlertReadReceipts: async () => 0,
  escalateOverdueOpsAlerts: async () => ({ platformPage: [] }),
  scanOpsAlerts: async () => ({}), runOpsAlertDrillIfDue: async () => ({}),
}));
vi.mock('../modules/safety/trip-share.service', () => ({ rotateLegacyTripShareTokens: async () => ({ rotated: 0 }), notifyTripShareGuardians: async () => 0 }));
vi.mock('../modules/safety/sos-retrigger', () => ({ importLegacyRetriggers: async () => [], scanSosRetriggers: async () => ({}) }));
vi.mock('../modules/safety/evidence.service', () => ({ EvidenceService: class { async appendLiveFixes() {} } }));
vi.mock('../providers/notifications/channels', () => ({ getChannels: () => ({ sms: {} }) }));

beforeEach(() => { state.workers.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('scheduled SOS watchdog recipient isolation', () => {
  it.each([
    ['REVIEW', '0', 0],
    ['REVIEW', '1', 0],
    ['PRODUCTION', '0', 1],
    ['PRODUCTION', '1', 1],
  ] as const)('%s alert with worker kill=%s delivers %i real pages', async (kind, killed, pages) => {
    vi.stubEnv('SOS_ESCALATION_WORKER_KILL', killed);
    const subjectTenant = `synthetic-${kind.toLowerCase()}`;
    const send = vi.spyOn(NotificationService.prototype, 'send').mockResolvedValue('synthetic-notice');
    const audience = vi.fn().mockResolvedValue([{ id: 'synthetic-super-admin' }]);
    const query = vi.fn(async (parts: TemplateStringsArray | { sql: string }) => {
      const sql = Array.isArray(parts) ? parts.join('?') : (parts as { sql: string }).sql;
      // The legacy page is PENDING but not claimable during retry backoff.
      if (sql.includes('WITH candidate')) return [];
      if (sql.includes('extract(epoch')) return [{ sosAlertId: 'synthetic-alert', tenantId: subjectTenant, ageSeconds: 600 }];
      if (sql.includes('count(*)')) return [{ pending: 1n, failed: 0n }];
      if (sql.includes('SELECT a.')) return [];
      throw new Error(`Unexpected watchdog SQL: ${sql}`);
    });
    const ctx = {
      prisma: {
        $queryRaw: query,
        tenant: { findUnique: vi.fn().mockResolvedValue({ kind }) },
        user: { findMany: audience },
        alertDelivery: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      },
      io: {},
      redis: { options: {}, set: vi.fn().mockResolvedValue('OK'), del: vi.fn().mockResolvedValue(1) },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as JobContext;
    await createWorkers(ctx, {} as never);
    const processor = state.workers.get(QUEUE_NAMES.SAFETY); // [row 331] the safety lane runs the SOS tick
    expect(processor).toBeDefined();
    await processor!({ name: 'promote-sos-grace', data: {} });
    expect(query.mock.calls.some(([sql]) => (Array.isArray(sql) ? sql.join('') : (sql as { sql: string }).sql).includes('extract(epoch'))).toBe(true);
    expect(send).toHaveBeenCalledTimes(pages);
    expect(audience).toHaveBeenCalledTimes(pages);
    if (pages) {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ userId: 'synthetic-super-admin' }));
      expect(audience).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ OR: [{ tenantId: subjectTenant }, { roles: { has: 'SUPER_ADMIN' } }] }),
      }));
    } else {
      // No ops-page dedupe key was claimed: the review alert paged nobody. (The
      // only other write is the completed tick's own stamp [#1794 S3-1].)
      const keys = (ctx.redis.set as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(([key]) => String(key));
      expect(keys.filter((key) => !key.startsWith('safety:tick-completed:'))).toEqual([]);
    }
  });

  // The scan returns the oldest stuck alerts first. Demo alerts are dropped
  // BEFORE the cap of 20 pages a tick, so old demo alerts can never fill the
  // cap and hide a real SOS behind them (GUARDRAILS §3).
  const WATCHDOG_KEY = 'ops_page:sos-active-without-page:';
  const watchdogTick = async (stuck: Array<{ sosAlertId: string; tenantId: string; ageSeconds: number }>) => {
    vi.stubEnv('SOS_ESCALATION_WORKER_KILL', '0');
    const send = vi.spyOn(NotificationService.prototype, 'send').mockResolvedValue('synthetic-notice');
    const audience = vi.fn().mockResolvedValue([{ id: 'synthetic-super-admin' }]);
    const query = vi.fn(async (parts: TemplateStringsArray | { sql: string }) => {
      const sql = Array.isArray(parts) ? parts.join('?') : (parts as { sql: string }).sql;
      if (sql.includes('WITH candidate')) return [];
      if (sql.includes('extract(epoch')) return stuck;
      if (sql.includes('count(*)')) return [{ pending: 0n, failed: BigInt(stuck.length) }];
      if (sql.includes('SELECT a.')) return [];
      throw new Error(`Unexpected watchdog SQL: ${sql}`);
    });
    const ctx = {
      prisma: {
        $queryRaw: query,
        tenant: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ kind: where.id === 'synthetic-review' ? 'REVIEW' : 'PRODUCTION' })) },
        user: { findMany: audience },
        alertDelivery: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      },
      io: {},
      redis: { options: {}, set: vi.fn().mockResolvedValue('OK'), del: vi.fn().mockResolvedValue(1) },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as JobContext;
    await createWorkers(ctx, {} as never);
    await state.workers.get(QUEUE_NAMES.SAFETY)!({ name: 'promote-sos-grace', data: {} });
    const claimed = (ctx.redis.set as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(([key]) => String(key));
    return { send, audience, claimed };
  };

  it('21 older demo alerts do not crowd out a real one: the real alert is paged once, no demo alert is', async () => {
    const demo = Array.from({ length: 21 }, (_, i) => ({ sosAlertId: `synthetic-demo-${i}`, tenantId: 'synthetic-review', ageSeconds: 90_000 - i }));
    const { send, audience, claimed } = await watchdogTick([...demo, { sosAlertId: 'synthetic-real', tenantId: 'synthetic-production', ageSeconds: 600 }]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(audience).toHaveBeenCalledTimes(1);
    expect(audience).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [{ tenantId: 'synthetic-production' }, { roles: { has: 'SUPER_ADMIN' } }] }),
    }));
    expect(claimed.filter((key) => key.startsWith(WATCHDOG_KEY))).toEqual([`${WATCHDOG_KEY}synthetic-real`]);
  });

  it('the cap still holds for real alerts: 25 real stuck alerts page the oldest 20 this tick', async () => {
    const real = Array.from({ length: 25 }, (_, i) => ({ sosAlertId: `synthetic-real-${i}`, tenantId: 'synthetic-production', ageSeconds: 90_000 - i }));
    const { send, claimed } = await watchdogTick(real);
    expect(send).toHaveBeenCalledTimes(20);
    expect(claimed.filter((key) => key.startsWith(WATCHDOG_KEY))).toEqual(real.slice(0, 20).map((r) => `${WATCHDOG_KEY}${r.sosAlertId}`));
  });
});

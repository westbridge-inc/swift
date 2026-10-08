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
    const processor = state.workers.get(QUEUE_NAMES.DISPATCH);
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
      expect(ctx.redis.set).not.toHaveBeenCalled();
    }
  });
});

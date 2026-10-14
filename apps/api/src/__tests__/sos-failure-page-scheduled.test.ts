import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkers, QUEUE_NAMES, type JobContext } from '../jobs/queue';
import { NotificationService } from '../modules/notification/notification.service';

// ---------------------------------------------------------------------------
// [AUD-L4-016] The failed-delivery pager must be WIRED to the SOS tick, not
// merely exist. The tick used to drain the outbox and, when a delivery failed,
// write one log line: nobody was paged. This runs the real dispatch worker's
// "promote-sos-grace" job with the SOS modules as recorders and requires the
// pager to run on every tick — under the worker kill switch too (it is an
// alarm, not a delivery). sos-escalation-failure-page.test.ts proves what the
// pager does on the real database.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  workers: new Map<string, (job: unknown) => Promise<unknown>>(),
  pageFailed: vi.fn(async () => ({ paged: [] as string[], review: [] as string[] })),
  drain: vi.fn(async () => ({ delivered: 0, skipped: 0, failed: 1, deadLettered: 0 })),
  escalate: vi.fn(async () => ({ escalated: [] as string[], closed: [] as string[], platformPage: [] as string[] })),
}));
vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) { state.workers.set(name, processor); }
    on() { return this; }
    async close() {}
  },
}));
vi.mock('../modules/safety/sos.service', () => ({ SosService: class { async promoteExpiredGrace() { return []; } } }));
vi.mock('../modules/safety/sos-escalation', () => ({
  sosEscalationWorkerKilled: () => process.env['SOS_ESCALATION_WORKER_KILL'] === '1',
  backfillSosEscalations: async () => ({ backfilled: [] }),
  drainSosEscalations: state.drain,
  scanSosEscalations: async () => ({ activeWithoutPage: [], pending: 0, failed: 1, liveWithoutRows: [] }),
  pageFailedSosEscalations: state.pageFailed,
}));
vi.mock('../modules/safety/ops-alert', () => ({
  syncOpsAlertReadReceipts: async () => 0,
  escalateOverdueOpsAlerts: state.escalate,
  scanOpsAlerts: async () => ({}), runOpsAlertDrillIfDue: async () => ({ opened: null }),
}));
vi.mock('../modules/safety/trip-share.service', () => ({ rotateLegacyTripShareTokens: async () => ({ rotated: 0 }), notifyTripShareGuardians: async () => 0 }));
vi.mock('../modules/safety/sos-retrigger', () => ({ importLegacyRetriggers: async () => [], scanSosRetriggers: async () => ({}) }));
vi.mock('../modules/safety/evidence.service', () => ({ EvidenceService: class { async appendLiveFixes() {} } }));
vi.mock('../providers/notifications/channels', () => ({ getChannels: () => ({ sms: {} }) }));

beforeEach(() => { state.workers.clear(); state.pageFailed.mockClear(); state.drain.mockClear(); state.escalate.mockClear(); });
afterEach(() => { vi.unstubAllEnvs(); });

async function runSosTick() {
  const ctx = {
    prisma: { $queryRaw: vi.fn(async () => []) },
    io: {},
    redis: { options: {}, set: vi.fn().mockResolvedValue('OK'), del: vi.fn().mockResolvedValue(1) },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as JobContext;
  await createWorkers(ctx, {} as never);
  const processor = state.workers.get(QUEUE_NAMES.DISPATCH);
  expect(processor, 'the dispatch worker exists').toBeDefined();
  await processor!({ name: 'promote-sos-grace', data: {} });
  return ctx;
}

describe('[AUD-L4-016] every SOS tick pages on-call operations about failed deliveries', () => {
  it.each([
    ['the worker running', '0', 1],
    ['the worker kill switch on', '1', 0],
  ] as const)('with %s, the pager runs once, on the tick’s own database, with a real notification service', async (_label, killed, drains) => {
    vi.stubEnv('SOS_ESCALATION_WORKER_KILL', killed);
    const ctx = await runSosTick();
    expect(state.drain).toHaveBeenCalledTimes(drains);
    expect(state.pageFailed).toHaveBeenCalledTimes(1);
    const [prisma, notifications] = state.pageFailed.mock.calls[0] as unknown as [unknown, unknown];
    expect(prisma).toBe(ctx.prisma);
    expect(notifications).toBeInstanceOf(NotificationService);
  });

  it('a pager that throws never takes the rest of the tick down, and is logged without its words', async () => {
    state.pageFailed.mockRejectedValueOnce(new Error('pager blew up texting +5926001234'));
    const ctx = await runSosTick();
    expect(state.pageFailed).toHaveBeenCalledTimes(1);
    expect(state.escalate, 'the ops-alert ladder still ran after the pager threw').toHaveBeenCalledTimes(1);
    const lines = JSON.stringify((ctx.log.error as ReturnType<typeof vi.fn>).mock.calls);
    expect(lines).toContain('the failed-delivery pager could not run this tick');
    expect(lines).not.toContain('5926001234');
  });
});

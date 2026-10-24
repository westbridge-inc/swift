import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('a failed hire-licence reminder does not prevent the daily retention purge', async () => {
  const source = readFileSync(join(__dirname, '../jobs/queue.ts'), 'utf8');
  const start = source.indexOf('const expired = await verification.expireLapsedDocuments();');
  const end = source.indexOf('// Review-SLA watchdog:', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end).replace('let purged: number;', 'let purged;');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const run = new AsyncFunction('verification', 'ctx', body);
  const effects: string[] = [];
  const verification = {
    expireLapsedDocuments: async () => { effects.push('expire'); return 0; },
    sendExpiryReminders: async () => { effects.push('remind'); return 0; },
    scheduleRejectedDocumentRetention: async () => { effects.push('schedule-rejected'); return 0; },
    sweepAbandonedApplications: async () => { effects.push('abandoned'); return { noticed: 0, purged: 0, failed: 0 }; },
    sweepStaleUnclaimedUploads: async () => { effects.push('uploads'); return { people: 0, erased: 0, held: 0, pending: 0 }; },
    purgeExpiredDocuments: async () => { effects.push('purge'); return 0; },
    // [owner 15 Oct · no grace] TRANSFORMED: the sweep is the hire-licence sweep (was hirePermitGraceSweep).
    hireLicenceSweep: async () => { effects.push('grace'); throw new Error('synthetic grace unavailable'); },
  };
  const ctx = { log: { error: () => effects.push('logged'), info: () => undefined } };
  await expect(run(verification, ctx)).rejects.toThrow('synthetic grace unavailable');
  expect(effects).toEqual(['expire', 'remind', 'schedule-rejected', 'abandoned', 'uploads', 'purge', 'grace']);
});

// [R24] The rejected-document clocks are set before the reaper runs, and a failure setting
// them is logged, never a reason to skip the purge of what is already due.
it('a failed rejected-document schedule does not prevent the daily retention purge', async () => {
  const source = readFileSync(join(__dirname, '../jobs/queue.ts'), 'utf8');
  const start = source.indexOf('const expired = await verification.expireLapsedDocuments();');
  const end = source.indexOf('// Review-SLA watchdog:', start);
  const body = source.slice(start, end).replace('let purged: number;', 'let purged;');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const run = new AsyncFunction('verification', 'ctx', body);
  const effects: string[] = [];
  const verification = {
    expireLapsedDocuments: async () => { effects.push('expire'); return 0; },
    sendExpiryReminders: async () => { effects.push('remind'); return 0; },
    scheduleRejectedDocumentRetention: async () => { effects.push('schedule-rejected'); throw new Error('synthetic schedule unavailable'); },
    sweepAbandonedApplications: async () => { effects.push('abandoned'); throw new Error('synthetic abandoned-application sweep unavailable'); },
    sweepStaleUnclaimedUploads: async () => { effects.push('uploads'); return { people: 0, erased: 0, held: 0, pending: 0 }; },
    purgeExpiredDocuments: async () => { effects.push('purge'); return 0; },
    hireLicenceSweep: async () => { effects.push('grace'); return 0; },
  };
  const ctx = { log: { error: () => effects.push('logged'), info: () => undefined } };
  await run(verification, ctx);
  expect(effects).toEqual(['expire', 'remind', 'schedule-rejected', 'logged', 'abandoned', 'logged', 'uploads', 'purge', 'grace']);
});

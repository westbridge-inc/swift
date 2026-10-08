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
  const run = new AsyncFunction('verification', body);
  const effects: string[] = [];
  const verification = {
    expireLapsedDocuments: async () => { effects.push('expire'); return 0; },
    sendExpiryReminders: async () => { effects.push('remind'); return 0; },
    purgeExpiredDocuments: async () => { effects.push('purge'); return 0; },
    hirePermitGraceSweep: async () => { effects.push('grace'); throw new Error('synthetic grace unavailable'); },
  };
  await expect(run(verification)).rejects.toThrow('synthetic grace unavailable');
  expect(effects).toEqual(['expire', 'remind', 'purge', 'grace']);
});

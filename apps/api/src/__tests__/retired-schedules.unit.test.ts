// [Coordinator ruling, 5 Nov 2026] Fee money never feeds what Swift may pay at its discretion. The monthly job that set
// aside a share of fees is gone from the code, but a repeatable registration lives in Redis, not in the code, so a
// deployed server keeps firing it unless a boot removes it. Reads the registration the way the worker boots.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { removeRetiredSchedules, RETIRED_SCHEDULES } from '../jobs/retired-schedules';
import { JOB_RECOVERY } from '../jobs/recovery-policy';

const queueText = readFileSync(join(__dirname, '..', 'jobs', 'queue.ts'), 'utf8');

describe('the retired monthly provisioning', () => {
  it('a registration left in Redis is removed at boot, and only that one', async () => {
    const queue = {
      getRepeatableJobs: vi.fn(async () => [
        { name: 'rlp-sweep', key: 'keep-sweep' },
        { name: 'rlp-reserve-provision', key: 'old-provision' },
        { name: 'retention-sweep', key: 'keep-retention' },
      ]),
      removeRepeatableByKey: vi.fn(async () => true),
    };
    await removeRetiredSchedules(queue);
    expect(queue.removeRepeatableByKey.mock.calls).toEqual([['old-provision']]);
  });

  it('a boot with nothing to retire removes nothing, and repeating it is safe', async () => {
    const queue = { getRepeatableJobs: vi.fn(async () => [{ name: 'rlp-sweep', key: 'keep-sweep' }]), removeRepeatableByKey: vi.fn(async () => true) };
    await removeRetiredSchedules(queue);
    await removeRetiredSchedules(queue);
    expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
  });

  it('nothing schedules or runs it, and the boot calls the removal on the queue it lived on', () => {
    expect(RETIRED_SCHEDULES).toContain('rlp-reserve-provision');
    expect(queueText).not.toMatch(/add\('rlp-reserve-provision'/);
    expect(queueText).not.toMatch(/job\.name === 'rlp-reserve-provision'/);
    expect(queueText).not.toMatch(/provisionReserveForPreviousMonth/);
    expect(queueText).toMatch(/removeRetiredSchedules\(queues\.verificationQueue\)/);
    expect(Object.keys(JOB_RECOVERY)).not.toContain('rlp-reserve-provision');
  });
});

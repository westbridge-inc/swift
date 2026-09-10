import { describe, expect, it, vi } from 'vitest';
import { scheduleRecurringJobs } from '../jobs/queue';

function mockQueues() {
  const make = () => ({ add: vi.fn().mockResolvedValue(undefined) });
  return {
    orderQueue: make(),
    subscriptionQueue: make(),
    settlementQueue: make(),
    notificationQueue: make(),
    verificationQueue: make(),
    dispatchQueue: make(),
    searchQueue: make(),
  };
}

describe('verification object cleanup scheduler', () => {
  it('registers a monitored five-minute verification-queue sweep', async () => {
    const queues = mockQueues();
    await scheduleRecurringJobs(queues as never);
    const call = queues.verificationQueue.add.mock.calls.find(
      (args: unknown[]) => args[0] === 'storage-orphan-sweep',
    );
    expect(call).toBeTruthy();
    expect(call?.[2]).toMatchObject({
      repeat: { every: 5 * 60_000 },
      removeOnComplete: 30,
      removeOnFail: 50,
    });
  });
});

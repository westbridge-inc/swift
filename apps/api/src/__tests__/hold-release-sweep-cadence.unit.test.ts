import { describe, it, expect, vi } from 'vitest';
import { scheduleRecurringJobs } from '../jobs/queue';
import { ORDER_HOLD_DEFAULT_MIN } from '../modules/order/hold-minutes';

// [#2250 REVIEW-F S4-3 · REVIEW-G concur] The held-order release sweep IS the
// release tail: an order whose hold ran out waits for the next tick before the
// store is alerted and a rider is sought. At 10 s that was a 3% tail on the old
// five-minute hold but up to ~17% on today's one-minute hold (owner 30 Oct
// 2026). The sweep now ticks every 5 s (worst case ~8% of a one-minute hold),
// and the 10 s registration an older boot left in Redis is removed: a
// repeatable lives in Redis, not in the code, so left alone it would keep
// ticking beside the new one. Pure unit test: mocked queues, the real scheduler.

type Q = {
  add: ReturnType<typeof vi.fn>;
  getRepeatableJobs: ReturnType<typeof vi.fn>;
  removeRepeatableByKey: ReturnType<typeof vi.fn>;
};

function mockQueues(dispatchRepeatables: Array<{ key: string; name: string; every?: string | null; pattern?: string | null }> = []) {
  const make = (repeatables: unknown[] = []): Q => ({
    add: vi.fn().mockResolvedValue(undefined),
    getRepeatableJobs: vi.fn().mockResolvedValue(repeatables),
    removeRepeatableByKey: vi.fn().mockResolvedValue(true),
  });
  return {
    orderQueue: make(),
    subscriptionQueue: make(),
    settlementQueue: make(),
    notificationQueue: make(),
    verificationQueue: make(),
    dispatchQueue: make(dispatchRepeatables),
    offerQueue: make(),
    safetyQueue: make(),
    searchQueue: make(),
  };
}

const releaseEvery = (q: ReturnType<typeof mockQueues>) => {
  const calls = q.dispatchQueue.add.mock.calls.filter((c: unknown[]) => c[0] === 'release-held-orders');
  expect(calls, 'release-held-orders is registered exactly once').toHaveLength(1);
  return (calls[0]![2] as { repeat?: { every?: number } }).repeat?.every;
};

describe('held-order release sweep cadence [#2250 S4-3]', () => {
  it('ticks every 5 s: the release tail is at most ~8% of the one-minute hold', async () => {
    const q = mockQueues();
    await scheduleRecurringJobs(q as never);
    const every = releaseEvery(q);
    expect(every).toBe(5_000);
    expect(ORDER_HOLD_DEFAULT_MIN).toBe(1);
    // The worst case: a hold that ends just after a tick waits a whole interval.
    expect(every! / (ORDER_HOLD_DEFAULT_MIN * 60_000)).toBeLessThanOrEqual(0.1);
  });

  it('removes the release sweep an older boot registered at another cadence, and only that one', async () => {
    const q = mockQueues([
      { key: 'release-held-orders:::10000', name: 'release-held-orders', every: '10000', pattern: null },
      { key: 'release-held-orders:::5000', name: 'release-held-orders', every: '5000', pattern: null },
      { key: 'mmg-accept-expiry:::10000', name: 'mmg-accept-expiry', every: '10000', pattern: null },
      { key: 'reconcile-dispatch::::*/2 * * * *', name: 'reconcile-dispatch', every: null, pattern: '*/2 * * * *' },
    ]);
    await scheduleRecurringJobs(q as never);
    const removed = q.dispatchQueue.removeRepeatableByKey.mock.calls.map((c: unknown[]) => c[0]);
    expect(removed).toContain('release-held-orders:::10000');
    expect(removed).not.toContain('release-held-orders:::5000');
    expect(removed).not.toContain('mmg-accept-expiry:::10000');
    expect(removed).not.toContain('reconcile-dispatch::::*/2 * * * *');
    expect(releaseEvery(q)).toBe(5_000);
  });

  it('removes nothing on a boot that finds only the current registration (idempotent)', async () => {
    const q = mockQueues([{ key: 'release-held-orders:::5000', name: 'release-held-orders', every: '5000', pattern: null }]);
    await scheduleRecurringJobs(q as never);
    const removed = q.dispatchQueue.removeRepeatableByKey.mock.calls.map((c: unknown[]) => c[0]);
    expect(removed.filter((k: unknown) => String(k).startsWith('release-held-orders'))).toEqual([]);
  });
});

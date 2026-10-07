import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import { enqueueScanEvent, flushScanLog, resetScanLogForTests, scanEventsLostTotal, startScanLog, stopScanLog } from '../modules/qr/scan-log';

afterEach(async () => {
  await stopScanLog();
  resetScanLogForTests();
  vi.useRealTimers();
});

function start(createMany: ReturnType<typeof vi.fn>) {
  startScanLog({ scanEvent: { createMany } } as unknown as PrismaClient);
}
type WriteInput = { data: Prisma.ScanEventCreateManyInput[]; skipDuplicates?: boolean };
function enqueue(count = 1) {
  for (let n = 0; n < count; n++) enqueueScanEvent({ tenantId: 'synthetic-a', qrCodeId: 'synthetic-code', decision: 'WEB_RENDER' });
}

describe('QR scan buffer recovery', () => {
  it('isolates a same-tenant stale row from 499 valid rows', async () => {
    const saved: unknown[] = [];
    start(vi.fn(async ({ data }: WriteInput) => {
      if (data.some(row => row.qrCodeId === 'stale')) throw new Error('STA-1 lineage refused');
      saved.push(...data); return { count: data.length };
    }));
    enqueueScanEvent({ tenantId: 'synthetic-a', qrCodeId: 'stale', decision: 'WEB_RENDER' });
    enqueue(499);
    await flushScanLog();
    expect(saved).toHaveLength(499);
    expect(scanEventsLostTotal()).toBe(1);
  });

  it('retries a temporary outage as a batch without pretending rows are invalid', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('synthetic connection timeout')).mockResolvedValue({ count: 3 });
    start(write); enqueue(3);
    await flushScanLog();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.map(call => call[0].data.length)).toEqual([3, 3]);
    expect(scanEventsLostTotal()).toBe(0);
  });

  it('reuses immutable row IDs after a commit with an unknown response', async () => {
    const persisted = new Map<string, unknown>();
    const write = vi.fn(async ({ data, skipDuplicates }: WriteInput): Promise<{ count: number }> => {
      expect(skipDuplicates).toBe(true);
      for (const row of data) { expect(row.id).toEqual(expect.any(String)); persisted.set(row.id!, row); }
      if (write.mock.calls.length === 1) throw new Error('synthetic connection lost after commit');
      return { count: 0 };
    });
    start(write); enqueue(3);
    await flushScanLog();
    expect(write).toHaveBeenCalledTimes(2);
    expect(persisted.size).toBe(3);
    expect(write.mock.calls[0]![0].data).toEqual(write.mock.calls[1]![0].data);
    expect(scanEventsLostTotal()).toBe(0);
  });

  it('bounds retry and accounts for every shed event on a persistent outage', async () => {
    const write = vi.fn().mockRejectedValue(new Error('synthetic outage'));
    start(write); enqueue(3);
    await stopScanLog();
    expect(write).toHaveBeenCalledTimes(3);
    expect(scanEventsLostTotal()).toBe(3);
  });

  it('serializes timer, explicit flush and shutdown while the writer is held', async () => {
    vi.useFakeTimers();
    let release!: () => void, reached!: () => void, releaseSecond!: () => void, reachedSecond!: () => void;
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const readySecond = new Promise<void>(resolve => { reachedSecond = resolve; });
    const holdSecond = new Promise<void>(resolve => { releaseSecond = resolve; });
    let active = 0, peak = 0;
    const write = vi.fn(async ({ data }: WriteInput): Promise<{ count: number }> => {
      active++; peak = Math.max(peak, active);
      if (write.mock.calls.length === 1) { reached(); await hold; }
      else { reachedSecond(); await holdSecond; }
      active--; return { count: data.length };
    });
    start(write); enqueue(501);
    vi.advanceTimersByTime(2000);
    await ready;
    const flush = flushScanLog(), stop = stopScanLog();
    let stopped = false;
    void stop.then(() => { stopped = true; });
    vi.advanceTimersByTime(6000);
    release();
    await readySecond;
    try {
      for (let n = 0; n < 10; n++) await Promise.resolve();
      expect(stopped).toBe(false);
    } finally { releaseSecond(); }
    await Promise.all([flush, stop]);
    expect(peak).toBe(1);
    expect(write.mock.calls.map(call => call[0].data.length)).toEqual([500, 1]);
    expect(scanEventsLostTotal()).toBe(0);
  });
});

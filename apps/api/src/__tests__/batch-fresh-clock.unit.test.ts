import { afterEach, describe, expect, it, vi } from 'vitest';
import { batchClock } from '../utils/batch-clock';
import { BillingService } from '../modules/billing/billing.service';
import { MmgCheckoutService } from '../modules/billing/mmg-checkout.service';

// [REVIEW-M #1832 S3-1] A batch takes its clock once. A long batch that hands that one
// instant to every item dates a late item in the past: the return re-anchor proof (which
// refuses a caller's clock minutes off the database's) falls back, and stamps and expiries
// read stale. Each item now gets the run's clock moved on by the real time the run took.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const STEP = 40; // the real time each item takes here
const AT = new Date('2031-01-01T12:00:00.000Z'); // a chosen instant: it stays chosen
type Fn = (...args: never[]) => unknown;
const spy = (target: object, method: string) => vi.spyOn(target as Record<string, Fn>, method as never);

/** Each item is dated later than the one before by the real time between them, from the chosen instant on. */
function freshPerItem(nows: Date[], count: number) {
  expect(nows).toHaveLength(count);
  expect(nows[0]!.getTime()).toBeGreaterThanOrEqual(AT.getTime());
  for (let i = 1; i < nows.length; i += 1) {
    expect(nows[i]!.getTime() - nows[i - 1]!.getTime()).toBeGreaterThanOrEqual(STEP - 5);
  }
  expect(nows.at(-1)!.getTime() - AT.getTime()).toBeLessThan(60_000);
}

const savedDriver = process.env['MMG_DRIVER'];
afterEach(() => {
  vi.restoreAllMocks();
  if (savedDriver === undefined) delete process.env['MMG_DRIVER'];
  else process.env['MMG_DRIVER'] = savedDriver;
});

describe('batchClock', () => {
  it('is the start instant plus the real time the batch has run, never backwards', () => {
    let elapsed = 0;
    const clock = batchClock(AT, () => elapsed);
    expect(clock().toISOString()).toBe(AT.toISOString());
    elapsed = 90_000;
    expect(clock().getTime()).toBe(AT.getTime() + 90_000);
    elapsed = -5;
    expect(clock().getTime()).toBe(AT.getTime());
  });

  it('moves with the real clock by default', async () => {
    const clock = batchClock(AT);
    const first = clock().getTime();
    await sleep(STEP);
    expect(clock().getTime() - first).toBeGreaterThanOrEqual(STEP - 5);
  });

  it('a test that freezes the clock (fake Date) freezes the batch clock with it, to the millisecond', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(AT);
      const clock = batchClock(new Date());
      await sleep(STEP); // real time passes; the frozen clock does not
      expect(clock().getTime()).toBe(AT.getTime());
      vi.setSystemTime(AT.getTime() + 1_000); // the test moves its clock: the batch moves with it
      expect(clock().getTime()).toBe(AT.getTime() + 1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a wall-clock step back never dates a later item before an earlier one', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(AT);
      const clock = batchClock(new Date());
      vi.setSystemTime(AT.getTime() + 5_000);
      expect(clock().getTime()).toBe(AT.getTime() + 5_000);
      vi.setSystemTime(AT.getTime() + 2_000); // the wall clock is stepped back 3 s
      expect(clock().getTime()).toBe(AT.getTime() + 5_000);
      vi.setSystemTime(AT.getTime() + 7_000);
      expect(clock().getTime()).toBe(AT.getTime() + 7_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('[REVIEW-M #1832 S3-1] a long batch dates each item with a fresh clock', () => {
  it('runBillingCycle bills each due subscription at the run clock moved on, not at its start', async () => {
    const prisma = { subscription: { findMany: vi.fn().mockResolvedValue([{ id: 'sub-1' }, { id: 'sub-2' }, { id: 'sub-3' }]) } };
    const billing = new BillingService(prisma as never, {} as never, {} as never);
    spy(billing, 'recoverConfirmationSettlements').mockResolvedValue(0 as never);
    spy(billing, 'sweepFeeRises').mockResolvedValue({ told: 0, applied: 0, deferred: 0, dropped: 0 } as never);
    spy(billing, 'loadUsdPricing').mockResolvedValue(null as never);
    const nows: Date[] = [];
    spy(billing, 'billSubscription').mockImplementation((async (_sub: unknown, now: Date) => {
      nows.push(now);
      await sleep(STEP);
      return 'skipped';
    }) as never);
    const result = await billing.runBillingCycle(AT);
    expect(result).toMatchObject({ processed: 3, skipped: 3, errors: 0 });
    freshPerItem(nows, 3);
  });

  it('pollPendingMmgCharges looks up (and so settles or expires) each MMG request at the run clock moved on', async () => {
    process.env['MMG_DRIVER'] = 'sandbox';
    const payments = [1, 2, 3].map((n) => ({
      id: `pay-${n}`, subscriptionId: `sub-${n}`, status: 'PENDING', paymentMethod: 'MOBILE_MONEY', externalRef: `ext-${n}`,
      lastPolledAt: null, pollBackoffSec: 30, periodStart: AT, createdAt: AT, expiresAt: null, clientKey: null,
    }));
    const stamped: Date[] = [];
    const prisma = {
      subscriptionPayment: {
        findMany: vi.fn().mockResolvedValue(payments),
        updateMany: vi.fn(async ({ data }: { data: { lastPolledAt: Date } }) => { stamped.push(data.lastPolledAt); return { count: 1 }; }),
      },
      subscription: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })) },
    };
    const billing = new BillingService(prisma as never, {} as never, {} as never);
    const looked: Date[] = [];
    spy(billing, 'startMmgLookup').mockImplementation((async (_sub: unknown, _paymentId: string, now: Date) => {
      looked.push(now);
      await sleep(STEP);
      return null;
    }) as never);
    const out = await billing.pollPendingMmgCharges(AT);
    expect(out.stillPending).toBe(3);
    freshPerItem(looked, 3);
    // The backoff stamp keeps the run's start (the due filter read it): an earlier stamp only means a sooner retry.
    expect(stamped.map((d) => d.getTime())).toEqual([AT, AT, AT].map((d) => d.getTime()));
  });

  it('pollIntents expires, verifies and reconciles each checkout at the poll clock moved on', async () => {
    const prisma = {
      mmgCheckoutIntent: { findMany: vi.fn().mockResolvedValueOnce([{ id: 'open-1' }, { id: 'open-2' }]).mockResolvedValueOnce([{ id: 'due-1' }, { id: 'due-2' }]) },
    };
    const checkout = new MmgCheckoutService(prisma as never, {} as never, {} as never);
    spy(checkout, 'pruneUnmatchedObservations').mockResolvedValue(0 as never);
    const seen: Date[] = [];
    const record = (result: unknown) => (async (...args: unknown[]) => {
      seen.push(args.find((a) => a instanceof Date) as Date);
      await sleep(STEP);
      return result;
    }) as never;
    spy(checkout, 'expireUnanswered').mockImplementation(record(true));
    spy(checkout, 'verify').mockImplementation(record('CONFIRMING'));
    spy(checkout, 'reconcileUnappliedPages').mockImplementation(record(0));
    const out = await checkout.pollIntents(AT);
    expect(out).toEqual({ expired: 2, checked: 2 });
    freshPerItem(seen, 5);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { batchClock } from '../utils/batch-clock';
import { BillingService } from '../modules/billing/billing.service';
import { MmgCheckoutService } from '../modules/billing/mmg-checkout.service';

// [REVIEW-M #1832 S3-1] A batch takes its clock once. A long batch that hands that one
// instant to every item dates a late item in the past: the return re-anchor proof (which
// refuses a caller's clock minutes off the database's) falls back, and stamps and expiries
// read stale. Each item is now dated when it is really processed; a caller standing at a
// chosen instant (a test, a replay) gets exactly that instant for every item; a frozen fake
// Date gives the frozen instant, to the millisecond.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const STEP = 40; // the real time each item takes here
const AT = new Date('2031-01-01T12:00:00.000Z'); // a chosen instant: it stays chosen
type Fn = (...args: never[]) => unknown;
const spy = (target: object, method: string) => vi.spyOn(target as Record<string, Fn>, method as never);

/** Each item is dated when it really runs: later than the one before by the real time between them. */
function freshPerItem(nows: Date[], count: number, startedAt: number) {
  expect(nows).toHaveLength(count);
  expect(nows[0]!.getTime()).toBeGreaterThanOrEqual(startedAt);
  for (let i = 1; i < nows.length; i += 1) {
    expect(nows[i]!.getTime() - nows[i - 1]!.getTime()).toBeGreaterThanOrEqual(STEP - 5);
  }
  expect(nows.at(-1)!.getTime() - startedAt).toBeLessThan(60_000);
}
/** A chosen instant stays exactly that instant for every item. */
const exactly = (nows: Date[], count: number, at: Date) => expect(nows.map((d) => d.getTime())).toEqual(Array(count).fill(at.getTime()));

const savedDriver = process.env['MMG_DRIVER'];
afterEach(() => {
  vi.restoreAllMocks();
  if (savedDriver === undefined) delete process.env['MMG_DRIVER'];
  else process.env['MMG_DRIVER'] = savedDriver;
});

describe('batchClock', () => {
  it('a chosen instant is exactly that instant for every item, however long the batch takes', async () => {
    const clock = batchClock(AT);
    expect(clock().toISOString()).toBe(AT.toISOString());
    await sleep(STEP);
    expect(clock().getTime()).toBe(AT.getTime());
    clock().setTime(0); // an item cannot move the instant for the next one
    expect(clock().getTime()).toBe(AT.getTime());
  });

  it('with no chosen instant, each item reads the real clock', async () => {
    const clock = batchClock();
    const before = Date.now();
    const first = clock().getTime();
    expect(first).toBeGreaterThanOrEqual(before);
    await sleep(STEP);
    expect(clock().getTime() - first).toBeGreaterThanOrEqual(STEP - 5);
  });

  it('a test that freezes Date (fake timers) freezes it to the millisecond, however much real time passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(AT);
      const clock = batchClock();
      await sleep(STEP); // real time passes; the frozen clock does not
      expect(clock().getTime()).toBe(AT.getTime());
      vi.setSystemTime(AT.getTime() + 1_000); // the test moves its clock: the batch follows exactly
      expect(clock().getTime()).toBe(AT.getTime() + 1_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('[REVIEW-M #1832 S3-1] a long batch dates each item when it really runs', () => {
  it('runBillingCycle bills each due subscription when it is really billed, not at the run start; a chosen or frozen instant stays exact', async () => {
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
    const startedAt = Date.now();
    const result = await billing.runBillingCycle();
    expect(result).toMatchObject({ processed: 3, skipped: 3, errors: 0 });
    freshPerItem(nows, 3, startedAt);
    // A chosen instant: every subscription is billed at exactly that instant.
    nows.length = 0;
    await billing.runBillingCycle(AT);
    exactly(nows, 3, AT);
    // A frozen fake Date: every subscription is billed at the frozen instant, to the millisecond.
    nows.length = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(AT);
      await billing.runBillingCycle();
    } finally {
      vi.useRealTimers();
    }
    exactly(nows, 3, AT);
  });

  it('pollPendingMmgCharges looks up (and so settles or expires) each MMG request when it is really processed; a chosen instant stays exact', async () => {
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
    const startedAt = Date.now();
    const out = await billing.pollPendingMmgCharges();
    expect(out.stillPending).toBe(3);
    freshPerItem(looked, 3, startedAt);
    // The backoff stamp keeps the run's start (the due filter read it): an earlier stamp only means a sooner retry.
    expect(new Set(stamped.map((d) => d.getTime())).size).toBe(1);
    expect(stamped[0]!.getTime()).toBeLessThanOrEqual(looked[0]!.getTime());
    // A chosen instant: every request is looked up, and stamped, at exactly that instant.
    looked.length = 0;
    stamped.length = 0;
    await billing.pollPendingMmgCharges(AT);
    exactly(looked, 3, AT);
    exactly(stamped, 3, AT);
  });

  it('pollIntents expires, verifies and reconciles each checkout when it is really processed', async () => {
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
    const startedAt = Date.now();
    const out = await checkout.pollIntents();
    expect(out).toEqual({ expired: 2, checked: 2 });
    freshPerItem(seen, 5, startedAt);
  });

  it('pollIntents at a chosen instant: every checkout at exactly that instant', async () => {
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
    await checkout.pollIntents(AT);
    exactly(seen, 5, AT);
  });
});

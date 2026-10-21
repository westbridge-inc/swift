import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingService } from '../modules/billing/billing.service';
import { billingErrorCode } from '../modules/billing/billing-error-code';
import { setAppLogger } from '../utils/logger';
import { AppError } from '../utils/errors';

// [COORD 18 Oct 20:33Z] The hourly billing run swallowed each subscription's
// failure (catch {}): only a count left the run, so a dunning loop that failed
// every hour was hidden 2,768 times on staging. Each failure is now logged with
// the subscription and the error's code only, never a message (it can carry
// personal data), and counted by code.

type Fn = (...args: never[]) => unknown;
const spy = (target: object, method: string) => vi.spyOn(target as Record<string, Fn>, method as never);
const PERSONAL = 'personal-data-marker';

afterEach(() => {
  vi.restoreAllMocks();
  setAppLogger(console);
});

describe('a failed subscription in the billing run is logged, never swallowed', () => {
  it('logs each failure with the subscription id and the error code only, and counts it', async () => {
    const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const record = (obj: unknown, msg?: unknown) => { lines.push({ obj: obj as Record<string, unknown>, msg: String(msg) }); };
    setAppLogger({ info: () => {}, warn: () => {}, debug: () => {}, error: record as never });
    const prisma = { subscription: { findMany: vi.fn().mockResolvedValue([{ id: 'sub-ok' }, { id: 'sub-app' }, { id: 'sub-db' }, { id: 'sub-plain' }]) } };
    const billing = new BillingService(prisma as never, {} as never, {} as never);
    spy(billing, 'recoverConfirmationSettlements').mockResolvedValue(0 as never);
    spy(billing, 'sweepFeeRises').mockResolvedValue({ told: 0, applied: 0, deferred: 0, dropped: 0 } as never);
    spy(billing, 'loadUsdPricing').mockResolvedValue(null as never);
    spy(billing, 'billSubscription').mockImplementation((async (sub: { id: string }) => {
      if (sub.id === 'sub-app') throw new AppError(409, 'FEE_PAUSED', `paused for ${PERSONAL}`);
      if (sub.id === 'sub-db') throw Object.assign(new Error(`Unique constraint failed for ${PERSONAL}`), { code: 'P2002', name: 'PrismaClientKnownRequestError' });
      if (sub.id === 'sub-plain') throw new TypeError(`cannot read ${PERSONAL}`);
      return 'succeeded';
    }) as never);
    const result = await billing.runBillingCycle(new Date());
    expect(result).toMatchObject({ processed: 4, succeeded: 1, errors: 3 });
    const failures = lines.filter((l) => l.obj['subscriptionId']);
    expect(failures.map((l) => [l.obj['subscriptionId'], l.obj['code']])).toEqual([
      ['sub-app', 'FEE_PAUSED'], ['sub-db', 'P2002'], ['sub-plain', 'TypeError'],
    ]);
    for (const l of failures) {
      expect(Object.keys(l.obj).sort()).toEqual(['code', 'subscriptionId']); // nothing else: no message, no stack, no error object
      expect(JSON.stringify(l)).not.toContain(PERSONAL);
    }
    expect(result.errorCodes).toEqual({ FEE_PAUSED: 1, P2002: 1, TypeError: 1 });
  });

  it('an error code is a short code word or UNKNOWN, never free text', () => {
    expect(billingErrorCode(new AppError(400, 'INVALID_AMOUNT', 'x'))).toBe('INVALID_AMOUNT');
    expect(billingErrorCode(Object.assign(new Error('m'), { code: 'P2034' }))).toBe('P2034');
    expect(billingErrorCode(new RangeError('m'))).toBe('RangeError');
    expect(billingErrorCode(Object.assign(new Error('m'), { code: `call ${PERSONAL} now` }))).toBe('Error');
    expect(billingErrorCode({ code: 42 })).toBe('UNKNOWN');
    expect(billingErrorCode('a string thrown')).toBe('UNKNOWN');
    expect(billingErrorCode(null)).toBe('UNKNOWN');
  });
});

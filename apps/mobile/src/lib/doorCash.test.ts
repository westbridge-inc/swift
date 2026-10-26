import { describe, expect, it } from 'vitest';
import {
  doorCashDue,
  doorCashFields,
  doorCashRecordCopy,
  doorCashRecordFrom,
  doorCashReturnOnJob,
  needsReturnAnswer,
  parseCashEntry,
} from './doorCash';
import { money } from './money';

// ---------------------------------------------------------------------------
// [L02 · row 56] The phone's half of the door-cash contract (api #1542):
// what the rider typed, the exact handover fields, and the server's answer
// read back. The phone never derives a money figure the server owns.
// ---------------------------------------------------------------------------

describe('what the rider typed', () => {
  it('reads whole Guyana dollars, with group separators', () => {
    expect(parseCashEntry('2500')).toBe(2500);
    expect(parseCashEntry(' 2,500 ')).toBe(2500);
    expect(parseCashEntry('12 500')).toBe(12500);
    expect(parseCashEntry('0')).toBe(0);
  });
  it('refuses anything it would have to guess at', () => {
    for (const bad of ['', ' ', '25.50', '-100', '+100', '2,50', '1,2345', 'abc', '2500 GYD', '1e3']) {
      expect(parseCashEntry(bad), bad).toBeNull();
    }
  });
  it('stays inside the handover route ceiling (99,999,999)', () => {
    expect(parseCashEntry('99999999')).toBe(99_999_999);
    expect(parseCashEntry('100000000')).toBeNull();
  });
});

describe('the handover body fields', () => {
  it('paid: the amount only', () => {
    expect(doorCashFields({ kind: 'paid', collected: 2500 })).toEqual({ outcome: 'paid', collectedAmount: 2500 });
  });
  it('already handed over short: paid + handedOverShort', () => {
    expect(doorCashFields({ kind: 'handed-over-short', collected: 1000 })).toEqual({ outcome: 'paid', collectedAmount: 1000, handedOverShort: true });
  });
  it("can't pay with partial cash: short_payment + whether it was handed back", () => {
    expect(doorCashFields({ kind: 'cannot-pay', collected: 1000, cashReturned: true })).toEqual({ outcome: 'short_payment', collectedAmount: 1000, cashReturned: true });
    expect(doorCashFields({ kind: 'cannot-pay', collected: 1000, cashReturned: false })).toEqual({ outcome: 'short_payment', collectedAmount: 1000, cashReturned: false });
  });
  it("can't pay with nothing taken: no cashReturned (the server refuses it without partial cash)", () => {
    expect(doorCashFields({ kind: 'cannot-pay', collected: 0, cashReturned: null })).toEqual({ outcome: 'short_payment', collectedAmount: 0 });
    expect(doorCashFields({ kind: 'cannot-pay', collected: 0, cashReturned: true })).toEqual({ outcome: 'short_payment', collectedAmount: 0 });
  });
  it('partial cash with no answer is never sent', () => {
    expect(needsReturnAnswer({ kind: 'cannot-pay', collected: 1000, cashReturned: null })).toBe(true);
    expect(needsReturnAnswer({ kind: 'cannot-pay', collected: 0, cashReturned: null })).toBe(false);
    expect(needsReturnAnswer({ kind: 'paid', collected: 1000 })).toBe(false);
    expect(() => doorCashFields({ kind: 'cannot-pay', collected: 1000, cashReturned: null })).toThrow();
  });
});

describe('the amount due is the server’s', () => {
  const authority = { policy: 'mismatch-1', rail: 'CASH', paymentState: 'PENDING', custodyState: 'ARRIVED', amount: 2500, currency: 'GYD', version: 'v1', permitted: 'COLLECT_CASH_THEN_DELIVER', blockReason: null };
  it('from the door authority first', () => {
    expect(doorCashDue({ handover: authority, totalAmount: 9999 })).toEqual({ amount: 2500, currency: 'GYD' });
  });
  it('from the order row when the server sent no authority', () => {
    expect(doorCashDue({ totalAmount: '1800' })).toEqual({ amount: 1800, currency: 'GYD' });
    expect(doorCashDue({ handover: { ...authority, policy: 'unknown-policy' }, totalAmount: 1800 })).toEqual({ amount: 1800, currency: 'GYD' });
  });
  it('nothing readable = nothing shown', () => {
    expect(doorCashDue({})).toBeNull();
    expect(doorCashDue({ totalAmount: '' })).toBeNull();
    expect(doorCashDue({ totalAmount: 'n/a' })).toBeNull();
    expect(doorCashDue(null)).toBeNull();
  });
});

describe('what the server recorded, read back', () => {
  it('in full', () => {
    expect(doorCashRecordFrom({ status: 'DELIVERED', cash: { due: 2500, collected: 2500, shortfall: 0, heldForReview: false } }))
      .toEqual({ kind: 'paid-in-full', due: 2500, collected: 2500 });
  });
  it('short and held, with the server’s own shortfall', () => {
    expect(doorCashRecordFrom({ status: 'DELIVERED', cash: { due: 2500, collected: 1000, shortfall: 1499, heldForReview: true } }))
      .toEqual({ kind: 'short-held', due: 2500, collected: 1000, shortfall: 1499 });
  });
  it('partial cash returned / held', () => {
    expect(doorCashRecordFrom({ status: 'RETURNING', cashReturn: { amount: 1000, status: 'RETURNED', heldForReview: false } })).toEqual({ kind: 'returned', amount: 1000 });
    expect(doorCashRecordFrom({ status: 'RETURNING', cashReturn: { amount: 1000, status: 'HELD', heldForReview: true } })).toEqual({ kind: 'held', amount: 1000 });
  });
  it('an answer without cash detail claims none', () => {
    expect(doorCashRecordFrom({ status: 'RETURNING' })).toEqual({ kind: 'returning' });
    expect(doorCashRecordFrom({ status: 'DELIVERED' })).toEqual({ kind: 'complete' });
    expect(doorCashRecordFrom({ status: 'DELIVERED', cash: { due: 'x' } })).toEqual({ kind: 'complete' });
    expect(doorCashRecordFrom(null)).toBeNull();
    expect(doorCashRecordFrom({ status: 'FAILED' })).toBeNull();
  });
  it('the job row’s recorded return (Decimal arrives as a string)', () => {
    expect(doorCashReturnOnJob({ doorCashReturnStatus: 'HELD', doorCashReturnAmount: '1000' })).toEqual({ kind: 'held', amount: 1000 });
    expect(doorCashReturnOnJob({ doorCashReturnStatus: 'RESOLVED', doorCashReturnAmount: 750 })).toEqual({ kind: 'resolved', amount: 750 });
    expect(doorCashReturnOnJob({ doorCashReturnStatus: null, doorCashReturnAmount: null })).toBeNull();
    expect(doorCashReturnOnJob({ doorCashReturnStatus: 'HELD', doorCashReturnAmount: null })).toBeNull();
    expect(doorCashReturnOnJob(undefined)).toBeNull();
  });
});

describe('the words carry only the server’s figures', () => {
  it('a shortfall is printed as the server sent it, never recomputed', () => {
    const words = doorCashRecordCopy({ kind: 'short-held', due: 2500, collected: 1000, shortfall: 1499 }, money);
    expect(words.body).toContain('($1,499 short)');
    expect(words.held).toBe(true);
  });
  it('held cash reads as held (a person still acts); returned and resolved do not', () => {
    expect(doorCashRecordCopy({ kind: 'held', amount: 1000 }, money).held).toBe(true);
    expect(doorCashRecordCopy({ kind: 'returned', amount: 1000 }, money).held).toBe(false);
    expect(doorCashRecordCopy({ kind: 'resolved', amount: 1000 }, money).held).toBe(false);
  });
  it('never says Swift holds, refunds or deducts the money', () => {
    const all = ([
      { kind: 'paid-in-full', due: 1, collected: 1 },
      { kind: 'short-held', due: 2, collected: 1, shortfall: 1 },
      { kind: 'returned', amount: 1 },
      { kind: 'held', amount: 1 },
      { kind: 'resolved', amount: 1 },
      { kind: 'returning' },
      { kind: 'complete' },
    ] as const).map((r) => doorCashRecordCopy(r, money));
    for (const w of all) {
      const s = `${w.title} ${w.body}`;
      expect(s).not.toMatch(/Swift (holds|refunded|will refund|deducted from you)/i);
      expect(s).not.toMatch(/wallet/i);
    }
  });
});

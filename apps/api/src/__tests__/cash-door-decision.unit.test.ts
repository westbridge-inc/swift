import { describe, expect, it } from 'vitest';
import { assertGenuinelyShort, decideDoorCash, doorCashDue } from '../modules/cash/door-cash';
import { MONEY_MAX_WHOLE } from '../utils/money-schema';

describe('cash-door amounts remain exact whole money at the service boundary', () => {
  it('preserves an unstated legacy payment without inventing an attestation', () => {
    expect(decideDoorCash({ totalAmount: 3500 }, {})).toEqual({ kind: 'UNSTATED' });
  });

  it('records exact cash, including a zero-total order', () => {
    for (const due of [0, 3500, MONEY_MAX_WHOLE]) {
      expect(decideDoorCash({ totalAmount: String(due) }, { collectedAmount: due }))
        .toEqual({ kind: 'EXACT', due, collected: due });
    }
  });

  it('refuses over-collection even when a short handover is acknowledged', () => {
    expect(() => decideDoorCash({ totalAmount: 3500 }, { collectedAmount: 3501, handedOverShort: true }))
      .toThrow(expect.objectContaining({ code: 'CASH_OVER_DUE' }));
  });

  it('holds goods unless the rider attests they were already handed over short', () => {
    expect(() => decideDoorCash({ totalAmount: 3500 }, { collectedAmount: 2800 }))
      .toThrow(expect.objectContaining({ code: 'CASH_SHORT_NO_HANDOVER' }));
    expect(decideDoorCash({ totalAmount: 3500 }, { collectedAmount: 2800, handedOverShort: true }))
      .toEqual({ kind: 'SHORT_HANDED_OVER', due: 3500, collected: 2800, shortfall: 700 });
  });

  it('cannot attest an unknown amount as a short handover', () => {
    expect(() => decideDoorCash({ totalAmount: 3500 }, { handedOverShort: true }))
      .toThrow(expect.objectContaining({ code: 'CASH_AMOUNT_REQUIRED' }));
  });

  it.each([-1, 0.5, NaN, Infinity, MONEY_MAX_WHOLE + 1])('refuses invalid collected or offered money: %s', (amount) => {
    expect(() => decideDoorCash({ totalAmount: 3500 }, { collectedAmount: amount, handedOverShort: true }))
      .toThrow(expect.objectContaining({ code: 'CASH_AMOUNT_INVALID' }));
    expect(() => assertGenuinelyShort({ totalAmount: 3500 }, amount))
      .toThrow(expect.objectContaining({ code: 'CASH_AMOUNT_INVALID' }));
  });

  it.each([-1, 0.5, NaN, Infinity, null, ''])('refuses an unreadable or fractional authoritative total: %s', (totalAmount) => {
    expect(() => doorCashDue({ totalAmount }))
      .toThrow(expect.objectContaining({ code: 'ORDER_TOTAL_UNREADABLE' }));
  });

  it('only an offer below the total can start a short-payment return', () => {
    expect(assertGenuinelyShort({ totalAmount: 3500 }, 2000)).toEqual({ due: 3500, offered: 2000 });
    expect(assertGenuinelyShort({ totalAmount: 3500 }, undefined)).toEqual({ due: 3500, offered: null });
    for (const amount of [3500, 3501]) {
      expect(() => assertGenuinelyShort({ totalAmount: 3500 }, amount))
        .toThrow(expect.objectContaining({ code: 'CASH_NOT_SHORT' }));
    }
  });
});

import { describe, expect, it } from 'vitest';
import { assertGenuinelyShort, assertDoorCashOutcome, decideDoorCash, decideDoorCashReturn, doorCashDue } from '../modules/cash/door-cash';
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

  it.each(['TAXI', 'COURIER'])('does not extend the goods shortfall ruling to %s', (orderType) => {
    const order = { totalAmount: 3500, orderType };
    expect(() => decideDoorCash(order, { collectedAmount: 2800, handedOverShort: true }))
      .toThrow(expect.objectContaining({ code: 'SHORT_PAYMENT_NOT_AVAILABLE' }));
    expect(decideDoorCash(order, {})).toEqual({ kind: 'UNSTATED' });
  });

  it('cannot attest an unknown amount as a short handover', () => {
    expect(() => decideDoorCash({ totalAmount: 3500 }, { handedOverShort: true }))
      .toThrow(expect.objectContaining({ code: 'CASH_AMOUNT_REQUIRED' }));
  });

  it.each([-1, 0.5, NaN, Infinity, MONEY_MAX_WHOLE + 1])('refuses invalid collected money: %s', (amount) => {
    expect(() => decideDoorCash({ totalAmount: 3500 }, { collectedAmount: amount, handedOverShort: true }))
      .toThrow(expect.objectContaining({ code: 'CASH_AMOUNT_INVALID' }));
    expect(() => assertGenuinelyShort({ totalAmount: 3500 }, amount))
      .toThrow(expect.objectContaining({ code: 'CASH_AMOUNT_INVALID' }));
  });

  it.each([-1, 0.5, NaN, Infinity, null, ''])('refuses an unreadable or fractional authoritative total: %s', (totalAmount) => {
    expect(() => doorCashDue({ totalAmount }))
      .toThrow(expect.objectContaining({ code: 'ORDER_TOTAL_UNREADABLE' }));
  });

  it('only cash below the total can start a short-payment return', () => {
    expect(assertGenuinelyShort({ totalAmount: 3500 }, 2000)).toEqual({ due: 3500, collected: 2000 });
    expect(assertGenuinelyShort({ totalAmount: 3500 }, undefined)).toEqual({ due: 3500, collected: null });
    for (const amount of [3500, 3501]) {
      expect(() => assertGenuinelyShort({ totalAmount: 3500 }, amount))
        .toThrow(expect.objectContaining({ code: 'CASH_NOT_SHORT' }));
    }
  });
});


describe('partial cash return decisions follow the 7 Oct owner ruling', () => {
  it('records returned versus held cash as two different facts', () => {
    expect(decideDoorCashReturn({ totalAmount: 3500 }, { collectedAmount: 2000, cashReturned: true }))
      .toEqual({ amount: 2000, status: 'RETURNED', heldForReview: false });
    expect(decideDoorCashReturn({ totalAmount: 3500 }, { collectedAmount: 2000, cashReturned: false }))
      .toEqual({ amount: 2000, status: 'HELD', heldForReview: true });
  });
  it('never assumes positive cash was returned or merely offered', () => {
    expect(() => decideDoorCashReturn({ totalAmount: 3500 }, { collectedAmount: 2000 }))
      .toThrow(expect.objectContaining({ code: 'CASH_RETURN_CONFIRMATION_REQUIRED' }));
  });
  it('keeps omitted or zero cash unstated without inventing a transfer', () => {
    expect(() => decideDoorCashReturn({ totalAmount: 3500 }, {})).not.toThrow();
    expect(() => decideDoorCashReturn({ totalAmount: 3500 }, { collectedAmount: 0 })).not.toThrow();
    expect(decideDoorCashReturn({ totalAmount: 3500 }, {})).toBeUndefined();
    expect(decideDoorCashReturn({ totalAmount: 3500 }, { collectedAmount: 0 })).toBeUndefined();
  });
  it.each([undefined, 0])('cannot confirm an unknown or empty return: %s', (collectedAmount) => {
    for (const cashReturned of [true, false]) {
      expect(() => decideDoorCashReturn({ totalAmount: 3500 }, { collectedAmount, cashReturned }))
        .toThrow(expect.objectContaining({ code: 'CASH_AMOUNT_REQUIRED' }));
    }
  });
  it.each([-1, 0.5, NaN, Infinity, MONEY_MAX_WHOLE + 1])('refuses invalid partial cash: %s', (collectedAmount) => {
    expect(() => decideDoorCashReturn({ totalAmount: 3500 }, { collectedAmount, cashReturned: true }))
      .toThrow(expect.objectContaining({ code: 'CASH_AMOUNT_INVALID' }));
  });
  it('does not classify a full payment as partial cash', () => {
    for (const collectedAmount of [3500, 3501]) {
      expect(() => decideDoorCashReturn({ totalAmount: 3500 }, { collectedAmount, cashReturned: true }))
        .toThrow(expect.objectContaining({ code: 'CASH_NOT_SHORT' }));
    }
  });
  it('refuses contradictory goods and cash outcomes', () => {
    expect(() => assertDoorCashOutcome({ outcome: 'paid', cashReturned: true }))
      .toThrow(expect.objectContaining({ code: 'CASH_OUTCOME_CONFLICT' }));
    expect(() => assertDoorCashOutcome({ outcome: 'short_payment', handedOverShort: true }))
      .toThrow(expect.objectContaining({ code: 'CASH_OUTCOME_CONFLICT' }));
    expect(() => assertDoorCashOutcome({ outcome: 'paid' })).not.toThrow();
  });
});

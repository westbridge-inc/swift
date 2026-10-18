import { describe, expect, it } from 'vitest';
import { storeSwapWaitText, swapChangeText, swapDeadlineText, swapDecisionPermissions } from './substitutionCopy';

// [L09 · M028] The swap card's sentence about what approving changes, built
// from the server's swap view (priceDelta = the approval's own formula).

describe('what approving a substitute changes, as the customer reads it', () => {
  it('a line with paid options swapped for a plain substitute: the total goes down and the choices do not come along', () => {
    expect(swapChangeText({
      priceDelta: -300,
      original: { options: [{ group: 'Size', name: 'Large' }, { group: 'Extras', name: 'Cheese' }] },
    })).toBe("Approving lowers your total by $300. Your choices (Size: Large · Extras: Cheese) don't come with the swap.");
  });

  it('a dearer substitute adds the difference', () => {
    expect(swapChangeText({ priceDelta: 300, original: { options: [] } })).toBe('Approving adds $300 to your total.');
  });

  it('a same-price substitute says so', () => {
    expect(swapChangeText({ priceDelta: 0, original: { options: [] } })).toBe('Approving keeps your total the same.');
  });

  it('no swap details from the server: nothing extra is said', () => {
    expect(swapChangeText(null)).toBeNull();
    expect(swapChangeText(undefined)).toBeNull();
    expect(swapChangeText({ priceDelta: null })).toBeNull();
  });
});

it.each([0.25, -0.25, 100.75, -100.75])('shows the exact signed change %s', (delta) => {
  expect(swapChangeText({ priceDelta: delta })).toBe(delta > 0
    ? `Approving adds $${Math.abs(delta).toFixed(2)} to your total.`
    : `Approving lowers your total by $${Math.abs(delta).toFixed(2)}.`);
});

it('MMG without new decision fields stays conservative on an older server', () => {
  expect(swapDecisionPermissions({ priceDelta: 400 }, 'MOBILE_MONEY')).toMatchObject({ approve: false, reject: false });
  expect(swapDecisionPermissions({ priceDelta: 0 }, 'MOBILE_MONEY')).toMatchObject({ approve: true, reject: false });
  expect(swapDecisionPermissions(undefined, 'MOBILE_MONEY')).toMatchObject({ approve: false, reject: false });
});
it('a forbidden approval never promises a total change', () => {
  expect(swapChangeText({ priceDelta: 400, decisions: { approve: false, reject: false } })).toBeNull();
});

// [SUBSTITUTION · owner 17 Oct 2026] The customer is told how long the question waits and what happens then.
describe('how long the swap question waits', () => {
  const clock = (d: Date) => d.toISOString().slice(11, 16);
  it('cash: answer by the deadline, or the item comes off and the total drops', () => {
    expect(swapDeadlineText({ decideBy: '2026-10-17T21:23:00.000Z', ifNoAnswer: 'REMOVE' }, clock))
      .toBe("Please answer by 21:23. If you don't, it comes off your order and your total goes down.");
  });
  it('MMG: the store settles it directly', () => {
    expect(swapDeadlineText({ decideBy: '2026-10-17T21:23:00.000Z', ifNoAnswer: 'WITHDRAW' }, clock))
      .toBe("If it isn't approved by 21:23, the store settles this item with you directly.");
  });
  it.each([null, undefined, {}, { decideBy: 'not a date', ifNoAnswer: 'REMOVE' as const }, { decideBy: '2026-10-17T21:23:00.000Z' }])(
    'no usable deadline from the server: nothing extra is said (%j)', (view) => {
      expect(swapDeadlineText(view as never, clock)).toBeNull();
    },
  );
});

describe('what the store reads while it waits on the customer', () => {
  const clock = (d: Date) => d.toISOString().slice(11, 16);
  it('cash: no answer removes the item and lowers the total', () => {
    expect(storeSwapWaitText('2026-10-17T21:23:00.000Z', 'CASH', clock)).toBe('No answer by 21:23 removes the item and lowers the total.');
  });
  it('MMG: no answer closes the question and the store settles directly', () => {
    expect(storeSwapWaitText('2026-10-17T21:23:00.000Z', 'MOBILE_MONEY', clock)).toBe('No answer by 21:23 closes the question; settle the item with the customer directly.');
  });
  it.each([null, undefined, '', 'nope'])('no usable deadline: nothing is said (%s)', (raw) => {
    expect(storeSwapWaitText(raw, 'CASH', clock)).toBeNull();
  });
});

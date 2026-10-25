import { describe, expect, it } from 'vitest';
import { legacySwapItemFields, lineOptionsAsMade, MMG_SWAP_SETTLES_DIRECTLY, orderTotalAdjustable, substitutionDecideMinutes, substitutionNoAnswer, substitutionView } from '../modules/order/substitution-view';

const order = { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', orderType: 'GROCERY_DELIVERY', mmgClaimMismatchAt: null, totalAmount: 800 };
const line = { subStatus: 'PENDING', name: 'Original', quantity: 1, totalCustomer: 500, substituteItemId: 'sub', substituteName: 'Replacement', substitutePrice: 900, selectedOptions: [] };
// [L09 · Sol S2/S4] The swap view offers only the decisions the server's MMG
// money guard accepts, and a closed line never lists choices it was not made with.
describe('substitution decision permissions follow the existing money guard', () => {
  it.each([400, 900])('MMG substitute price %s offers no money-changing decision', (substitutePrice) => {
    const view = substitutionView({ ...line, substitutePrice }, order);
    expect(view).toMatchObject({ decisions: { approve: false, reject: false } });
    expect(view?.settlementGuidance).toBe(MMG_SWAP_SETTLES_DIRECTLY);
  });
  it('same-price MMG can approve, but cannot remove the paid line', () => {
    expect(substitutionView({ ...line, substitutePrice: 500 }, order)).toMatchObject({ decisions: { approve: true, reject: false } });
  });
  it('cash can approve or reject, without settlement guidance', () => {
    expect(substitutionView(line, { ...order, paymentMethod: 'CASH' })).toMatchObject({ decisions: { approve: true, reject: true }, settlementGuidance: null });
  });
  it.each(['APPROVED', 'REFUNDED', 'REJECTED'])('%s line never lists uncharged options as made', (subStatus) => {
    expect(lineOptionsAsMade({ subStatus, selectedOptions: [{ optionGroupName: 'Size', optionName: 'Large', markedUpPrice: 150 }] })).toEqual([]);
  });
});

// [SUBSTITUTION · owner 17 Oct 2026] The wait is bounded, an ops setting, and
// a bad value is never endless or instant.
describe('the swap question waits a bounded time', () => {
  it.each([
    [undefined, 10], ['', 10], ['abc', 10], ['7.5', 10], ['-4', 10],
    ['7', 7], [' 12 ', 12], ['1', 3], ['0', 3], ['45', 30], ['999999', 30],
  ] as const)('SUBSTITUTION_DECIDE_MINUTES=%s waits %s minutes', (raw, minutes) => {
    expect(substitutionDecideMinutes(raw)).toBe(minutes);
  });
  it('no answer REMOVES on cash and WITHDRAWS on MMG (its total cannot change in-app)', () => {
    expect(substitutionNoAnswer({ paymentMethod: 'CASH' })).toBe('REMOVE');
    expect(substitutionNoAnswer({ paymentMethod: 'MOBILE_MONEY' })).toBe('WITHDRAW');
  });
  it('the view carries the deadline once one is set', () => {
    const decideBy = new Date('2026-10-17T21:30:00.000Z');
    expect(substitutionView({ ...line, substituteDecideBy: decideBy }, { ...order, paymentMethod: 'CASH' })).toMatchObject({ decideBy: decideBy.toISOString(), ifNoAnswer: 'REMOVE' });
  });
});

// Builds 9/11 read only the flat fields; their card is switched on only when every word is true.
describe('what builds 9/11 are told', () => {
  const cash = { ...order, paymentMethod: 'CASH' };
  it('a cash swap both buttons can answer activates the card they carry', () => {
    expect(legacySwapItemFields(line, cash)).toEqual({ subStatus: 'PENDING', substituteName: 'Replacement', substitutePrice: 900 });
  });
  it('an MMG swap never activates it; the line name says what happens', () => {
    expect(legacySwapItemFields({ ...line, substitutePrice: 500 }, order)).toEqual({ name: 'Original (out of stock: the store will settle this item with you directly)' });
  });
  it.each(['REFUNDED', 'REJECTED'])('a %s line reads removed and charges nothing', (subStatus) => {
    expect(legacySwapItemFields({ ...line, subStatus }, cash)).toEqual({ name: 'Original (removed, not charged)', lineTotal: 0 });
  });
  it.each(['NONE', 'APPROVED'])('a %s line keeps the pre-feature shape', (subStatus) => {
    expect(legacySwapItemFields({ ...line, subStatus }, cash)).toEqual({});
  });
});

// [REVIEW-M S4-1 on #2043 · card switch-on prerequisite] Card and bank transfer are prepaid rails (both
// OFF today: checkout takes cash or MMG only). Like MMG, their total may change in-app only while the
// order still waits for the store and no payment can exist; after that it is fixed and the store
// settles item changes directly. Only cash (collected at the door) always adjusts.
describe('[REVIEW-M S4-1] every rail but cash: the total changes only before acceptance and before any payment', () => {
  const FIXED_COPY = 'This order’s total can’t change in-app once the store has accepted it or a payment exists — the store settles item changes with you directly.';
  const waiting = { status: 'PENDING', acceptedAt: null, paymentStatus: 'PENDING', mmgAttestedRef: null, customerMmgClaim: 'UNRECORDED', mmgPayUrlSnapshot: null, mmgClaimMismatchAt: null };
  const RAILS = ['CARD', 'BANK_TRANSFER', 'WALLET'] as const;
  const accepted = [
    { ...waiting, status: 'ACCEPTED', acceptedAt: new Date() },
    { ...waiting, status: 'PREPARING', acceptedAt: new Date() },
    { ...waiting, acceptedAt: new Date() },
    { ...waiting, status: 'ACCEPTED' },
  ];
  const view = (paymentMethod: string, facts: object, substitutePrice = 900) =>
    substitutionView({ ...line, substitutePrice }, { ...order, ...facts, paymentMethod, totalAmount: 800 });

  it.each(RAILS)('%s: adjustable while the order waits for the store and nothing is paid', (paymentMethod) => {
    expect(orderTotalAdjustable({ ...waiting, paymentMethod })).toBe(true);
    expect(substitutionNoAnswer({ ...waiting, paymentMethod })).toBe('REMOVE');
    expect(view(paymentMethod, waiting)).toMatchObject({ decisions: { approve: true, reject: true }, settlementGuidance: null, ifNoAnswer: 'REMOVE' });
  });

  it.each(RAILS)('%s: fixed once the store has accepted (status or acceptedAt)', (paymentMethod) => {
    for (const facts of accepted) {
      expect(orderTotalAdjustable({ ...facts, paymentMethod })).toBe(false);
      expect(substitutionNoAnswer({ ...facts, paymentMethod })).toBe('WITHDRAW');
    }
  });

  it.each(RAILS.flatMap((rail) => ['AUTHORIZED', 'CAPTURED', 'CLAIMED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'].map((status) => [rail, status] as const)))(
    '%s: fixed once a payment may exist (%s), even before the store accepts', (paymentMethod, paymentStatus) => {
      expect(orderTotalAdjustable({ ...waiting, paymentMethod, paymentStatus })).toBe(false);
      expect(substitutionNoAnswer({ ...waiting, paymentMethod, paymentStatus })).toBe('WITHDRAW');
    },
  );

  it.each([...RAILS, null, 'SOMETHING_NEW'])('%s: a fact that was not projected fails closed (never adjustable)', (paymentMethod) => {
    expect(orderTotalAdjustable({ paymentMethod })).toBe(false);
    expect(orderTotalAdjustable({ ...waiting, acceptedAt: undefined, paymentMethod })).toBe(false);
    expect(orderTotalAdjustable({ ...waiting, paymentStatus: undefined, paymentMethod })).toBe(false);
    expect(substitutionNoAnswer({ paymentMethod })).toBe('WITHDRAW');
  });

  it.each(RAILS)('%s past the window: only a same-price swap may be approved, nothing may be declined, the customer is told the store settles it', (paymentMethod) => {
    const facts = { ...waiting, paymentStatus: 'CAPTURED' };
    expect(view(paymentMethod, facts)).toMatchObject({ decisions: { approve: false, reject: false }, settlementGuidance: FIXED_COPY, ifNoAnswer: 'WITHDRAW' });
    expect(view(paymentMethod, facts, 500)).toMatchObject({ decisions: { approve: true, reject: false }, settlementGuidance: FIXED_COPY });
    const removal = substitutionView({ ...line, substituteItemId: null, substituteName: null, substitutePrice: null }, { ...order, ...facts, paymentMethod, totalAmount: 800 });
    expect(removal).toMatchObject({ kind: 'REMOVAL', decisions: { approve: false, reject: false }, settlementGuidance: FIXED_COPY, ifNoAnswer: 'WITHDRAW' });
    expect(legacySwapItemFields({ ...line, substitutePrice: 500 }, { ...order, ...facts, paymentMethod })).toEqual({ name: 'Original (out of stock: the store will settle this item with you directly)' });
  });

  it('MMG keeps its own words; cash always adjusts, accepted and collected or not (unchanged)', () => {
    expect(view('MOBILE_MONEY', { ...waiting, paymentStatus: 'CAPTURED' })).toMatchObject({ settlementGuidance: MMG_SWAP_SETTLES_DIRECTLY, ifNoAnswer: 'WITHDRAW' });
    for (const facts of [...accepted, { ...waiting, paymentStatus: 'CAPTURED' }, {}]) {
      expect(orderTotalAdjustable({ ...facts, paymentMethod: 'CASH' })).toBe(true);
      expect(substitutionNoAnswer({ ...facts, paymentMethod: 'CASH' })).toBe('REMOVE');
    }
  });
});

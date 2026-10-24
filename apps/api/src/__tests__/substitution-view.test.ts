import { describe, expect, it } from 'vitest';
import { legacySwapItemFields, lineOptionsAsMade, MMG_SWAP_SETTLES_DIRECTLY, substitutionDecideMinutes, substitutionNoAnswer, substitutionView } from '../modules/order/substitution-view';

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

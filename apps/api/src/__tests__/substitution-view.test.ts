import { describe, expect, it } from 'vitest';
import { lineOptionsAsMade, MMG_SWAP_SETTLES_DIRECTLY, substitutionView } from '../modules/order/substitution-view';

const line = { subStatus: 'PENDING', name: 'Original', quantity: 1, totalCustomer: 500, substituteItemId: 'sub', substituteName: 'Replacement', substitutePrice: 900, selectedOptions: [] };
// [L09 · Sol S2/S4] The swap view offers only the decisions the server's MMG
// money guard accepts, and a closed line never lists choices it was not made with.
describe('substitution decision permissions follow the existing money guard', () => {
  it.each([400, 900])('MMG substitute price %s offers no money-changing decision', (substitutePrice) => {
    const view = substitutionView({ ...line, substitutePrice }, 'MOBILE_MONEY');
    expect(view).toMatchObject({ decisions: { approve: false, reject: false } });
    expect(view?.settlementGuidance).toBe(MMG_SWAP_SETTLES_DIRECTLY);
  });
  it('same-price MMG can approve, but cannot remove the paid line', () => {
    expect(substitutionView({ ...line, substitutePrice: 500 }, 'MOBILE_MONEY')).toMatchObject({ decisions: { approve: true, reject: false } });
  });
  it('cash can approve or reject, without settlement guidance', () => {
    expect(substitutionView(line, 'CASH')).toMatchObject({ decisions: { approve: true, reject: true }, settlementGuidance: null });
  });
  it.each(['APPROVED', 'REFUNDED', 'REJECTED'])('%s line never lists uncharged options as made', (subStatus) => {
    expect(lineOptionsAsMade({ subStatus, selectedOptions: [{ optionGroupName: 'Size', optionName: 'Large', markedUpPrice: 150 }] })).toEqual([]);
  });
});

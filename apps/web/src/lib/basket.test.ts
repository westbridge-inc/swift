import { beforeEach, describe, expect, it } from 'vitest';
import { addGuestLine, changeGuestQuantity, clearGuestBasket, readGuestBasket, guestCart, prepareGuestMerge, settleGuestMerge } from './basket';
const soup = { vendorId: 'v1', storeSlug: 'sample-kitchen', vendorName: 'Sample Kitchen', itemId: 'soup', name: 'Soup', quantity: 1, unitPrice: 800, selectedOptions: {} };
beforeEach(() => localStorage.clear());
describe('the guest basket', () => {
  it('persists a basket and combines only identical items and choices', () => {
    addGuestLine(soup); addGuestLine(soup); addGuestLine({ ...soup, selectedOptions: { size: 'large' }, unitPrice: 1000 });
    const saved = readGuestBasket(); expect(saved.lines.map(l => l.quantity)).toEqual([2, 1]);
    expect(guestCart(saved).items.map(l => l.customerPrice)).toEqual([800, 1000]);
    expect(guestCart(saved).totalAmount).toBeUndefined();
  });
  it('asks before changing stores and preserves the first basket', () => {
    addGuestLine(soup);
    expect(addGuestLine({ ...soup, vendorId: 'v2', storeSlug: 'other' })).toBe('DIFFERENT_STORE');
    expect(readGuestBasket().lines[0]?.vendorId).toBe('v1');
  });
  it('changes quantities, removes zero lines and caps the combined quantity', () => {
    addGuestLine({ ...soup, quantity: 99 }); expect(addGuestLine(soup)).toBe('QUANTITY_LIMIT');
    const id = readGuestBasket().lines[0]!.clientLineId;
    changeGuestQuantity(id, 2); expect(readGuestBasket().lines[0]?.quantity).toBe(2);
    changeGuestQuantity(id, 0); expect(readGuestBasket().lines).toEqual([]);
  });
  it('keeps one merge key and freezes edits until a lost answer is resolved', () => {
    addGuestLine(soup); const first = prepareGuestMerge('customer-a')!;
    expect(prepareGuestMerge('customer-a')).toEqual(first);
    expect(() => addGuestLine(soup)).toThrow(/retry/i);
    expect(() => prepareGuestMerge('customer-b')).toThrow(/account/i);
    expect(() => clearGuestBasket()).toThrow(/retry/i);
    settleGuestMerge(first.key, false); expect(readGuestBasket().lines).toHaveLength(1);
    const next = prepareGuestMerge('customer-a')!; expect(next.key).not.toBe(first.key);
    settleGuestMerge(next.key, true); expect(readGuestBasket().lines).toEqual([]);
  });
  it('ignores corrupt storage and never accepts an unbounded or malformed price', () => {
    localStorage.setItem('swift_guest_basket_v1', '{broken'); expect(readGuestBasket().lines).toEqual([]);
    expect(() => addGuestLine({ ...soup, storeSlug: '../dashboard' })).toThrow();
    for (const unitPrice of [NaN, Infinity, -1]) expect(() => addGuestLine({ ...soup, unitPrice })).toThrow();
  });
});

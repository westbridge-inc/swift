import { selectionKey } from '../../../api/src/modules/order/options';
import { empty, validLine, readGuestBasket, save, type GuestLine, type GuestBasket } from './basket-storage';
export { readGuestBasket } from './basket-storage';
export type { GuestLine, GuestBasket } from './basket-storage';
export { useGuestBasket } from './basket-state';

export function guestBasketReturn(): string {
  const first = readGuestBasket().lines[0];
  return first ? first.returnPath ?? `/store/${first.storeSlug}` : '';
}
function editable(basket: GuestBasket) {
  if (basket.pending) throw new Error('Your basket upload has an unresolved answer. Retry it before changing the basket.');
}
export function addGuestLine(input: Omit<GuestLine, 'clientLineId'>): 'ADDED' | 'DIFFERENT_STORE' | 'QUANTITY_LIMIT' {
  const basket = readGuestBasket(); editable(basket);
  const candidate = { ...input, clientLineId: crypto.randomUUID(), fulfillment: input.fulfillment ?? 'DELIVERY' };
  if (!validLine(candidate)) throw new Error('This item does not have a valid price or quantity. Check the live menu again.');
  if (basket.lines.some(l => l.vendorId !== input.vendorId)) return 'DIFFERENT_STORE';
  const existing = basket.lines.find(l => l.itemId === input.itemId && selectionKey(l.selectedOptions) === selectionKey(input.selectedOptions));
  if (existing) {
    if (existing.quantity + input.quantity > 99) return 'QUANTITY_LIMIT';
    existing.quantity += input.quantity;
    // The latest server menu is the estimate the guest sees. Upload re-prices it.
    existing.unitPrice = input.unitPrice;
  } else {
    if (basket.lines.length >= 100) throw new Error('Your basket has reached its item limit.');
    basket.lines.push(candidate);
  }
  save(basket); return 'ADDED';
}
export function changeGuestQuantity(id: string, quantity: number) {
  const basket = readGuestBasket(); editable(basket);
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) throw new Error('Choose a quantity from 0 to 99.');
  basket.lines = basket.lines.flatMap(l => l.clientLineId === id ? quantity === 0 ? [] : [{ ...l, quantity }] : [l]);
  save(basket);
}
export function clearGuestBasket() { const basket = readGuestBasket(); editable(basket); save(empty()); }
export function prepareGuestMerge(scope: string) {
  const basket = readGuestBasket();
  if (basket.pending) {
    if (basket.pending.scope !== scope) throw new Error('This upload belongs to another account. Sign in to that account to retry it.');
    return basket.pending;
  }
  if (!basket.lines.length) return null;
  basket.pending = { scope, key: crypto.randomUUID(), lines: structuredClone(basket.lines) };
  save(basket); return basket.pending;
}
export function settleGuestMerge(key: string, applied: boolean) {
  const basket = readGuestBasket();
  if (basket.pending?.key !== key) return;
  save(applied ? empty() : { version: 1, lines: basket.lines });
}
export { guestCart } from './basket-projection';

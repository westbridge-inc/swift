import type { Cart } from './customer';
import type { GuestBasket } from './basket-storage';
export function guestCart(basket: GuestBasket): Cart {
  const first = basket.lines[0];
  return { items: basket.lines.map(l => ({ id: l.clientLineId, itemId: l.itemId, name: l.name, quantity: l.quantity,
    customerPrice: l.unitPrice, selectedOptionNames: l.selectedOptionNames, vendorId: l.vendorId, fulfillment: l.fulfillment ?? 'DELIVERY' })),
    ...(first ? { vendor: { id: first.vendorId, slug: first.storeSlug, name: first.vendorName } } : {}) };
}

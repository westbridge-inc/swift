import { useEffect, useState } from 'react';
import type { Cart } from './customer';
import { selectionKey } from '../../../api/src/modules/order/options';

const KEY = 'swift_guest_basket_v1';
const EVENT = 'swift-guest-basket';
export interface GuestLine {
  clientLineId: string; vendorId: string; storeSlug: string; vendorName: string;
  itemId: string; name: string; quantity: number; unitPrice: number;
  selectedOptions: Record<string, string | string[]>; selectedOptionNames?: string[];
  fulfillment?: string; returnPath?: string;
}
export interface GuestBasket {
  version: 1; lines: GuestLine[];
  pending?: { scope: string; key: string; lines: GuestLine[] };
}
const empty = (): GuestBasket => ({ version: 1, lines: [] });
const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
function validLine(line: GuestLine): boolean {
  return Boolean(line && validId(line.clientLineId) && validId(line.vendorId) && validId(line.itemId) && validId(line.storeSlug) && /^[a-z0-9][a-z0-9-]{0,79}$/.test(line.storeSlug)
    && (line.returnPath === undefined || typeof line.returnPath === 'string' && line.returnPath.length <= 2048
      && (line.returnPath === `/store/${line.storeSlug}` || line.returnPath.startsWith(`/store/${line.storeSlug}?`))
      && !/[\\\r\n#]/.test(line.returnPath) && !line.returnPath.includes('..'))
    && typeof line.name === 'string' && line.name.length <= 200 && typeof line.vendorName === 'string' && line.vendorName.length <= 200
    && Number.isInteger(line.quantity) && line.quantity >= 1 && line.quantity <= 99
    && Number.isSafeInteger(line.unitPrice) && line.unitPrice >= 0 && line.unitPrice <= 99999999
    && line.selectedOptions && typeof line.selectedOptions === 'object' && !Array.isArray(line.selectedOptions)
    && Object.entries(line.selectedOptions).length <= 50
    && Object.entries(line.selectedOptions).every(([k, v]) => validId(k) && (validId(v) || Array.isArray(v) && v.length <= 50 && v.every(validId))));
}
export function readGuestBasket(): GuestBasket {
  if (typeof window === 'undefined') return empty();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw || raw.length > 100000) return empty();
    const value = JSON.parse(raw) as GuestBasket;
    if (value.version !== 1 || !Array.isArray(value.lines) || value.lines.length > 100 || !value.lines.every(validLine)) return empty();
    if (new Set(value.lines.map(l => l.clientLineId)).size !== value.lines.length || new Set(value.lines.map(l => l.vendorId)).size > 1) return empty();
    if (value.pending && (!validId(value.pending.scope) || !validId(value.pending.key) || !Array.isArray(value.pending.lines)
      || JSON.stringify(value.pending.lines) !== JSON.stringify(value.lines))) return empty();
    return value;
  } catch { return empty(); }
}
export function guestBasketReturn(): string {
  const first = readGuestBasket().lines[0];
  return first ? first.returnPath ?? `/store/${first.storeSlug}` : '';
}
function save(basket: GuestBasket) {
  localStorage.setItem(KEY, JSON.stringify(basket));
  window.dispatchEvent(new Event(EVENT));
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
export function guestCart(basket: GuestBasket): Cart {
  const first = basket.lines[0];
  return { items: basket.lines.map(l => ({ id: l.clientLineId, itemId: l.itemId, name: l.name, quantity: l.quantity,
    customerPrice: l.unitPrice, selectedOptionNames: l.selectedOptionNames, vendorId: l.vendorId, fulfillment: l.fulfillment ?? 'DELIVERY' })),
    ...(first ? { vendor: { id: first.vendorId, slug: first.storeSlug, name: first.vendorName } } : {}) };
}
export function useGuestBasket() {
  const [basket, setBasket] = useState<GuestBasket>(empty);
  useEffect(() => {
    const refresh = () => setBasket(readGuestBasket());
    refresh(); window.addEventListener(EVENT, refresh); window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, []);
  return basket;
}

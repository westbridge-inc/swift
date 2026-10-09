export const KEY = 'swift_guest_basket_v1';
export const EVENT = 'swift-guest-basket';
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
export const empty = (): GuestBasket => ({ version: 1, lines: [] });
export const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
export function validLine(line: GuestLine): boolean {
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
export function save(basket: GuestBasket) {
  localStorage.setItem(KEY, JSON.stringify(basket));
  window.dispatchEvent(new Event(EVENT));
}

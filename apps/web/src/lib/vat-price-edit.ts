// [VAT-DOCS · owner 30 Oct 2026] Editing the price of an item Swift adds VAT to (the store chose "my prices do not include
// VAT" and a person approved its certificate). The server sends `vatListedPrice` (the price the store typed, before VAT)
// beside `basePrice` (what customers pay, VAT included); such an item is edited by its price before VAT. Every other
// item, and every new one, by its price as typed. The same rule as the phone (lib/storeVat.ts).

type Priced = { basePrice?: unknown; vatListedPrice?: unknown } | null | undefined;

/** The number the price field starts with. */
export function editablePrice(item: Priced): number | null {
  const typed = item?.vatListedPrice ?? item?.basePrice;
  if (typed == null) return null;
  const n = Number(typed);
  return Number.isFinite(n) ? n : null;
}

/** The price part of an item save. */
export function itemPricePayload(item: Priced, price: number): { basePrice: number } | { vatListedPrice: number } {
  return item?.vatListedPrice != null ? { vatListedPrice: price } : { basePrice: price };
}

/** What customers pay, under the price of an item Swift adds VAT to (null for every other item). */
export function beforeVatNote(item: Priced, money: (n: number) => string): string | null {
  if (item?.vatListedPrice == null || item.basePrice == null) return null;
  return `Before VAT. Customers pay ${money(Number(item.basePrice))} incl. VAT.`;
}

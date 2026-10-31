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

/** The price part of an item save. [REVIEW-M #2255 S4-2] A NEW item sends its typed price as both fields (the server reads
 *  `vatListedPrice` first and refuses a bare basePrice on a store that adds VAT, where it could not tell whether VAT is in it). */
export function itemPricePayload(item: Priced, price: number): { basePrice?: number; vatListedPrice?: number } {
  if (!item) return { basePrice: price, vatListedPrice: price };
  return item.vatListedPrice != null ? { vatListedPrice: price } : { basePrice: price };
}

/** [REVIEW-M #2255 S4-2] A NEW option's extra price as the store typed it (the same rule as a new item). */
export function newOptionPrice(price: number): { additionalPrice: number; vatListedAdditionalPrice: number } {
  return { additionalPrice: price, vatListedAdditionalPrice: price };
}

/** [REVIEW-F #2256 S4-2] A NEW item in a store whose VAT is added to its prices (the same words as the phone). */
export function newItemBeforeVatHint(ratePercent: number): string {
  return `Type the price before VAT: ${ratePercent}% VAT is added to standard-rated items.`;
}

/** [REVIEW-F #2256 S4-3] An option's extra price in the editor: what customers pay, saying so when VAT is in it. */
export function optionPriceLabel(o: { additionalPrice?: unknown; vatListedAdditionalPrice?: unknown }): string {
  const n = Number(o.additionalPrice);
  if (!(n > 0)) return 'Free';
  return `+GYD ${n.toLocaleString('en-US')}${o.vatListedAdditionalPrice != null ? ' incl. VAT' : ''}`;
}

/** What customers pay, under the price of an item Swift adds VAT to (null for every other item). */
export function beforeVatNote(item: Priced, money: (n: number) => string): string | null {
  if (item?.vatListedPrice == null || item.basePrice == null) return null;
  return `Before VAT. Customers pay ${money(Number(item.basePrice))} incl. VAT.`;
}

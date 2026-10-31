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

/** The price part of an item save. [REVIEW-M #2255 S4-2 · security review #2256] A NEW item in a store whose VAT is added
 *  (`vatAdded`: the profile's `vatAddsToPrices`, the same word that made the field ask for the price before VAT) sends the
 *  typed price as the price before VAT; anywhere else the bare price, so the server's refusal (409 VAT_PRICE_BEFORE_VAT)
 *  still guards a client that has it wrong. */
export function itemPricePayload(item: Priced, price: number, vatAdded: boolean): { basePrice?: number; vatListedPrice?: number } {
  if (!item) return vatAdded ? { basePrice: price, vatListedPrice: price } : { basePrice: price };
  return item.vatListedPrice != null ? { vatListedPrice: price } : { basePrice: price };
}

/** A NEW option's extra price (the same rule as a new item). */
export function newOptionPrice(price: number, vatAdded: boolean): { additionalPrice: number; vatListedAdditionalPrice?: number } {
  return vatAdded ? { additionalPrice: price, vatListedAdditionalPrice: price } : { additionalPrice: price };
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

// [STORE-VAT · owner O-5] The settings VAT card's date words (the GRA link is lib/gra-vat-url.ts; the item class words sit
// beside the Products page).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** [REVIEW-F #2102 S4] A certificate's effective date as people read it ("1 Jan 2026"): a calendar day (stored as
 *  midnight UTC), read in UTC so it never shifts to the evening before. The same words as the server's notice. */
export function calendarDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// [VAT-DOCS · owner 30 Oct 2026] How a VAT-registered store's typed prices relate to VAT (the same words as the phone).
export type StoreVatMode = 'PRICES_INCLUDE_VAT' | 'ADD_VAT_AT_CHECKOUT';
export const VAT_MODE_CHOICES: ReadonlyArray<{ value: StoreVatMode; label: string }> = [
  { value: 'PRICES_INCLUDE_VAT', label: 'My prices already include VAT' },
  { value: 'ADD_VAT_AT_CHECKOUT', label: 'My prices do not include VAT' },
];
/** VAT Act s.90(2): the customer always sees the full price, VAT included, before ordering. */
export function vatModeHelp(mode: StoreVatMode, ratePercent: number): string {
  return mode === 'ADD_VAT_AT_CHECKOUT'
    ? `Once a person at Swift approves your certificate, Swift adds ${ratePercent}% VAT to the price you type for each standard-rated item, so customers see and pay the full price, VAT included, before they order. Zero-rated and exempt items stay as you type them.`
    : 'Customers pay the prices you type; receipts show the VAT inside them.';
}
/** The optional document the store may add (never required to go live). */
export const VAT_DOCUMENT_ROW = {
  title: 'VAT certificate (only if VAT-registered)',
  body: 'Only if your business is registered for VAT with the GRA. You do not need it to go live.',
} as const;

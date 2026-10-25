import type { VatClass } from './vendor-api';

// [STORE-VAT · owner O-5] The store-facing words for a store's VAT, in one place (settings card and inventory).

/** Where the owner reads the GRA's own words on VAT (the API cites the Act and the GRA policies it follows). */
export const GRA_VAT_URL = 'https://www.gra.gov.gy/vat-invoices/';

/** The classes a store gives its items. The rate always comes from the API, never a literal on a screen. Before a person
 *  approved the store's VAT, nothing carries VAT yet, so the words do not say it does (REVIEW-F #2087 S4). */
export const vatClassWords = (ratePercent: number, effective = true): ReadonlyArray<{ value: VatClass; label: string }> => [
  { value: 'STANDARD', label: effective ? `Standard (${ratePercent}% VAT inside the price)` : 'Standard (VAT once your VAT is approved)' },
  { value: 'ZERO_RATED', label: 'Zero-rated (no VAT)' },
  { value: 'EXEMPT', label: 'Exempt (no VAT)' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** [REVIEW-F #2102 S4] A certificate's effective date as people read it ("1 Jan 2026"): a calendar day (stored as
 *  midnight UTC), read in UTC so it never shifts to the evening before. The same words as the server's notice. */
export function calendarDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

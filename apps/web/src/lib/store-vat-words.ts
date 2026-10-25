import type { VatClass } from './vendor-api';

// [STORE-VAT · owner O-5] The store-facing words for a store's VAT, in one place (settings card and inventory).

/** Where the owner reads the GRA's own words on VAT (the API cites the Act and the GRA policies it follows). */
export const GRA_VAT_URL = 'https://www.gra.gov.gy/vat-invoices/';

/** The classes a store gives its items. The rate always comes from the API, never a literal on a screen. */
export const vatClassWords = (ratePercent: number): ReadonlyArray<{ value: VatClass; label: string }> => [
  { value: 'STANDARD', label: `Standard (${ratePercent}% VAT inside the price)` },
  { value: 'ZERO_RATED', label: 'Zero-rated (no VAT)' },
  { value: 'EXEMPT', label: 'Exempt (no VAT)' },
];

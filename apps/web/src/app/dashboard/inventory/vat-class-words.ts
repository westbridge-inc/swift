import type { VatClass } from '@/lib/vendor-api';

// [STORE-VAT · owner O-5] The Products page's VAT class words (only that page uses them).

/** The classes a store gives its items. The rate always comes from the API, never a literal on a screen. Before a person
 *  approved the store's VAT, nothing carries VAT yet, so the words do not say it does (REVIEW-F #2087 S4). */
export const vatClassWords = (ratePercent: number, effective = true): ReadonlyArray<{ value: VatClass; label: string }> => [
  { value: 'STANDARD', label: effective ? `Standard (${ratePercent}% VAT inside the price)` : 'Standard (VAT once your VAT is approved)' },
  { value: 'ZERO_RATED', label: 'Zero-rated (no VAT)' },
  { value: 'EXEMPT', label: 'Exempt (no VAT)' },
];

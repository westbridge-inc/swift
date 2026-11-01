// [WEB-SETTINGS PR-B · REVIEW-F #2281 S2-1] A page.tsx exports only its page, so the page's words live here.

/** The phone's words (VendorAccountScreen PromosSection; the test reads them there). */
export const PROMO_WORDS = {
  none: 'No codes yet — run your first promotion and it shows on your storefront.',
  staff: 'Promotions are run by the store’s manager and owner.',
  // [REVIEW-F #2281 S4-3] The server's rules (vendor.routes.ts createPromoSchema), in its words where it has them.
  codeShort: 'A code needs 3 or more characters',
  codeChars: 'Letters, numbers and dashes only',
  overHundred: 'A percentage discount cannot exceed 100',
  setMinimum: 'Set the minimum order',
  kept: 'Customers used this code, so it stays in your list, paused.',
} as const;

/** [REVIEW-F #2281 S3-2] An amount as people type it on a keyboard ("1,000", "GY$ 500"): null when nothing is typed,
 *  NaN when it is not a number, so a typed minimum is never silently dropped. */
export function readAmount(text: string): number | null {
  const t = text.replace(/G?Y?\$|,|\s/gi, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

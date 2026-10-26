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

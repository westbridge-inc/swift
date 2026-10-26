// [FEE-STATUS · owner 25 Oct 2026] A partner's Weekly fee screen said "your next bill is 13 Oct 2026" on
// 25 October. The console's subscription rows printed the same date as "Next bill". A billing date that
// has passed is not a next bill: the week from it is due (or waiting to be applied), so the row says
// "Due since". Only a date still ahead is the next bill.

/** The label for a subscription's nextBillingDate, honest once the date has passed. */
export function billDateLabel(iso: string | null | undefined, now = Date.now()): 'Next bill' | 'Due since' {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) && at <= now ? 'Due since' : 'Next bill';
}

// [FEE-STATUS · REVIEW-F S4-1] Where a partner's weekly fee stands, in words. Byte-identical in apps/mobile
// (src/lib/fee-status.ts) and apps/web (src/lib/fee-status.ts): the phone's census checks it. Small on purpose:
// the web's Orders home tile reads it without loading the whole weekly-fee page module (scripts/perf-budget).
export const feeMoney = (n: number) => `GY$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
export function feeDate(value?: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Guyana' }) : '';
}
/** The subscription fields the words read (GET /{family}/subscription). */
export interface FeeStatusRow {
  status: string; amountDueGyd?: number | string; nextBillingDate?: string | null; gracePeriodEnd?: string | null;
  weeklyFeeGyd?: number | string; isTrialActive?: boolean; trialEndDate?: string | null; isInGracePeriod?: boolean; autoRenew?: boolean;
  feeStatus?: FeeStatus | null;
  latestMmgCheckout?: { status: string; amountGyd: number; createdAt: string } | null;
}
/** [FEE-STATUS · owner 25 Oct 2026] Where the weekly fee stands. A store read "Nothing due right now: your next
 *  bill is 13 Oct 2026" and "Active" on 25 October. The API now words it (GET /{family}/subscription feeStatus);
 *  for an API from before that, the same rules run here on the row, minus the holds only the server can see
 *  (a checkout being checked still reads as checking). A date that has passed is never a next bill or an "until". */
export type FeeStatusState = 'TRIAL' | 'PAID' | 'UPCOMING' | 'COVERED' | 'DUE' | 'CHECKING' | 'FEE_PAUSED' | 'SUSPENDED' | 'INACTIVE' | 'STOPPED' | 'CLOSED' | 'UNKNOWN';
export interface FeeStatus { state: FeeStatusState; headline: string; detail: string | null; date: string | null }
export function feeStatusOf(sub: FeeStatusRow, now = Date.now()): FeeStatus {
  const sent = sub.feeStatus;
  if (sent && typeof sent.headline === 'string' && sent.headline) return sent;
  const word = (state: FeeStatusState, headline: string, detail: string | null = null, date: string | null = null): FeeStatus => ({ state, headline, detail, date });
  const at = (value?: string | null) => (value ? Date.parse(value) : NaN);
  const raw = sub.amountDueGyd;
  const amountDue = raw != null && raw !== '' ? Number(raw) : NaN;
  const status = String(sub.status ?? '').toUpperCase();
  const next = feeDate(sub.nextBillingDate);
  const due = !(at(sub.nextBillingDate) > now);
  if (status === 'CANCELLED') return word('CLOSED', 'Subscription closed');
  const c = sub.latestMmgCheckout;
  if (c && (c.status === 'HELD' || c.status === 'CONFIRMING')) {
    return word('CHECKING', `Checking your payment of ${feeMoney(c.amountGyd)}${feeDate(c.createdAt) ? ` (began ${feeDate(c.createdAt)})` : ''}`, "Don't pay again while we check.", c.createdAt);
  }
  if (status === 'SUSPENDED' || status === 'CHURNED') {
    const owed = amountDue > 0 ? amountDue : Number(sub.weeklyFeeGyd ?? 0);
    return word(status === 'SUSPENDED' ? 'SUSPENDED' : 'INACTIVE', status === 'SUSPENDED' ? 'Account suspended' : 'Account inactive',
      `${owed > 0 ? feeMoney(owed) : 'The weekly fee'} due ${due && next ? `since ${next}` : 'now'}. Pay it to start receiving work again.`);
  }
  if (status === 'PAUSED' || (sub.autoRenew === false && due)) return word('STOPPED', 'Weekly billing stopped', 'You receive no work while it is stopped. Resume weekly billing to start again.');
  const trialEnd = at(sub.trialEndDate) > now ? sub.trialEndDate : !due ? sub.nextBillingDate : null;
  if ((sub.isTrialActive === true || status === 'TRIAL') && trialEnd) return word('TRIAL', `Free trial until ${feeDate(trialEnd)}`, null, trialEnd);
  const behind = status === 'PAST_DUE' || sub.isInGracePeriod === true;
  // Only the API can say "Paid until" (on a captured payment's word): here a date is the next fee's, never proof of payment.
  if (!due && !behind) return word('UPCOMING', `Next weekly fee due on ${next}`, sub.autoRenew === false ? `Weekly billing is stopped: you receive no work after ${next}.` : null, sub.nextBillingDate ?? null);
  if (!Number.isFinite(amountDue)) return word('UNKNOWN', 'Amount due unavailable.');
  if (!behind && amountDue <= 0) return word('COVERED', next ? `Nothing to pay for the week from ${next}` : 'Nothing to pay right now');
  const grace = at(sub.gracePeriodEnd) > now ? ` Pay by ${feeDate(sub.gracePeriodEnd)} to keep receiving work.` : '';
  return word('DUE', due && next ? `Payment due since ${next}` : 'Payment due now', `${amountDue > 0 ? `${feeMoney(amountDue)} to pay.` : ''}${grace}`.trim() || null, due ? sub.nextBillingDate ?? null : null);
}

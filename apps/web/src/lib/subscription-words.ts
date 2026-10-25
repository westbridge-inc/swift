/**
 * [BUG-GUARDS C5] A partner's weekly-fee subscription state in words
 * (SubscriptionStatus), never the code; an unknown state says so.
 *
 * The same answer as lib/weekly-fee's subscriptionWords, for every status
 * (subscription-words.test pins the two together). That file is kept
 * byte-identical to the app's copy (apps/mobile weekly-fee-census), so it
 * cannot import this one. This small file lets the Orders home's Billing badge
 * name the state without pulling the whole weekly-fee module (checkout
 * session, receipts) into the Orders page's first load (scripts/perf-budget).
 */
const SUBSCRIPTION_WORDS: Record<string, string> = {
  TRIAL: 'Free trial',
  ACTIVE: 'Active',
  PAST_DUE: 'Weekly fee overdue',
  SUSPENDED: 'Account suspended',
  CHURNED: 'Account inactive',
  PAUSED: 'Weekly billing paused',
  CANCELLED: 'Subscription closed',
};

export const subscriptionWords = (status: string): string => SUBSCRIPTION_WORDS[status] ?? 'Status unavailable';

/**
 * [FEE-STATUS · owner 25 Oct 2026] The Billing tile's pill: where the fee stands, from the API's
 * feeStatus (the web ships with its API). The same words as the phone's lib/feeStatusPill
 * (subscription-words.test pins them); an answer without feeStatus names the state in words.
 */
const FEE_STATUS_PILL: Record<string, { label: string; tone: 'success' | 'warning' | 'error' | 'brand' | 'neutral' }> = {
  TRIAL: { label: 'Free trial', tone: 'brand' }, PAID: { label: 'Paid', tone: 'success' }, UPCOMING: { label: 'Active', tone: 'success' }, COVERED: { label: 'Paid', tone: 'success' },
  DUE: { label: 'Payment due', tone: 'warning' }, CHECKING: { label: 'Checking payment', tone: 'warning' }, FEE_PAUSED: { label: 'Fee paused', tone: 'neutral' },
  SUSPENDED: { label: 'Suspended', tone: 'error' }, INACTIVE: { label: 'Inactive', tone: 'error' }, STOPPED: { label: 'Billing stopped', tone: 'neutral' },
  CLOSED: { label: 'Closed', tone: 'neutral' }, UNKNOWN: { label: 'Status unavailable', tone: 'neutral' },
};
export const feeStatusPillWords = (state: string) => FEE_STATUS_PILL[state] ?? FEE_STATUS_PILL['UNKNOWN']!;

type Sub = { status?: unknown; feeStatus?: { state?: unknown; headline?: unknown } | null } | null | undefined;
/** The pill for a subscription: the API's feeStatus state, else the state's words. */
export function billingPill(sub: Sub): { label: string; tone: 'success' | 'warning' | 'error' | 'brand' | 'neutral' } {
  const state = sub?.feeStatus?.state;
  return typeof state === 'string' ? feeStatusPillWords(state) : { label: subscriptionWords(String(sub?.status ?? '')), tone: 'neutral' };
}
/** The Billing tile's line: the API's feeStatus headline, else the state's words (never a date it cannot vouch for).
 *  It replaced vendor-hub billingSummary ("Next bill <date>", the phone VendorOps copy); it lives here so the
 *  board's shared helpers (vendor-hub, in every dashboard page's first load) stay as small as they were. */
export function billingHeadline(sub: Sub): string {
  if (!sub) return 'Subscription not active';
  const headline = sub.feeStatus?.headline;
  return typeof headline === 'string' && headline ? headline : subscriptionWords(String(sub.status ?? ''));
}

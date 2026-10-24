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

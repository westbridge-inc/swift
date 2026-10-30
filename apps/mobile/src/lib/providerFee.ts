import type { FeeTick } from './partnerPricing';
import type { FeeSubscription } from './weeklyFee';

/**
 * [BILL-PRO PR5] A pro's weekly fee, as the API states it (GET /api/v1/provider/subscription, BILL-PRO PR4): the pro's
 * own fee (null until it is due), where they stand (listed or why not), whether their Services store's fee covers
 * them (one fee), and the words of "I understand the weekly fee" with the amount, until ticked. Pure: the screen and
 * the dashboard draw from these, never from the documents alone.
 */
export type ProFeeWhy = 'AGREEMENT' | 'FEE_TERMS' | 'MISSING' | 'STATUS' | 'GRACE_LAPSED' | 'BILLING_STOPPED' | null;
export type ProFeeStanding = { required: false; operable: true } | { required: true; operable: boolean; why: ProFeeWhy; source: 'OWN' | 'STORE' | null; subscriptionId: string | null };
export interface ProFeeTerms { version: string; items: { heading: string; text: string }[]; tick: string; amount: number; currencyCode: string; acknowledged: boolean }
export interface ProFeeView { data: FeeSubscription | null; standing?: ProFeeStanding; coveredBy?: 'STORE' | null; feeTerms?: ProFeeTerms }

/** The tick to show: only while the server says it is not given, with the server's words and amount. */
/** [BILL-PRO · Business Agreement s.12 · REVIEW-F #2225 S4-1 · REVIEW-M #2229 N1] What a pro covered by their own
 *  Services store's fee is told: one fee (the store's), and a payment for their own provider fee that was still being
 *  confirmed when the store's fee started is kept as credit (the server banks it; never lost, never charged twice). */
export const PRO_FEE_COVERED_COPY = 'Your Services store\u2019s weekly fee covers your provider profile: you pay one fee, on your store\u2019s Weekly fee screen. If a payment for your own provider fee was still being confirmed when your store\u2019s fee started, it is kept as credit on your provider fee, never lost.';

export function proFeeTick(view: ProFeeView | null | undefined): FeeTick {
  const t = view?.feeTerms;
  if (!t || t.acknowledged || !t.items?.length || !t.tick) return { kind: 'none' };
  return { kind: 'tick', key: `${t.version}:${t.amount}:${t.currencyCode}`, terms: { version: t.version, items: t.items, tick: t.tick }, ack: { version: t.version, amount: t.amount, currencyCode: t.currencyCode } };
}

/** What the pro's dashboard says about being listed, and the one thing to do next. An older API (no `fee`/`listed`)
 *  keeps the documents-only answer. */
export function proFeeBanner(me: { isVerified?: boolean; listed?: boolean; fee?: ProFeeStanding } | null | undefined): { listed: boolean; title: string; body: string; action: 'AGREEMENT' | 'FEE' | null } | null {
  if (!me?.isVerified || me.listed !== false || !me.fee?.required) return null;
  switch (me.fee.why) {
    case 'AGREEMENT':
      return { listed: false, title: 'Not listed', body: 'Accept the Business Agreement to be listed and take new jobs.', action: 'AGREEMENT' };
    case 'FEE_TERMS':
      return { listed: false, title: 'Not listed', body: 'Read your weekly fee and tick “I understand the weekly fee” to be listed and take new jobs.', action: 'FEE' };
    case 'MISSING':
      return { listed: false, title: 'Not listed', body: 'Your weekly fee is being set up. Open Weekly fee to check it.', action: 'FEE' };
    default:
      return { listed: false, title: 'Not listed', body: 'Pay this week’s fee to be listed again. Jobs already booked can still go ahead.', action: 'FEE' };
  }
}

import type { FeeTick } from './partnerPricing';
import type { FeeSubscription } from './weeklyFee';
import { moneyIn } from './money';

/**
 * [BILL-PRO PR5] A pro's weekly fee, as the API states it (GET /api/v1/provider/subscription, BILL-PRO PR4): the pro's
 * own fee (null until it is due), where they stand (listed or why not), whether their Services store's fee covers
 * them (one fee), and the words of "I understand the weekly fee" with the amount, until ticked. Pure: the screen and
 * the dashboard draw from these, never from the documents alone.
 */
export type ProFeeWhy = 'AGREEMENT' | 'FEE_TERMS' | 'MISSING' | 'STATUS' | 'GRACE_LAPSED' | 'BILLING_STOPPED' | null;
export type ProFeeStanding = { required: false; operable: true } | { required: true; operable: boolean; why: ProFeeWhy; source: 'OWN' | 'STORE' | null; subscriptionId: string | null };
export interface ProFeeTerms {
  version: string; items: { heading: string; text: string }[]; tick: string; amount: number; currencyCode: string; acknowledged: boolean;
  /** [REVIEW-G #2230 S3-1] The amount the pro's latest tick was given to (older APIs omit it), and whether the fee
   *  changed since: then the pro is asked again, at the new amount. */
  acknowledgedAmount?: number | null; acknowledgedCurrencyCode?: string | null; changed?: boolean;
}
export interface ProFeeView { data: FeeSubscription | null; standing?: ProFeeStanding; coveredBy?: 'STORE' | null; feeTerms?: ProFeeTerms }

/** [BILL-PRO · Business Agreement s.12 · REVIEW-F #2225 S4-1 · REVIEW-M #2229 N1] What a pro covered by their own
 *  Services store's fee is told: one fee (the store's), and a payment for their own provider fee that was still being
 *  confirmed when the store's fee started is kept as credit (the server banks it; never lost, never charged twice). */
export const PRO_FEE_COVERED_COPY = 'Your Services store\u2019s weekly fee covers your provider profile: you pay one fee, on your store\u2019s Weekly fee screen. If a payment for your own provider fee was still being confirmed when your store\u2019s fee started, it is kept as credit on your provider fee, never lost.';

/** The tick to show: only while the fee is required (switch on) and the server says it is not given, with the
 *  server's words and amount. Its `key` names the words AND the amount: a screen keeps a tick only for that key, so a
 *  new amount (WEEKLY_FEE_CHANGED) clears it and is never consented to with one tap (REVIEW-F #2231 S3-1). */
export function proFeeTick(view: ProFeeView | null | undefined): FeeTick {
  const t = view?.feeTerms;
  if (!view?.standing?.required) return { kind: 'none' };
  if (!t || t.acknowledged || !t.items?.length || !t.tick) return { kind: 'none' };
  return { kind: 'tick', key: `${t.version}:${t.amount}:${t.currencyCode}`, terms: { version: t.version, items: t.items, tick: t.tick }, ack: { version: t.version, amount: t.amount, currencyCode: t.currencyCode } };
}

/** [REVIEW-G #2230 S3-1] The pro ticked another amount than the one asked now: the fee changed, confirm again. */
export function proFeeChangedLine(view: ProFeeView | null | undefined): string | null {
  const t = view?.feeTerms;
  if (!view?.standing?.required || !t || t.acknowledged || !t.changed || t.acknowledgedAmount == null) return null;
  return `The weekly fee changed from ${moneyIn(t.acknowledgedAmount, t.acknowledgedCurrencyCode ?? t.currencyCode)} to ${moneyIn(t.amount, t.currencyCode)} a week. Read it again and tick \u201cI understand the weekly fee\u201d to confirm the new amount. Nothing starts at the new amount until you do.`;
}

/** [REVIEW-F #2231 S3-3] A pro their store's fee covers is still asked to confirm their own fee (both ticks, owner/COORD
 *  29 Oct): say why, so it never reads as a second charge. */
export const PRO_FEE_COVERED_TICK_LINE = 'You are still asked to confirm your own provider fee below: it applies only if your store\u2019s weekly fee ends. While your store\u2019s fee is live you pay only that one.';

/** [REVIEW-F #2231 S4-4] For a pro Swift has approved and who accepted the agreement, the tick itself starts the fee.
 *  [REVIEW-F #2231 S4] Only when the server says the tick is the one thing missing (FEE_TERMS): with the Business
 *  Agreement not accepted (AGREEMENT) the tick cannot start the fee, and saying so would be false. */
export function proFeeTickStartsLine(view: ProFeeView | null | undefined, isVerified: boolean | undefined): string | null {
  // [REVIEW-M #2238 S4-1] Never once the fee is born: it already runs, and no new trial starts (proFeeTickRunningLine).
  if (!isVerified || view?.data || view?.coveredBy === 'STORE' || proFeeTick(view).kind !== 'tick') return null;
  if (!view?.standing?.required || view.standing.why !== 'FEE_TERMS') return null;
  return 'Ticking this starts your weekly fee today: first a 14-day free trial if you have not had one as a service provider, then the amount above each week.';
}

/** [REVIEW-M #2238 S4-1] A pro whose fee is already born is asked to tick again (the server's words changed): the tick
 *  confirms the words; it neither starts the fee nor a new free trial, and the born fee's price changes only through
 *  the told-in-advance fee-rise rules (pro-fee.ts proFeeAckState: once born, the tick that bore it holds). */
export const PRO_FEE_RUNNING_TICK_LINE = 'Your weekly fee is already running. Ticking confirms you have read the weekly fee again: it does not start a new free trial, and any change to what you pay is told to you in advance and applies only from a later week.';
export function proFeeTickRunningLine(view: ProFeeView | null | undefined): string | null {
  if (!view?.data || view.coveredBy === 'STORE' || !view.standing?.required || proFeeTick(view).kind !== 'tick') return null;
  return PRO_FEE_RUNNING_TICK_LINE;
}

/** [REVIEW-F #2231 S4] The tick is asked but the Business Agreement is not accepted yet (the server's standing says
 *  AGREEMENT): the fee screen says the agreement comes first, with the Review button, next to the tick. */
export function proFeeAgreementFirst(view: ProFeeView | null | undefined): { title: string; body: string } | null {
  if (proFeeTick(view).kind !== 'tick' || !view?.standing?.required || view.standing.why !== 'AGREEMENT') return null;
  // [REVIEW-M #2238 S4-1] A fee already born does not "start" again: say what the agreement gates now.
  if (view.data) return { title: 'Accept the Business Agreement first', body: 'You are not listed and take no new jobs until you accept the Business Agreement that covers service providers. Ticking here does not do that on its own.' };
  return {
    title: 'Accept the Business Agreement first',
    body: 'Your weekly fee can start only after you accept the Business Agreement that covers service providers. Ticking here does not start it on its own, and you are not listed until both are done.',
  };
}

/** [REVIEW-F #2231 S3-2] What the fee screen says when the pro has no fee of their own and nothing to tick, from where
 *  the server says they stand (never one sentence for every state). */
export function proFeeNoFeeWords(view: ProFeeView | null | undefined, isVerified: boolean | undefined): { title: string; body: string; action: 'AGREEMENT' | null } {
  const standing = view?.standing;
  if (!standing?.required) {
    return { title: 'No weekly fee yet', body: 'Swift tells you in the app before the weekly fee starts for service providers. Nothing is charged until then.', action: null };
  }
  if (standing.why === 'AGREEMENT') {
    return { title: 'Accept the Business Agreement', body: 'Accept the Business Agreement that covers service providers to be listed and take new jobs. Your weekly fee is shown here after that.', action: 'AGREEMENT' };
  }
  if (!isVerified) {
    return { title: 'Your weekly fee starts after approval', body: 'Your weekly fee starts only after Swift approves your documents, with a 14-day free trial if you have not had one as a service provider. You are not listed until then. Nothing is charged before it starts.', action: null };
  }
  return { title: 'Your weekly fee is being set up', body: 'You are not listed until it is set up, usually within the hour. It starts with a 14-day free trial if you have not had one as a service provider. Jobs already booked can still go ahead.', action: null };
}

/** [REVIEW-F #2231 S4-3] Where a covered pro finds their own provider fee (its credit and receipts). */
export const PRO_FEE_OWN_FEE_LINK = 'See your provider fee, credit and receipts';

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

import { money } from './money';

// Billing view-model helpers shared by the mover + vendor billing surfaces
// (My Swift Number screen, wallet status, honest grace/suspension banners).
// Pure functions only, so they unit-test without a renderer. The subscription
// payload is the spread of the Subscription row + billing/san.service.sanDisplay
// + billing/agent-cash.service.payInfo (see the /rider|/driver|/vendor
// /subscription route handlers): san, sanFormatted, weeklyFeeGyd,
// walletBalanceGyd, amountDueGyd, activationCopy, payCashSteps, usdDisplay.

export type BillingPhase =
  | 'trial'
  | 'active'
  | 'grace'
  | 'past_due'
  | 'suspended'
  | 'churned'
  | 'inactive';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Aug" — the earner/vendor deadline idiom. Empty for a missing/invalid
 *  date so copy never prints "Invalid Date". */
export function shortDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The weekly flat fee in GYD. Prefers payInfo's `weeklyFeeGyd` (already a
 *  number), falling back to the raw subscription rate fields. */
export function weeklyFeeGyd(sub: any): number {
  return Number(sub?.weeklyFeeGyd ?? sub?.customRate ?? sub?.weeklyRate ?? 0);
}

/** The subscription's billing phase, honest to the operate-gate state machine
 *  (subscription/operate-gate.ts): TRIAL/ACTIVE operate; PAST_DUE operates only
 *  inside its grace window; SUSPENDED/CHURNED are blocked until payment. Trial
 *  and grace are flags layered on status and are checked first — this mirrors
 *  the pill logic the earner/vendor account screens already compute inline. */
export function billingPhase(sub: any): BillingPhase {
  if (!sub) return 'inactive';
  if (sub.isTrialActive) return 'trial';
  if (sub.isInGracePeriod) return 'grace';
  const status = String(sub.status ?? '').toUpperCase();
  if (status === 'PAST_DUE') return 'past_due';
  if (status === 'SUSPENDED') return 'suspended';
  if (status === 'CHURNED') return 'churned';
  if (status === 'ACTIVE') return 'active';
  return 'inactive';
}

/** Access is blocked and only paying restores it — SUSPENDED or terminal
 *  CHURNED. Server reinstatement is instant (agent-cash credit() re-bills +
 *  reactivates on the spot); the real latency is the payment channel's, carried
 *  honestly by the payload's `activationCopy`. */
export function isBlocked(sub: any): boolean {
  const p = billingPhase(sub);
  return p === 'suspended' || p === 'churned';
}

/** The fee is overdue but access still holds — the softer "pay by {date}" nudge
 *  (grace window / PAST_DUE). */
export function isBehind(sub: any): boolean {
  const p = billingPhase(sub);
  return p === 'grace' || p === 'past_due';
}

/** Whole weeks a parked wallet balance covers at the weekly fee. Floors — we
 *  never over-promise coverage. 0 when the fee is unknown or nothing's banked. */
export function weeksCovered(balanceGyd?: number | null, weeklyGyd?: number | null): number {
  const bal = Number(balanceGyd ?? 0);
  const wk = Number(weeklyGyd ?? 0);
  if (!(wk > 0) || !(bal > 0)) return 0;
  return Math.floor(bal / wk);
}

/** The banked-wallet line for a positive balance — "$2,400 banked · covers 2
 *  weeks", dropping the coverage clause when the weekly fee is unknown. null
 *  when nothing is banked (the caller then renders nothing). */
export function walletLine(balanceGyd?: number | null, weeklyGyd?: number | null): string | null {
  const bal = Number(balanceGyd ?? 0);
  if (!(bal > 0)) return null;
  const weeks = weeksCovered(bal, weeklyGyd);
  const covers = weeks >= 1 ? ` · covers ${weeks} ${weeks === 1 ? 'week' : 'weeks'}` : '';
  return `${money(bal)} banked${covers}`;
}

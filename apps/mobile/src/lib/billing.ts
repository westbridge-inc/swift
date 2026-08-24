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

// ---------------------------------------------------------------------------
// THE PAY SCREEN [PAY-1 · Swift Pay design §1a/1b]
//
// One layout, four states. Only the eyebrow, the dot and one line of copy move
// between them, and both doors stay visible in every state — a vendor must
// always be able to pay, whatever state they are in (PINV-10).
//
// The design's own note on the ladder is the rule this encodes: "Gentle... no
// consequence named yet" at T-3, "names the consequence and the hour, once" in
// grace, and — for the paused state — "Not a wall." Nothing turns red. The
// escalation is carried by which words are present, never by shouting.
//
// Everything here is DERIVED FROM SERVER TRUTH and nothing is invented. If the
// server did not send a grace deadline we do not print an hours countdown; if
// it did not send a period end we do not print a paid-through date. A billing
// screen that guesses is worse than one that says less: this is the screen a
// vendor stands on when they think we have taken their money wrongly.
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Friday" — for the DUE <DAY> eyebrow. Empty for a missing/invalid date. */
export function weekdayName(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return WEEKDAYS[d.getDay()] ?? '';
}

/** Whole hours remaining until `iso`, or null when it is missing, invalid or
 *  already past. Null means "print no countdown", never "print zero". */
export function hoursUntil(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ms = d.getTime() - now.getTime();
  if (ms <= 0) return null;
  return Math.floor(ms / 3_600_000);
}

/** Whole days until `iso` counting from the start of today, or null if unknown.
 *  0 means "today" — which the copy renders as "Due today", not "Due in 0 days". */
export function daysUntil(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThen = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOfThen - startOfToday) / 86_400_000);
}

/** Which of the four bands this account is in. `tone` names a semantic token,
 *  never a raw colour — viridian for covered, amber for owed, ink for paused. */
export type PayBandTone = 'covered' | 'owed' | 'paused';

export interface PayScreenState {
  band: 'active' | 'due' | 'grace' | 'paused';
  tone: PayBandTone;
  /** Small caps above the amount — "NOTHING DUE NOW" / "DUE FRIDAY" / "DUE NOW". */
  eyebrow: string;
  /** The hero. The most readable thing we can put on a cheap screen in sunlight. */
  amountGyd: number;
  /** What the money buys — "Covers 1 week · through 22 Aug". '' when unknown. */
  covers: string;
  title: string;
  body: string;
  /** Only the paused band carries one: the list of what suspension does NOT take. */
  extra?: string;
}

export function payScreenState(sub: any, now: Date = new Date()): PayScreenState {
  const phase = billingPhase(sub);
  const fee = weeklyFeeGyd(sub);
  const due = Number(sub?.amountDueGyd ?? 0);
  const periodEnd: string | null = sub?.currentPeriodEnd ?? null;
  const graceEnd: string | null = sub?.gracePeriodEnd ?? null;
  const through = shortDate(periodEnd);
  const covers = through ? `Covers 1 week · through ${through}` : '';

  // Suspended (and terminal churned) — the design calls this "paused", and is
  // emphatic that it is "Not a wall". So it says what turns the store back on,
  // and then lists what the vendor still has. That list is not reassurance
  // copy: it is PINV-8, and billing-suspension-retention.test.ts is its proof.
  if (phase === 'suspended' || phase === 'churned') {
    return {
      band: 'paused', tone: 'paused', eyebrow: 'DUE NOW', amountGyd: due || fee, covers,
      title: 'New orders are paused',
      body: `Paying ${money(due || fee)} turns them back on, usually within a minute.`,
      extra: 'Still yours while paused: this screen, your receipts, your earnings and support. Orders already in the kitchen still go out.',
    };
  }

  // The 48-hour window. Names the consequence and the hour ONCE — and only if
  // the server actually gave us a deadline to name.
  if (phase === 'grace') {
    const hours = hoursUntil(graceEnd, now);
    return {
      band: 'grace', tone: 'owed', eyebrow: 'DUE NOW', amountGyd: due || fee, covers,
      title: hours == null ? 'Grace period' : `Grace period · ${hours} ${hours === 1 ? 'hour' : 'hours'} left`,
      body: hours == null
        ? 'Your store is still open. Paying now clears it.'
        : 'Your store stays open for now. Paying clears it straight away.',
    };
  }

  // Owed, still comfortably inside the window: gentle, and no consequence named.
  if (due > 0 || phase === 'past_due') {
    const days = daysUntil(periodEnd, now);
    const day = weekdayName(periodEnd);
    return {
      band: 'due', tone: 'owed',
      eyebrow: days != null && days > 0 && day ? `DUE ${day.toUpperCase()}` : 'DUE NOW',
      amountGyd: due || fee, covers,
      title: days == null ? 'Payment due' : days <= 0 ? 'Due today' : `Due in ${days} ${days === 1 ? 'day' : 'days'}`,
      body: through ? `Pay any time before ${through} and nothing changes.` : 'Pay any time and nothing changes.',
    };
  }

  // Covered. A big zero is the reward for paying, and the fee ahead is stated
  // once, quietly, in the band — not repeated as a second number up top.
  return {
    band: 'active', tone: 'covered', eyebrow: 'NOTHING DUE NOW', amountGyd: 0,
    covers: through ? `Paid through ${through}` : '',
    title: 'You are covered',
    body: through && fee > 0
      ? `Next fee is ${money(fee)} on ${through}. You can pay early any time.`
      : fee > 0 ? `Next fee is ${money(fee)}. You can pay early any time.` : 'You can pay early any time.',
  };
}

/** The QR payload an MMG agent scans [PAY-1 §4.3]. Null without a SAN — we
 *  never render a QR that resolves to nothing. */
export function sanQrPayload(san?: string | null): string | null {
  const digits = String(san ?? '').replace(/\D/g, '');
  return digits.length === 10 ? `SWIFTSAN:${digits}` : null;
}

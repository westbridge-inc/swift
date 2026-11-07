import type { Prisma, PrismaClient } from '@prisma/client';
import { guyanaDayKey, startOfGuyanaDay } from '../../utils/guyana-day';
import { formatMoney } from '../../utils/currency-amount';
import { weeklyFeeAmount } from './subscription-fee';

// ---------------------------------------------------------------------------
// [OWNER LEGAL PLAN 15 Oct 2026 · R10, research T1] The VAT registration
// tracker. Westbridge Inc. is not VAT-registered. The weekly fee becomes a
// taxable supply that must be registered for once it reaches the threshold:
//
//   - VAT Regulations reg. 3: the threshold is GYD 15,000,000 of taxable
//     supplies in a period of 12 months or fewer;
//   - VAT Act s.11(1): apply within 15 days after a period in which supplies
//     REACHED it, or at the start of a 12-month period in which there are
//     "reasonable grounds to expect" they WILL;
//   - s.14(8): a periodic fee is supplied when payment falls due or is
//     received, whichever is earlier; s.16(14): a free-trial week is nil.
//
// What this computes, per Guyana calendar month, for one tenant's partners,
// in GYD:
//   - due: the weekly fees that fell due that month (each week once, at the
//     amount it was charged or asked at), by the week's start;
//   - received: money received for weekly fees that month (fee paid in or
//     early, and fees charged straight to a card or an MMG request);
//   - returned: fee payments MMG returned that month (shown, never netted);
//   - counted: the larger of due and received, a deliberately cautious
//     stand-in for "due or received, whichever is earlier" across weeks.
// And the year ahead: every active, past-due or trial subscription's weekly
// fee for the 52 weeks to come, a trial's remaining free weeks counted nil.
//
// The admin alert fires when the last 12 months reach GYD 10,000,000 (the
// owner's early warning), or the year ahead is expected to reach GYD
// 15,000,000, and it names the 15-day deadline. The accountant decides the
// filing; this is the early warning, not the return.
// ---------------------------------------------------------------------------

export const VAT_REGISTRATION_THRESHOLD_GYD = 15_000_000;
export const VAT_EARLY_ALERT_GYD = 10_000_000;
export const VAT_APPLY_WITHIN_DAYS = 15;
const WEEK_MS = 7 * 86_400_000;
const WEEKS_A_YEAR = 52;

export type VatTrackerStatus = 'CLEAR' | 'EARLY_ALERT' | 'EXPECTED_TO_REACH' | 'THRESHOLD_REACHED';

export interface FeeMonth {
  /** Guyana calendar month, YYYY-MM. */
  month: string;
  due: number;
  received: number;
  returned: number;
  /** max(due, received): what the 12-month total counts for the month. */
  counted: number;
}

export interface VatTracker {
  tenantId: string;
  asOf: string;
  currencyCode: 'GYD';
  /** Twelve Guyana months, oldest first, ending with the month in progress. */
  months: FeeMonth[];
  /** The counted total of those twelve months. */
  last12Months: number;
  /** The year ahead from today's subscriptions (trial weeks nil). */
  expectedNext12Months: number;
  expectedFrom: { subscriptions: number; weeklyFees: number };
  thresholdGyd: number;
  earlyAlertGyd: number;
  applyWithinDays: number;
  status: VatTrackerStatus;
}

type Db = Pick<PrismaClient, 'billingEvent' | 'subscription'>;

const cents = (n: number) => Math.round(n * 100) / 100;
const monthOf = (at: Date) => guyanaDayKey(at).slice(0, 7);

function lastTwelveMonths(now: Date): string[] {
  const [y, m] = monthOf(now).split('-').map(Number) as [number, number];
  return Array.from({ length: 12 }, (_, i) => {
    const back = 11 - i;
    const total = y * 12 + (m - 1) - back;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
  });
}

/** A subscription whose payer is a partner of this tenant (a PRODUCTION
 *  tenant holds no synthetic accounts: the database refuses them [STA-1 DL-4];
 *  the filter stays as a second wall). */
function partnerOf(tenantId: string): Prisma.SubscriptionWhereInput {
  const payer = { tenantId, isSynthetic: false };
  return { OR: [{ rider: { user: payer } }, { driver: { user: payer } }, { vendor: { owner: { user: payer } } }] };
}

/** The week a charge key names: `success:<sub>:<YYYY-MM-DD>` / `charge:<sub>:<YYYY-MM-DD>:a<n>`. */
function weekOfKey(key: string): string | null {
  const m = /^(?:success|charge):[^:]+:(\d{4}-\d{2}-\d{2})(?::a\d+)?$/.exec(key);
  return m ? m[1]! : null;
}

export async function vatTracker(db: Db, tenantId: string, now = new Date()): Promise<VatTracker> {
  const months = lastTwelveMonths(now);
  const windowStart = startOfGuyanaDay(`${months[0]}-01`);
  const rows = new Map(months.map((month) => [month, { month, due: 0, received: 0, returned: 0, counted: 0 }]));
  const events = await db.billingEvent.findMany({
    where: {
      type: { in: ['CHARGE_ATTEMPT', 'CHARGE_SUCCESS', 'PREPAID_TOPUP', 'PREPAID_REVERSAL'] },
      currencyCode: 'GYD',
      // A week that started in the window may be charged a little after it began.
      createdAt: { gte: new Date(windowStart.getTime() - 5 * WEEK_MS) },
      subscription: partnerOf(tenantId),
    },
    select: { subscriptionId: true, type: true, amount: true, idempotencyKey: true, paymentRef: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  // Each week once: its settled amount, else the latest amount it was asked at.
  const weeks = new Map<string, { week: string; amount: number; settled: boolean }>();
  for (const e of events) {
    const amount = Number(e.amount ?? 0);
    if (!(amount > 0)) continue;
    if (e.type === 'PREPAID_TOPUP' || e.type === 'PREPAID_REVERSAL') {
      const row = rows.get(monthOf(e.createdAt));
      if (row && e.type === 'PREPAID_TOPUP') row.received += amount;
      if (row && e.type === 'PREPAID_REVERSAL') row.returned += amount;
      continue;
    }
    const week = weekOfKey(e.idempotencyKey);
    if (!week) continue;
    const slot = `${e.subscriptionId}:${week}`;
    const settled = e.type === 'CHARGE_SUCCESS';
    const seen = weeks.get(slot);
    if (!seen || settled || !seen.settled) weeks.set(slot, { week, amount, settled: settled || !!seen?.settled });
    // A fee charged straight to a card or an MMG request is money received when
    // it settles; one paid from fee credit was received when the credit came in.
    if (settled && e.paymentRef !== 'prepaid' && e.paymentRef !== 'fee-waived') {
      const row = rows.get(monthOf(e.createdAt));
      if (row) row.received += amount;
    }
  }
  for (const { week, amount } of weeks.values()) {
    const row = rows.get(week.slice(0, 7));
    if (row) row.due += amount;
  }
  const out = [...rows.values()].map((r) => ({
    month: r.month, due: cents(r.due), received: cents(r.received), returned: cents(r.returned), counted: cents(Math.max(r.due, r.received)),
  }));
  const last12Months = cents(out.reduce((sum, r) => sum + r.counted, 0));

  const subs = await db.subscription.findMany({
    where: { status: { in: ['ACTIVE', 'PAST_DUE', 'TRIAL'] }, autoRenew: true, currencyCode: 'GYD', ...partnerOf(tenantId) },
    select: { weeklyRate: true, customRate: true, isTrialActive: true, trialEndDate: true, status: true },
  });
  let expected = 0;
  let weeklyFees = 0;
  for (const s of subs) {
    // [CHAINS · REVIEW-M #2211] The fee the biller charges: a custom rate never above the tier rate.
    const weekly = weeklyFeeAmount(s);
    if (!(weekly > 0)) continue;
    const trialLeft = (s.isTrialActive || s.status === 'TRIAL') && s.trialEndDate && s.trialEndDate.getTime() > now.getTime()
      ? Math.ceil((s.trialEndDate.getTime() - now.getTime()) / WEEK_MS) : 0;
    expected += weekly * Math.max(0, WEEKS_A_YEAR - trialLeft);
    weeklyFees += weekly;
  }
  const expectedNext12Months = cents(expected);

  const status: VatTrackerStatus = last12Months >= VAT_REGISTRATION_THRESHOLD_GYD ? 'THRESHOLD_REACHED'
    : expectedNext12Months >= VAT_REGISTRATION_THRESHOLD_GYD ? 'EXPECTED_TO_REACH'
      : last12Months >= VAT_EARLY_ALERT_GYD ? 'EARLY_ALERT'
        : 'CLEAR';
  return {
    tenantId, asOf: now.toISOString(), currencyCode: 'GYD', months: out, last12Months, expectedNext12Months,
    expectedFrom: { subscriptions: subs.length, weeklyFees: cents(weeklyFees) },
    thresholdGyd: VAT_REGISTRATION_THRESHOLD_GYD, earlyAlertGyd: VAT_EARLY_ALERT_GYD, applyWithinDays: VAT_APPLY_WITHIN_DAYS, status,
  };
}

/** The admin alert for a tracker that is not CLEAR: what was reached, the numbers, and the 15-day deadline. */
export function vatAlert(t: VatTracker): { title: string; body: string } | null {
  if (t.status === 'CLEAR') return null;
  const gyd = (n: number) => formatMoney(n, 'GYD', { whole: true });
  const numbers = `Last 12 months: ${gyd(t.last12Months)} of weekly fees. Expected over the next 12 months from today's partners: ${gyd(t.expectedNext12Months)}. The VAT registration threshold is ${gyd(t.thresholdGyd)}.`;
  const deadline = `VAT Act s.11(1): apply to the GRA within ${t.applyWithinDays} days after the 12 months in which fees reach ${gyd(t.thresholdGyd)}, or at the start of a 12-month period in which they are expected to. Tell the accountant now.`;
  if (t.status === 'THRESHOLD_REACHED') {
    return { title: 'VAT: weekly fees have reached the registration threshold', body: `${numbers} ${deadline}` };
  }
  if (t.status === 'EXPECTED_TO_REACH') {
    return { title: 'VAT: weekly fees are expected to reach the registration threshold within 12 months', body: `${numbers} ${deadline}` };
  }
  return { title: `VAT: weekly fees passed ${gyd(t.earlyAlertGyd)} in the last 12 months`, body: `${numbers} ${deadline}` };
}

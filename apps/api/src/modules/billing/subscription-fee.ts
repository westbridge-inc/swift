// ---------------------------------------------------------------------------
// THE weekly fee a subscription will actually be charged.
//
// `customRate ?? weeklyRate` was written SEVEN times: the biller's own
// `amountFor`, the admin subscriptions list, the past-due notice, the USD
// migration, the agent-cash service and its route, and the trial-fee education
// job. All seven agreed — and one place did not use it at all.
//
// THE DASHBOARD summed `weeklyRate` alone. So every subscription on an explicit
// custom price was reported to the founder at its LIST price, and every
// subscription whose fee had been waived was reported as full revenue for a
// period in which it will be charged nothing. The headline number on the page
// the founder reads was not the number Swift will bill.
//
// This module is that answer, once. It imports nothing but the Decimal type, so
// anything can depend on it.
// ---------------------------------------------------------------------------

/** The two figures a subscription's price is made of. */
export interface Priced {
  weeklyRate: unknown;
  customRate?: unknown;
}

/** Whether this subscription's fee has been given away for the current period. */
export interface Waivable extends Priced {
  feeWaived?: boolean | null;
}

/**
 * THE price, as the biller reads it: an explicit custom rate wins over the
 * tier's list rate. Returned in whatever shape it was stored (Prisma `Decimal`
 * or number) so a caller that needs exactness keeps it.
 */
export function weeklyFeeFor<T>(sub: { weeklyRate: T; customRate?: T | null }): T {
  return sub.customRate ?? sub.weeklyRate;
}

/** The same price as a number, for display and arithmetic. */
export function weeklyFeeAmount(sub: Priced): number {
  const raw = (sub.customRate ?? sub.weeklyRate) as { toString(): string } | number | null | undefined;
  if (raw === null || raw === undefined) return 0;
  const n = typeof raw === 'number' ? raw : Number(raw.toString());
  return Number.isFinite(n) ? n : 0;
}

/**
 * What may honestly be counted as fee revenue for the current period: the
 * price, unless it has been waived — a waived subscription is charged zero and
 * counting it inflates the figure by exactly the amount that was given away.
 */
export function billableWeeklyFee(sub: Waivable): number {
  return sub.feeWaived ? 0 : weeklyFeeAmount(sub);
}

/** The amount given away this period, which is a number in its own right. */
export function waivedWeeklyFee(sub: Waivable): number {
  return sub.feeWaived ? weeklyFeeAmount(sub) : 0;
}

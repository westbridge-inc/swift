import type { PartnerTier } from '../country/country-config.service';

// ---------------------------------------------------------------------------
// How long a new partner's free trial is. ONE definition: the trial a
// subscription is born on (SubscriptionService.createRow), the trial grant the
// trial law records (TrialEntitlementService.recordGrant) and the trial the
// public price list quotes (GET /auth/pricing) all come from here.
//
// [Owner, 29 Oct 2026 ~22:31Z] Department stores ONLY get a 7-day free trial,
// for NEW signups. Every other partner keeps 14 days. A trial already running
// is never touched: the length is decided once, when the trial is granted.
//
// Which store is a department store: the tier ITS OWN catalogue reaches when
// Swift approves it (the moment its trial is granted), counted the way the
// weekly re-tier counts a lower tier (every listing available now, or made
// unavailable or edited in the last 7 days), by the market's department step
// (departmentCatalogueThreshold, 10,000 active items in Guyana). A new store
// is still BORN on its signup quote (the first step), whatever its trial.
//
// Which signup is NEW: a store created at or after the owner's ruling. A
// store that signed up before it was shown 14 days and keeps them.
// ---------------------------------------------------------------------------

/** Every partner's free trial, in days — what every new store starts on. */
export const TRIAL_DAYS = 14;

/** A department-store signup's free trial, in days (owner, 29 Oct 2026). */
export const DEPARTMENT_TRIAL_DAYS = 7;

/** The owner's ruling: a store created from this moment on is a NEW signup. */
export const DEPARTMENT_TRIAL_SINCE = new Date('2026-10-29T22:31:00.000Z');

/** The trial a partner on `tier` is quoted (the price list): 7 days at the department step, else 14. */
export function trialDaysForTier(tier: PartnerTier): number {
  return tier === 'department' ? DEPARTMENT_TRIAL_DAYS : TRIAL_DAYS;
}

/**
 * The trial a partner is granted NOW. `storeCreatedAt` is the store's signup (a
 * mover passes none: no mover tier is shortened); a department store that
 * signed up before the ruling keeps the 14 days it was offered.
 */
export function trialDaysFor(input: { tier: PartnerTier; storeCreatedAt?: Date | null }): number {
  if (input.tier !== 'department') return TRIAL_DAYS;
  const created = input.storeCreatedAt;
  if (!created || created.getTime() < DEPARTMENT_TRIAL_SINCE.getTime()) return TRIAL_DAYS;
  return DEPARTMENT_TRIAL_DAYS;
}

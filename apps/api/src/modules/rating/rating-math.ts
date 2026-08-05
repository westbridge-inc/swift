// ---------------------------------------------------------------------------
// Movement R — the math (R3, EXACT). Pure functions, fixture-gated (RAT-C):
// Bayesian-smoothed display so nobody launches at 1.0 off a single ambush,
// Uber-style count buckets, and standing bands whose ONLY teeth are a badge,
// a coaching card, or a FOUNDER-QUEUE item — machines never deactivate
// people (R-Law 3), ratings never touch dispatch (R-Law 4).
// ---------------------------------------------------------------------------

export const RATING_PRIOR_MEAN = 4.6;
export const RATING_PRIOR_WEIGHT = 10;
export const RATING_MIN_DISPLAY = 5;
export const RATING_ROLLING_COUNT = 100;
export const STANDING_MIN_EVENTS = 20;
export const TOP_RATED_MIN_COUNT = 50;
export const RATING_WINDOW_DAYS = 7;
export const RATING_MAX_TAGS = 4;
export const RATING_TEXT_MAX = 600;
export const REPLY_TEXT_MAX = 400;
export const SHIELD_PREP_BREACH_MIN = 10;
/** Founder-only decision, hardcoded-by-config (R-Law 4). */
export const RATING_AFFECTS_DISPATCH = false;

/** Bayesian display: round1((C·m + Σ) / (C + n)), shown only at n ≥ min. */
export function displayRating(lifetimeCount: number, lifetimeSum: number): number | null {
  if (lifetimeCount < RATING_MIN_DISPLAY) return null;
  const raw = (RATING_PRIOR_WEIGHT * RATING_PRIOR_MEAN + lifetimeSum) / (RATING_PRIOR_WEIGHT + lifetimeCount);
  // round1 half-up, capped at 5.0
  return Math.min(5, Math.round(raw * 10 + Number.EPSILON) / 10);
}

/** "(7)" · "(320+)" · "(5,000+)" — the public count bucket. */
export function countBucket(lifetimeCount: number): string {
  if (lifetimeCount < 10) return `(${lifetimeCount})`;
  if (lifetimeCount < 1000) return `(${Math.floor(lifetimeCount / 10) * 10}+)`;
  const thousands = Math.floor(lifetimeCount / 1000) * 1000;
  return `(${thousands.toLocaleString('en-US')}+)`;
}

export type StandingBand = 'EXCELLENT' | 'GOOD' | 'ATTENTION' | 'AT_RISK' | 'NEW';

/** Operational score = plain mean of the rolling window (recent truth). */
export function operationalScore(rollingCount: number, rollingSum: number): number | null {
  if (rollingCount === 0) return null;
  return rollingSum / rollingCount;
}

/** Standing evaluates only past STANDING_MIN_EVENTS; below = NEW/GOOD. */
export function standingBand(ratedEvents: number, rollingCount: number, rollingSum: number): StandingBand {
  if (ratedEvents < STANDING_MIN_EVENTS) return ratedEvents < RATING_MIN_DISPLAY ? 'NEW' : 'GOOD';
  const score = operationalScore(rollingCount, rollingSum);
  if (score == null) return 'NEW';
  if (score >= 4.8) return 'EXCELLENT';
  if (score >= 4.5) return 'GOOD';
  if (score >= 4.2) return 'ATTENTION';
  return 'AT_RISK';
}

/** Top-rated badge eligibility (vendors/providers need volume too). */
export function topRatedEligible(band: StandingBand, lifetimeCount: number, needsVolume: boolean): boolean {
  if (band !== 'EXCELLENT') return false;
  return needsVolume ? lifetimeCount >= TOP_RATED_MIN_COUNT : true;
}

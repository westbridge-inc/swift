/**
 * Driver Matching Algorithm
 *
 * Score = w1 * proximity + w2 * rating + w3 * acceptance_rate + w4 * completion_rate
 *
 * Weights: proximity=0.5, rating=0.2, acceptance=0.15, completion=0.15
 *
 * Process:
 * 1. GEORADIUS query: find online drivers within 5km of pickup
 * 2. Score each candidate driver
 * 3. Send ride request to top-scored driver
 * 4. 30-second accept/decline timeout
 * 5. If declined → next driver (max 6 attempts)
 * 6. If all fail → cancel with notification
 */

export interface MatchCandidate {
  driverId: string;
  distanceKm: number;
  rating: number;
  acceptanceRate: number;
  completionRate: number;
  score: number;
}

const WEIGHTS = {
  proximity: 0.5,
  rating: 0.2,
  acceptance: 0.15,
  completion: 0.15,
};

const MAX_RADIUS_KM = 5;
const MAX_ATTEMPTS = 6;
const TIMEOUT_SECONDS = 30;

export function scoreDriver(candidate: Omit<MatchCandidate, 'score'>): number {
  const proximityScore = 1 - candidate.distanceKm / MAX_RADIUS_KM;
  const ratingScore = candidate.rating / 5.0;

  return (
    WEIGHTS.proximity * Math.max(0, proximityScore) +
    WEIGHTS.rating * ratingScore +
    WEIGHTS.acceptance * candidate.acceptanceRate +
    WEIGHTS.completion * candidate.completionRate
  );
}

export function rankDrivers(candidates: Omit<MatchCandidate, 'score'>[]): MatchCandidate[] {
  return candidates
    .map((c) => ({ ...c, score: scoreDriver(c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ATTEMPTS);
}

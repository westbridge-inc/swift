// ---------------------------------------------------------------------------
// Dispatch candidate scoring — a pure function: proximity
// dominates, then track record. Lower score = offered first. No I/O, no
// randomness, no AI — unit-testable in isolation.
// ---------------------------------------------------------------------------

export interface DispatchCandidate {
  riderId: string;
  userId: string;
  etaMinutes: number;
  /** 0-5 stars */
  averageRating: number;
  /** 0-100 (% of offers accepted) */
  acceptanceRate: number;
  /** true while the rider already carries an active job */
  hasActiveJob: boolean;
}

const WEIGHTS = {
  eta: 0.5,
  rating: 0.2,
  acceptance: 0.15,
  load: 0.15,
} as const;

/** ETAs beyond this are treated as "max bad" so one outlier can't skew ranks */
const ETA_CEILING_MINUTES = 60;

export function scoreCandidate(candidate: DispatchCandidate): number {
  const eta = Math.min(candidate.etaMinutes, ETA_CEILING_MINUTES) / ETA_CEILING_MINUTES;
  const rating = (5 - clamp(candidate.averageRating, 0, 5)) / 5;
  const acceptance = 1 - clamp(candidate.acceptanceRate, 0, 100) / 100;
  const load = candidate.hasActiveJob ? 1 : 0;

  return (
    WEIGHTS.eta * eta +
    WEIGHTS.rating * rating +
    WEIGHTS.acceptance * acceptance +
    WEIGHTS.load * load
  );
}

/** Best candidate first. */
export function rankCandidates<T extends DispatchCandidate>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => scoreCandidate(a) - scoreCandidate(b));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

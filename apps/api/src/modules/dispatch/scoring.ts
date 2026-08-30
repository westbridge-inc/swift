// ---------------------------------------------------------------------------
// Dispatch candidate scoring — a pure function: proximity dominates, then track
// record. Lower score = offered first. No I/O, no randomness, no AI —
// unit-testable in isolation. The WEIGHT PROFILE is per-pool: a delivery rider a
// little farther but reliable is fine, but a TAXI rider WATCHES the assigned car
// move on the map — a farther car accepting while a nearer one idles reads as
// broken, so taxi makes proximity near-absolute and quality a small tie-break.
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

/** BALANCED = delivery/courier; PROXIMITY = taxi (the rider sees the car move). */
export type DispatchProfile = 'BALANCED' | 'PROXIMITY';

const WEIGHTS_BY_PROFILE: Record<DispatchProfile, { eta: number; rating: number; acceptance: number; load: number }> = {
  BALANCED: { eta: 0.5, rating: 0.2, acceptance: 0.15, load: 0.15 },
  // Proximity is near-absolute for taxi: rating/acceptance/load only reorder
  // effectively-equidistant cars. Tuned so a 3-min car is never ranked behind a
  // 14-min car regardless of the far car's rating/acceptance (see scoring test).
  PROXIMITY: { eta: 0.85, rating: 0.08, acceptance: 0.05, load: 0.02 },
};

/** ETAs beyond this are treated as "max bad" so one outlier can't skew ranks */
const ETA_CEILING_MINUTES = 60;

export function scoreCandidate(candidate: DispatchCandidate, profile: DispatchProfile = 'BALANCED'): number {
  const w = WEIGHTS_BY_PROFILE[profile];
  const eta = Math.min(candidate.etaMinutes, ETA_CEILING_MINUTES) / ETA_CEILING_MINUTES;
  const rating = (5 - clamp(candidate.averageRating, 0, 5)) / 5;
  const acceptance = 1 - clamp(candidate.acceptanceRate, 0, 100) / 100;
  const load = candidate.hasActiveJob ? 1 : 0;

  return w.eta * eta + w.rating * rating + w.acceptance * acceptance + w.load * load;
}

/** Best candidate first. */
export function rankCandidates<T extends DispatchCandidate>(candidates: T[], profile: DispatchProfile = 'BALANCED'): T[] {
  return [...candidates].sort((a, b) => scoreCandidate(a, profile) - scoreCandidate(b, profile));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// [ALG-01] The fairness band — the missing half. Scoring ranks correctly, but
// a rider who is consistently second-nearest can starve. A band, not a
// rotation: only candidates whose scores are effectively equal are reordered,
// so a 3-minute rider still never ranks behind a 14-minute one (the scoring
// test above stays green) and the customer never watches a farther car
// accept. Ties break by fewest offers received in the window, then by the
// longest wait since the last offer (never offered = longest), then by the
// original rank. Pure: the caller supplies the counts.
// ---------------------------------------------------------------------------

export interface FairnessInput {
  /** Score distance within which two candidates are "tied". */
  band: number;
  /** Offers each rider received in the fairness window. Missing = 0. */
  offersInWindow: ReadonlyMap<string, number>;
  /** When each rider last received an offer (ms epoch). Missing = never. */
  lastOfferAt: ReadonlyMap<string, number>;
}

export interface FairnessResult<T> {
  order: T[];
  /** Whether the band moved anyone relative to the pure ranking. */
  changed: boolean;
  /** Which positions were tied groups of size > 1 — the evidence. */
  groups: Array<{ from: number; size: number }>;
}

export function applyFairnessBand<T extends DispatchCandidate>(ranked: T[], profile: DispatchProfile, f: FairnessInput): FairnessResult<T> {
  const order: T[] = [];
  const groups: FairnessResult<T>['groups'] = [];
  let i = 0;
  while (i < ranked.length) {
    const head = scoreCandidate(ranked[i]!, profile);
    let j = i + 1;
    while (j < ranked.length && scoreCandidate(ranked[j]!, profile) - head < f.band) j += 1;
    const group = ranked.slice(i, j);
    if (group.length > 1) {
      groups.push({ from: i, size: group.length });
      const rankOf = new Map(group.map((c, k) => [c.riderId, k]));
      group.sort((a, b) =>
        (f.offersInWindow.get(a.riderId) ?? 0) - (f.offersInWindow.get(b.riderId) ?? 0)
        || (f.lastOfferAt.get(a.riderId) ?? 0) - (f.lastOfferAt.get(b.riderId) ?? 0)
        || (rankOf.get(a.riderId) ?? 0) - (rankOf.get(b.riderId) ?? 0));
    }
    order.push(...group);
    i = j;
  }
  const changed = order.some((c, k) => c.riderId !== ranked[k]!.riderId);
  return { order, changed, groups };
}

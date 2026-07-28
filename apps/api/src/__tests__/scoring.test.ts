import { describe, it, expect } from 'vitest';
import { scoreCandidate, rankCandidates, type DispatchCandidate } from '../modules/dispatch/scoring';

const cand = (over: Partial<DispatchCandidate>): DispatchCandidate => ({
  riderId: 'r', userId: 'u', etaMinutes: 5, averageRating: 4, acceptanceRate: 80, hasActiveJob: false, ...over,
});

describe('dispatch scoring — per-pool weight profiles', () => {
  describe('taxi (PROXIMITY): proximity is near-absolute', () => {
    it('a 3-min car is NEVER ranked behind a 14-min car, whatever the far car rates', () => {
      // The rider watches the car on the map — a farther car offered first is broken.
      const near = cand({ etaMinutes: 3, averageRating: 0, acceptanceRate: 0, hasActiveJob: true }); // worst quality
      const far = cand({ etaMinutes: 14, averageRating: 5, acceptanceRate: 100, hasActiveJob: false }); // pristine
      expect(scoreCandidate(near, 'PROXIMITY')).toBeLessThan(scoreCandidate(far, 'PROXIMITY'));
      expect(rankCandidates([far, near], 'PROXIMITY')[0]!.etaMinutes).toBe(3);
    });

    it('quality only reorders effectively-equidistant cars', () => {
      const a = cand({ etaMinutes: 4, averageRating: 3.0 });
      const b = cand({ etaMinutes: 4, averageRating: 5.0 });
      expect(rankCandidates([a, b], 'PROXIMITY')[0]!.averageRating).toBe(5.0);
    });
  });

  describe('delivery (BALANCED): unchanged — quality co-weighs with distance', () => {
    it('at equal ETA the better-rated, more-reliable courier wins', () => {
      const worse = cand({ etaMinutes: 3, averageRating: 4.2, acceptanceRate: 60 });
      const better = cand({ etaMinutes: 3, averageRating: 5, acceptanceRate: 100 });
      expect(scoreCandidate(better, 'BALANCED')).toBeLessThan(scoreCandidate(worse, 'BALANCED'));
    });

    it('default profile is BALANCED — the existing delivery behavior is preserved', () => {
      const c = cand({ etaMinutes: 7, averageRating: 4.5, acceptanceRate: 70 });
      expect(scoreCandidate(c)).toBe(scoreCandidate(c, 'BALANCED'));
    });
  });
});

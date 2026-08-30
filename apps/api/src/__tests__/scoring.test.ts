import { describe, it, expect } from 'vitest';
import { applyFairnessBand } from '../modules/dispatch/scoring';
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

// ---------------------------------------------------------------------------
// [ALG-01] The fairness band — only effectively-equal candidates move.
// ---------------------------------------------------------------------------
describe('ALG-01 fairness band', () => {
  const rider = (riderId: string, etaMinutes: number, extra: Partial<{ averageRating: number; acceptanceRate: number; hasActiveJob: boolean }> = {}) => ({
    riderId, userId: `u-${riderId}`, etaMinutes, averageRating: 5, acceptanceRate: 100, hasActiveJob: false, ...extra,
  });
  const noOffers = { band: 0.05, offersInWindow: new Map<string, number>(), lastOfferAt: new Map<string, number>() };

  it('three riders at equal ETA: the one with the fewest offers this hour goes first, then the longest since an offer, then the pure rank', () => {
    const ranked = rankCandidates([rider('a', 4), rider('b', 4), rider('c', 4)], 'BALANCED');
    const r = applyFairnessBand(ranked, 'BALANCED', {
      band: 0.05,
      offersInWindow: new Map([['a', 3], ['b', 1], ['c', 1]]),
      lastOfferAt: new Map([['a', 3000], ['b', 2000], ['c', 1000]]),
    });
    expect(r.order.map((c) => c.riderId)).toEqual(['c', 'b', 'a']);
    expect(r.changed).toBe(true);
    expect(r.groups).toEqual([{ from: 0, size: 3 }]);
  });

  it('never offered beats offered; with nothing to break on, the pure rank stands and nothing is reported as changed', () => {
    const ranked = rankCandidates([rider('a', 4), rider('b', 4)], 'BALANCED');
    const r = applyFairnessBand(ranked, 'BALANCED', { ...noOffers, offersInWindow: new Map([['a', 1]]) });
    expect(r.order.map((c) => c.riderId)).toEqual(['b', 'a']);
    const same = applyFairnessBand(ranked, 'BALANCED', noOffers);
    expect(same.order.map((c) => c.riderId)).toEqual(ranked.map((c) => c.riderId));
    expect(same.changed).toBe(false);
  });

  it('taxi: a 3-minute car never ranks behind a 14-minute car, however starved the far one is — a band, not a rotation', () => {
    const ranked = rankCandidates([rider('far', 14, { averageRating: 5, acceptanceRate: 100 }), rider('near', 3, { averageRating: 3, acceptanceRate: 60 })], 'PROXIMITY');
    const r = applyFairnessBand(ranked, 'PROXIMITY', { band: 0.05, offersInWindow: new Map([['near', 50]]), lastOfferAt: new Map([['near', Date.now()]]) });
    expect(r.order[0]!.riderId).toBe('near');
    expect(r.changed).toBe(false);
  });

  it('delivery: candidates outside the band keep their pure order whatever their offer counts', () => {
    const ranked = rankCandidates([rider('near', 3), rider('far', 14)], 'BALANCED');
    const r = applyFairnessBand(ranked, 'BALANCED', { band: 0.05, offersInWindow: new Map([['near', 50]]), lastOfferAt: new Map([['near', Date.now()]]) });
    expect(r.order.map((c) => c.riderId)).toEqual(['near', 'far']);
    expect(r.changed).toBe(false);
  });

  it('the band is measured from the best of each group, so a chain of near-equals does not creep', () => {
    // Scores step by 0.03 each: a, b tie (0.03 < 0.05); c is 0.06 from a → its own group with d.
    const ranked = [rider('a', 6), rider('b', 7), rider('c', 8), rider('d', 9)];
    const r = applyFairnessBand(ranked, 'PROXIMITY', {
      band: 0.02,
      offersInWindow: new Map([['a', 5], ['b', 0], ['c', 5], ['d', 0]]),
      lastOfferAt: new Map(),
    });
    expect(r.groups).toEqual([{ from: 0, size: 2 }, { from: 2, size: 2 }]);
    expect(r.order.map((c) => c.riderId)).toEqual(['b', 'a', 'd', 'c']);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  arrivalEvidence,
  arrivalGate,
  ARRIVAL_GATE_MAX_DISTANCE_KM,
  MAX_ARRIVAL_FIX_AGE_MS,
} from '../modules/dispatch/arrival-evidence';
import { DEFAULT_CASH_RULES } from '../modules/cash/cash-rules.service';

// ---------------------------------------------------------------------------
// [Band F] The money moment was guarded and the clock-starting moment was not.
//
// `PUT /rides/:id/arrived` took NO BODY and read no position. Its own comment
// said so: "'reported', not 'arrived': pressing the button is the driver's
// claim about where they are, and nothing here tests it against a position."
// One step later the cash handover refuses to auto-pay a claim raised from
// across town — so the platform protected the payment and left unguarded the
// moment that starts the customer's waiting clock, on which every no-show and
// waiting-fee decision hangs.
//
// The evidence function does NOT refuse arrivals: it writes down what was true,
// and a driver at the door under a tin roof with no fix can still be there
// (cash-rules' own philosophy: flag into human review, never refuse a money
// outcome outright). The E19 gate built on top of it (below) refuses the
// status claim, with the passenger confirm as the escape hatch.
// ---------------------------------------------------------------------------

const PICKUP = { lat: 6.8013, lng: -58.1551 };          // Georgetown
const NOW = new Date('2026-08-29T12:00:00.000Z');
const fresh = (ms = 0) => new Date(NOW.getTime() - ms);

describe('what was true when the clock started [Band F]', () => {
  it('a driver at the pickup point is recorded with the distance, and not flagged', () => {
    // ~40 m away: a large compound, not a lie.
    const e = arrivalEvidence({ lat: 6.8016, lng: -58.1553, at: fresh(5_000) }, PICKUP, NOW);
    expect(e.verdict).toBe('at-pickup');
    expect(e.needsReview).toBe(false);
    expect(e.distanceM).toBeLessThan(100);
    expect(e.note).toContain('gps:6.80160,-58.15530');
    expect(e.note).toMatch(/\d+m from the pickup point/);
  });

  it('a declaration from across town is flagged — and still accepted', () => {
    // ~8 km away. This is the case the feature exists for.
    const e = arrivalEvidence({ lat: 6.8700, lng: -58.1551, at: fresh(5_000) }, PICKUP, NOW);
    expect(e.verdict).toBe('far');
    expect(e.needsReview).toBe(true);
    expect(e.distanceM).toBeGreaterThan(DEFAULT_CASH_RULES.maxHandoverDistanceKm * 1000);
    // Flagged, not refused: the function returns evidence, it never throws.
    expect(e.note).toContain('gps:');
  });

  it('a stale fix is called stale, not "far" and not "at the pickup"', () => {
    // Right next to the pickup, but the fix predates the declaration. Reporting
    // this as at-pickup would let a driver park, walk away, and declare later.
    const e = arrivalEvidence(
      { lat: 6.8016, lng: -58.1553, at: fresh(MAX_ARRIVAL_FIX_AGE_MS + 60_000) },
      PICKUP,
      NOW,
    );
    expect(e.verdict).toBe('stale');
    expect(e.needsReview).toBe(true);
    expect(e.note).toMatch(/fix was \d+ min old/);
  });

  it('no fix at all is recorded as exactly that, and flagged', () => {
    // Degraded data may only make the system more conservative. An arrival
    // with nothing behind it is the one a reviewer should be able to find.
    const e = arrivalEvidence({ lat: null, lng: null, at: null }, PICKUP, NOW);
    expect(e.verdict).toBe('no-fix');
    expect(e.needsReview).toBe(true);
    expect(e.distanceM).toBeNull();
    expect(e.note).toContain('no location fix on record');
    // It must NOT imply a distance was checked and passed.
    expect(e.note).not.toMatch(/from the pickup point/);
  });

  it('an order with no pickup point is a DIFFERENT absence from a missing fix', () => {
    // Mislabelling this would send a reviewer looking at the driver when the
    // gap is in the order.
    const e = arrivalEvidence({ lat: 6.8016, lng: -58.1553, at: fresh(1_000) }, { lat: null, lng: null }, NOW);
    expect(e.verdict).toBe('no-pickup');
    expect(e.needsReview).toBe(true);
    expect(e.note).toContain('no pickup point to measure against');
  });

  it('the boundary belongs to the driver, not to us', () => {
    // Exactly at the threshold is NOT flagged. GPS drift is real and the
    // benefit of a metre goes to the person standing outside.
    const atLimit = arrivalEvidence({ lat: 6.8013, lng: -58.1551, at: fresh(1_000) }, PICKUP, NOW);
    expect(atLimit.needsReview).toBe(false);
    // And a fix exactly at the age limit is still current.
    const atAge = arrivalEvidence(
      { lat: 6.8013, lng: -58.1551, at: fresh(MAX_ARRIVAL_FIX_AGE_MS) },
      PICKUP,
      NOW,
    );
    expect(atAge.verdict).toBe('at-pickup');
  });

  it('the threshold is cash-rules\' number, not a second one invented here', () => {
    // A tighter local threshold would mean the arrival and the handover one
    // step later disagree about what "at the door" means.
    const justInside = arrivalEvidence(
      { lat: PICKUP.lat + 0.005, lng: PICKUP.lng, at: fresh(1_000) }, // ~556 m
      PICKUP,
      NOW,
    );
    expect(justInside.distanceM).toBeLessThan(DEFAULT_CASH_RULES.maxHandoverDistanceKm * 1000);
    expect(justInside.verdict).toBe('at-pickup');
  });
});

describe('the evidence format still has exactly one author', () => {
  it('arrival-evidence.ts imports gpsEvidence and never writes the template', () => {
    // kerb-anti-fork.test.ts already asserts this repo-wide, and its own comment
    // records that it caught a second author being added FOR ARRIVAL EVIDENCE.
    // Asserted here too, next to the feature that tried it, so the next attempt
    // fails beside the code rather than in a file someone may not open.
    const src = readFileSync(path.join(__dirname, '..', 'modules', 'dispatch', 'arrival-evidence.ts'), 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(stripped.length).toBeGreaterThan(0);
    expect(stripped).toContain('gpsEvidence');
    expect(stripped).not.toContain('gps:$');
  });

  it('the arrival endpoint records evidence rather than a fixed sentence', () => {
    const src = readFileSync(path.join(__dirname, '..', 'modules', 'driver', 'driver.routes.ts'), 'utf8');
    // The note must come from the evidence (now through the E19 gate, which
    // spreads the same `arrivalEvidence` result), and the clock must be stamped.
    expect(src).toMatch(/note:\s*gate\.note/);
    expect(src).toContain('driverArrivedAt');
  });
});

describe('the arrival gate refuses the claim while the evidence stays the evidence', () => {
  it('allows a fresh fix ~40 m away', () => {
    const g = arrivalGate({ lat: 6.8016, lng: -58.1553, at: fresh(5_000) }, PICKUP, NOW);
    expect(g.allowed).toBe(true);
    expect(g.verdict).toBe('at-pickup');
    expect(g.needsReview).toBe(false);
  });

  it('refuses a fix ~400 m away that the 750 m handover guard would still pass', () => {
    // ~400 m: inside the cash handover guard, outside the 300 m arrival gate.
    const g = arrivalGate({ lat: PICKUP.lat + 0.0036, lng: PICKUP.lng, at: fresh(1_000) }, PICKUP, NOW);
    expect(g.allowed).toBe(false);
    expect(g.verdict).toBe('far');
    expect(g.distanceM).toBeGreaterThan(ARRIVAL_GATE_MAX_DISTANCE_KM * 1000);
    expect(g.distanceM).toBeLessThan(DEFAULT_CASH_RULES.maxHandoverDistanceKm * 1000);
  });

  it('refuses a stale fix and a missing fix', () => {
    const stale = arrivalGate(
      { lat: 6.8016, lng: -58.1553, at: fresh(MAX_ARRIVAL_FIX_AGE_MS + 60_000) },
      PICKUP,
      NOW,
    );
    expect(stale.allowed).toBe(false);
    expect(stale.verdict).toBe('stale');

    const none = arrivalGate({ lat: null, lng: null, at: null }, PICKUP, NOW);
    expect(none.allowed).toBe(false);
    expect(none.verdict).toBe('no-fix');
  });

  it('uses the documented 300 m radius, tighter than the handover guard', () => {
    expect(ARRIVAL_GATE_MAX_DISTANCE_KM).toBe(0.3);
    expect(ARRIVAL_GATE_MAX_DISTANCE_KM).toBeLessThan(DEFAULT_CASH_RULES.maxHandoverDistanceKm);
  });
});

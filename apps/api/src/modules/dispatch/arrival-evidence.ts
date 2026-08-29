import { gpsEvidence, DEFAULT_CASH_RULES } from '../cash/cash-rules.service';
import { haversineDistance } from '../../utils/distance';

/**
 * [Band F] What was true when the customer's clock started.
 *
 * `DRIVER_ARRIVED` is the moment every waiting fee and no-show decision in
 * SWIFT_KERB_AND_COCKPIT.md hangs off, and until now nothing recorded where the
 * driver was when they declared it. The handover one step later is protected —
 * cash-rules refuses to auto-pay a claim raised from across town — so the money
 * moment was guarded and the clock-starting moment was not.
 *
 * THIS DOES NOT REFUSE ANYTHING. It composes the immutable status-log note. The
 * philosophy is cash-rules': flag into human review, never refuse a money
 * outcome outright. A driver standing at the door under a tin roof with no GPS
 * fix must still be able to say they have arrived.
 *
 * THE EVIDENCE FORMAT IS NOT DEFINED HERE. `gpsEvidence` in cash-rules is its
 * one author and `kerb-anti-fork.test.ts` enforces that by name, because one
 * appeal view has to read deliveries, rides and arrivals through the same lens.
 * That gate has already caught a second author being added for exactly this
 * feature. So this file imports it.
 */

/** How stale a fix may be and still describe where the driver is now. Two
 *  minutes is generous for a phone that has just been put down, and short
 *  enough that a fix from the other side of the trip cannot pass as current. */
export const MAX_ARRIVAL_FIX_AGE_MS = 2 * 60 * 1000;

export type ArrivalVerdict =
  /** The fix is recent and near the pickup point. */
  | 'at-pickup'
  /** Recent fix, but further away than a large compound explains. */
  | 'far'
  /** A fix exists but predates the declaration by more than the window. */
  | 'stale'
  /** No fix at all — the mover has never reported a position, or the stream
   *  has not started. Recorded, never refused. */
  | 'no-fix'
  /** The ORDER has no pickup coordinate to measure against. A different
   *  absence from 'no-fix', and mislabelling it would send a reviewer looking
   *  at the driver when the gap is in the order. */
  | 'no-pickup';

export interface ArrivalEvidence {
  verdict: ArrivalVerdict;
  /** Metres from the declared position to the pickup, when both are known. */
  distanceM: number | null;
  /** Age of the fix at the moment of declaration, when there is one. */
  fixAgeMs: number | null;
  /** The immutable status-log note. Written for a human reading an appeal a
   *  month later, not for a parser. */
  note: string;
  /** True when a reviewer should look. Advisory: nothing acts on it yet, and
   *  nothing here penalises anyone. */
  needsReview: boolean;
}

export function arrivalEvidence(
  fix: { lat: number | null; lng: number | null; at: Date | null },
  pickup: { lat: number | null; lng: number | null },
  declaredAt: Date,
  maxDistanceKm: number = DEFAULT_CASH_RULES.maxHandoverDistanceKm,
): ArrivalEvidence {
  const base = 'Driver reported arriving at the pickup point';

  if (pickup.lat == null || pickup.lng == null) {
    // An order with no pickup coordinate cannot have its arrival measured
    // against one. Rare, and it must not throw at the kerb — the driver is
    // standing there either way. Say what is missing rather than implying the
    // distance was checked and passed.
    const where = fix.lat != null && fix.lng != null ? ` — ${gpsEvidence(fix.lat, fix.lng)}` : '';
    return {
      verdict: 'no-pickup',
      distanceM: null,
      fixAgeMs: null,
      note: `${base}${where}, but the order carries no pickup point to measure against`,
      needsReview: true,
    };
  }

  if (fix.lat == null || fix.lng == null || fix.at == null) {
    // Degraded data may only make the system MORE conservative: an arrival with
    // no position behind it is exactly the one a reviewer should be able to
    // find, so it is flagged rather than quietly recorded as ordinary.
    return {
      verdict: 'no-fix',
      distanceM: null,
      fixAgeMs: null,
      note: `${base} — no location fix on record at the time`,
      needsReview: true,
    };
  }

  const fixAgeMs = declaredAt.getTime() - fix.at.getTime();
  const distanceM = Math.round(haversineDistance(fix.lat, fix.lng, pickup.lat, pickup.lng) * 1000);
  const where = gpsEvidence(fix.lat, fix.lng);

  if (fixAgeMs > MAX_ARRIVAL_FIX_AGE_MS) {
    const mins = Math.round(fixAgeMs / 60_000);
    return {
      verdict: 'stale',
      distanceM,
      fixAgeMs,
      note: `${base} — ${where} ${distanceM}m away, but that fix was ${mins} min old`,
      needsReview: true,
    };
  }

  if (distanceM > maxDistanceKm * 1000) {
    return {
      verdict: 'far',
      distanceM,
      fixAgeMs,
      note: `${base} — ${where}, ${distanceM}m from the pickup point`,
      needsReview: true,
    };
  }

  return {
    verdict: 'at-pickup',
    distanceM,
    fixAgeMs,
    note: `${base} — ${where}, ${distanceM}m from the pickup point`,
    needsReview: false,
  };
}

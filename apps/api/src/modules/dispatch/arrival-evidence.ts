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
 * `arrivalEvidence` below still refuses nothing: it composes the immutable
 * status-log note (cash-rules' philosophy — flag into human review, never
 * refuse a money outcome outright). The E19 gate built on top of it
 * (`arrivalGate`) refuses the driver's *status claim* when the server-side fix
 * cannot support it, and that refusal always carries a one-tap escape — the
 * passenger, who can see the car, confirms via
 * POST /rides/:id/confirm-driver-arrival. A driver standing at the door under a
 * tin roof with no GPS fix is therefore never stranded.
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

/** How close the driver must be to declare arrival. Tighter than the 750 m
 *  handover guard (cash-rules.service.ts:49): this starts the customer's
 *  clock; the handover guard decides money. */
export const ARRIVAL_GATE_MAX_DISTANCE_KM = 0.3;

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

/** The refusal copy for each non-passing verdict. `at-pickup` is unreachable
 *  here — `arrivalGate.allowed` is exactly that verdict — but the map stays
 *  total so a verdict rename cannot silently 500 the driver. */
export const ARRIVAL_GATE_COPY: Record<ArrivalVerdict, string> = {
  'at-pickup': 'The driver is at the pickup point.',
  far: "You're too far from the pickup point to confirm arrival. Drive closer and try again, or ask the passenger to confirm your arrival.",
  stale: "Your location is out of date. Open the app and try again once your GPS updates, or ask the passenger to confirm your arrival.",
  'no-fix': "Swift can't verify your location right now. Ask the passenger to confirm your arrival, or contact support.",
  'no-pickup': "Swift can't verify your location right now. Ask the passenger to confirm your arrival, or contact support.",
};

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

/** [E19] The arrival gate: refuse a driver-reported arrival whose server-side
 *  fix cannot support the claim. Delegates to `arrivalEvidence` with the
 *  tighter 300 m radius — the evidence format keeps its single author
 *  (`kerb-anti-fork.test.ts` enforces that), and the refusal is of a status
 *  claim only, with a passenger-confirm override one tap away. */
export function arrivalGate(
  fix: { lat: number | null; lng: number | null; at: Date | null },
  pickup: { lat: number | null; lng: number | null },
  declaredAt: Date,
): ArrivalEvidence & { allowed: boolean } {
  const evidence = arrivalEvidence(fix, pickup, declaredAt, ARRIVAL_GATE_MAX_DISTANCE_KM);
  return { ...evidence, allowed: evidence.verdict === 'at-pickup' };
}

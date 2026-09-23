// THE DOOR [MOB-023] — pure, no RN imports, fully testable.
//
// What the rider may do at the customer's door is the SERVER's to say. The
// screen used to decide "collect NOTHING" from `paymentMethod === 'MOBILE_MONEY'`
// alone: the method says how the customer intended to pay, and only the
// payment STATE says whether money landed. The server now carries a handover
// authority on every rider job (rail, payment state, custody state, amount,
// a version, and what is permitted); the door renders THAT, and when the
// payload predates the authority it derives the conservative answer itself —
// a mobile-money order is "already paid" only when its state is CAPTURED.

export type HandoverPermission = 'DELIVER_NO_CASH' | 'COLLECT_CASH_THEN_DELIVER' | 'BLOCKED';

/**
 * [DOC-INV-48 · F-106-01] The rule set the server computed an authority under.
 *
 * An authority from a server that predates the dispute rule is syntactically
 * perfect and will happily say DELIVER_NO_CASH on a disputed order, so the
 * client will not act on a policy it does not recognise: for a mobile-money
 * order that means the door stays shut.
 *
 * WHY THIS IS A SET, AND NOT ONE STRING. It was one string, matched exactly,
 * and its own doc comment said "bump this whenever the door's rules change" —
 * an instruction that, followed on the API alone, blocks EVERY mobile-money
 * handover in the fleet. Mobile builds are never atomic with an API deploy
 * (EAS, OTA, app-store review), and the refusal is minted on the DEVICE, so
 * nothing in server telemetry would show it. Cash keeps working, so the
 * dashboards look normal while every rider on a mobile-money order is stuck at
 * a customer's door.
 *
 * Two things follow, and both are load-bearing:
 *
 *  1. A release that introduces a new policy keeps the previous one here for
 *     one release, so an app and an API from adjacent releases interoperate in
 *     BOTH directions — a forward rollout and a rollback.
 *  2. `handover-policy-contract.test.ts` in the API reads THIS FILE and fails
 *     the build if the API's `HANDOVER_POLICY` is not in this list. The drift
 *     therefore cannot reach production at all; it is a red build, not an
 *     outage. That test is the reason this comment can be trusted.
 *
 * Ordered newest first. Drop the tail entry one release after the new one ships.
 */
export const ACCEPTED_HANDOVER_POLICIES: readonly string[] = ['mismatch-1'];

/** The policy this build prefers and mints fixtures under: the newest accepted. */
export const HANDOVER_POLICY = ACCEPTED_HANDOVER_POLICIES[0]!;

/** [F-106-01] The client could not derive permission, so it did not. */
export const HANDOVER_AUTHORITY_REQUIRED = 'HANDOVER_AUTHORITY_REQUIRED';

export interface HandoverAuthority {
  policy: string;
  rail: 'CASH' | 'MOBILE_MONEY' | 'OTHER';
  paymentState: string;
  custodyState: string;
  amount: number;
  currency: string;
  version: string;
  permitted: HandoverPermission;
  blockReason: string | null;
}

export type Door =
  /** Money landed: hand over, collect nothing. */
  | { kind: 'no-cash'; version: string | null; source: 'server' | 'derived' }
  /** Cash rail: the cash door collects (or records the failed outcome) and completes. */
  | { kind: 'collect-cash'; version: string | null; source: 'server' | 'derived' }
  /** The rail says paid, the state does not: no hand-over. */
  | { kind: 'blocked'; reason: string; version: string | null; source: 'server' | 'derived' };

interface JobLike {
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  handover?: Partial<HandoverAuthority> | null;
}

const PERMISSIONS: ReadonlySet<string> = new Set(['DELIVER_NO_CASH', 'COLLECT_CASH_THEN_DELIVER', 'BLOCKED']);

/** The server's authority, validated; null when the payload has none or it is malformed. */
export function parseHandoverAuthority(raw: unknown): HandoverAuthority | null {
  if (!raw || typeof raw !== 'object') return null;
  const h = raw as Record<string, unknown>;
  // [F-106-01] An authority from an unrecognised policy is treated exactly like
  // no authority at all — which, for a mobile-money order, means the door stays
  // shut. This is the whole point of the discriminator.
  if (typeof h['policy'] !== 'string' || !ACCEPTED_HANDOVER_POLICIES.includes(h['policy'])) return null;
  if (typeof h['permitted'] !== 'string' || !PERMISSIONS.has(h['permitted'])) return null;
  if (typeof h['version'] !== 'string' || !h['version']) return null;
  if (h['rail'] !== 'CASH' && h['rail'] !== 'MOBILE_MONEY' && h['rail'] !== 'OTHER') return null;
  return {
    // The policy the SERVER used, not the one this build prefers. Overwriting it
    // with our own constant would erase the only evidence of which rule set
    // actually decided the door during a mixed-version rollout.
    policy: h['policy'],
    rail: h['rail'],
    paymentState: typeof h['paymentState'] === 'string' ? h['paymentState'] : 'UNKNOWN',
    custodyState: typeof h['custodyState'] === 'string' ? h['custodyState'] : 'UNKNOWN',
    amount: typeof h['amount'] === 'number' && Number.isFinite(h['amount']) ? h['amount'] : 0,
    currency: typeof h['currency'] === 'string' ? h['currency'] : 'GYD',
    version: h['version'],
    permitted: h['permitted'] as HandoverPermission,
    blockReason: typeof h['blockReason'] === 'string' ? h['blockReason'] : null,
  };
}

/** What the door does for this job. The server's word first; a conservative derivation when it is missing. */
export function doorFor(job: JobLike | null | undefined): Door {
  const authority = parseHandoverAuthority(job?.handover);
  if (authority) {
    if (authority.permitted === 'DELIVER_NO_CASH') return { kind: 'no-cash', version: authority.version, source: 'server' };
    if (authority.permitted === 'COLLECT_CASH_THEN_DELIVER') return { kind: 'collect-cash', version: authority.version, source: 'server' };
    return { kind: 'blocked', reason: authority.blockReason ?? `${authority.rail}_${authority.paymentState}`, version: authority.version, source: 'server' };
  }
  // No authority on the payload, or one this client will not trust.
  const method = job?.paymentMethod ?? null;
  const state = job?.paymentStatus ?? 'UNKNOWN';

  // ---------------------------------------------------------------------
  // [DOC-INV-48 · F-106-01] A MOBILE-MONEY DOOR IS NEVER DERIVED HERE.
  //
  // My first attempt closed only the CLAIMED case, reasoning that CAPTURED is
  // provider evidence the device may act on. Codex refuted it by running this
  // function: the SERVER blocks CAPTURED + mismatch, because provider evidence
  // does not settle a disagreement about that evidence — so a client deriving
  // `no-cash` from CAPTURED opens exactly the door the server closed. The
  // fallback has no `mmgClaimMismatchAt` and cannot know the order is
  // undisputed; that fact is server-owned by design.
  //
  //   missing   {"kind":"no-cash",...,"source":"derived"}   <- the counterexample
  //   malformed {"kind":"no-cash",...,"source":"derived"}
  //
  // The same reasoning that makes the final route's 409 worthless after the
  // goods are handed over applies here, one step earlier. Without a valid,
  // current-policy authority, a mobile-money door stays SHUT whatever the
  // payment state says.
  // ---------------------------------------------------------------------
  if (method === 'MOBILE_MONEY') {
    return { kind: 'blocked', reason: HANDOVER_AUTHORITY_REQUIRED, version: null, source: 'derived' };
  }
  // Other rails: the mismatch column cannot apply to them, so the old
  // conservative derivation stands — CAPTURED is money that landed.
  if (state === 'CAPTURED') return { kind: 'no-cash', version: null, source: 'derived' };
  if (state === 'CLAIMED') return { kind: 'blocked', reason: HANDOVER_AUTHORITY_REQUIRED, version: null, source: 'derived' };
  if (method === 'CASH') return { kind: 'collect-cash', version: null, source: 'derived' };
  return { kind: 'blocked', reason: `${method ?? 'UNKNOWN_RAIL'}_${state}`, version: null, source: 'derived' };
}

/**
 * [DOC-INV-48 · F-106-03] WHAT THE RIDER IS ACTUALLY TOLD, AND WHAT THEY CAN DO.
 *
 * Every blocked door rendered the same sentence: "Ask the store to confirm the
 * payment, then refresh." For a payment DISPUTE that advice is false and the
 * person following it is stranded — the store has already confirmed, which is
 * precisely why there is a dispute, and only a human resolution clears it. No
 * amount of refreshing will change the answer, and the rider is left holding
 * somebody's food learning that by trying a handover the server will refuse.
 *
 * The reason decides the sentence AND the way out.
 */
export type DoorAction = 'refresh' | 'support' | 'both';
export interface DoorGuidance {
  /** What is true, and what not to do. */
  readonly headline: string;
  /** Which way out actually works for this reason. */
  readonly action: DoorAction;
}

export function doorGuidanceFor(reason: string): DoorGuidance {
  if (reason === 'MMG_CLAIM_MISMATCH') {
    return {
      headline: 'Payment dispute open — do not hand over. Keep the order with you and contact support. The store confirming again cannot clear this.',
      action: 'support',
    };
  }
  if (reason === 'MMG_MISMATCH_UNKNOWN' || reason === HANDOVER_AUTHORITY_REQUIRED || reason === 'PAYMENT_STATE_INCONSISTENT') {
    return {
      headline: 'Swift cannot verify this handover right now — do not hand over. Refresh, and contact support if it stays blocked.',
      action: 'both',
    };
  }
  // The original family: the money simply has not landed yet. Here the store
  // confirming IS the resolution, so the old advice is the right advice.
  return {
    headline: `Payment not confirmed (${reason.replace(/_/g, ' ').toLowerCase()}) — do not hand over the order yet. Ask the store to confirm the payment, then refresh.`,
    action: 'refresh',
  };
}

/** [F-106-03] Server refusals whose door the screen should re-read and count. */
export const DOOR_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'HANDOVER_STALE', 'PAYMENT_NOT_CAPTURED', 'MMG_PAYMENT_PENDING',
  'MMG_CLAIM_MISMATCH', 'MMG_MISMATCH_UNKNOWN', 'PAYMENT_STATE_INCONSISTENT',
]);

// ---------------------------------------------------------------------------
// Counters: handover_block_reason and the server/client mismatch — reasons only.
// ---------------------------------------------------------------------------

const counters = { blocked: new Map<string, number>(), mismatch: new Map<string, number>() };
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

export function recordDoorBlocked(reason: string): void { bump(counters.blocked, reason); }
/** The screen rendered one door and the server answered another (a stale version, a refused hand-over). */
export function recordDoorMismatch(kind: string): void { bump(counters.mismatch, kind); }
export function doorCounters(): { blocked: Record<string, number>; mismatch: Record<string, number> } {
  return { blocked: Object.fromEntries(counters.blocked), mismatch: Object.fromEntries(counters.mismatch) };
}
export function resetDoorCountersForTests(): void { counters.blocked.clear(); counters.mismatch.clear(); }

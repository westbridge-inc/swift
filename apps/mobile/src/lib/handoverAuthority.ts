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

export interface HandoverAuthority {
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
  if (typeof h['permitted'] !== 'string' || !PERMISSIONS.has(h['permitted'])) return null;
  if (typeof h['version'] !== 'string' || !h['version']) return null;
  if (h['rail'] !== 'CASH' && h['rail'] !== 'MOBILE_MONEY' && h['rail'] !== 'OTHER') return null;
  return {
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
  // No authority on the payload (an older server): derive, and never say "paid" for a state that is not captured.
  const method = job?.paymentMethod ?? null;
  const state = job?.paymentStatus ?? 'UNKNOWN';
  if (state === 'CAPTURED' || state === 'CLAIMED') return { kind: 'no-cash', version: null, source: 'derived' }; // CLAIMED = the store's own word on its own wallet (DOC-1 §31.5)
  if (method === 'CASH') return { kind: 'collect-cash', version: null, source: 'derived' };
  return { kind: 'blocked', reason: `${method ?? 'UNKNOWN_RAIL'}_${state}`, version: null, source: 'derived' };
}

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

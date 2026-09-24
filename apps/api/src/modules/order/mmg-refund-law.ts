import { Prisma } from '@prisma/client';
import type { MmgRefundKind, MmgRefundStatus } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// [E02 · refund rail 1/8] THE MMG REFUND LAW.
//
// A paid MMG order's money sits in the STORE's wallet. Swift never holds it
// (spec §3.1:5250) and cannot send it back. So when a paid MMG order is
// cancelled, or a line comes off it, what Swift can do is RECORD what the store
// now owes the customer, give that a deadline, take the MMG reference of the
// refund the store says it sent, and ask the customer whether it arrived. The
// owner decided that rail on 09-24 (~/swift-coordination/MMG-REFUND-RAIL-PLAN-
// 20260924.md). This file is its law: which moves an obligation may make, how
// the money adds up, and how long a store has. It is pure apart from the policy
// read at the bottom, and nothing calls it yet: the locked commands that apply
// it arrive with refund rail 2 and 3.
//
// THE STATES are classified once, in a Record keyed by the Prisma enum, so a
// new state fails the build until someone classifies it (the order-status.ts
// pattern). THE EDGES are a Record of Records: every (state, event) pair has an
// answer, and `null` is the answer "refused".
//
//   OWED      → SENT       the store's "Refund sent", covering every OWED obligation on the order
//   OWED      → OWED       the deadline passed: `missedAt` is set once and the obligation stays owed
//   SENT      → CONFIRMED  the customer says the money arrived
//   SENT      → DISPUTED   the customer says it did not (a PAYMENT ticket opens beside it)
//   DISPUTED  → SETTLED    support finds it arrived
//   DISPUTED  → OWED       support finds it did not: a new deadline, and that send's reference stays spent
//   OWED, SENT, DISPUTED → VOIDED   support voids it (C4, two people)
//
// THE MONEY is Prisma.Decimal end to end, never Number(). The database holds the
// same two rules the helpers state (migration 20260925000100_mmg_refund_rail):
// the non-void obligations of an order never add up to more than what the store
// attested it received, and a paid MMG order never becomes CANCELLED or
// REFUNDED without a CANCELLATION obligation. The MMG fee a send records is
// Swift's to pay back (owner decision (d)) and never enters this arithmetic.
// ---------------------------------------------------------------------------

// ─── The states ─────────────────────────────────────────────────────────────

interface StatusClass {
  /** Somebody still has a move to make: the store, the customer or support. */
  open: boolean;
  /** A send covers it. The migration's chk_mmg_refund_obligations_send_shape
   *  holds `sendId` to exactly these states. */
  carriesSend: boolean;
  /** Counted against the attested cap: every state but VOIDED, as the cap
   *  trigger counts. */
  countsTowardCap: boolean;
  /** The customer or support said the money arrived. Only these may ever be
   *  shown as "refunded" (AF.4 #16, AH:39472). */
  refundEvidenced: boolean;
}

/**
 * Every obligation state, classified. Adding a value to `MmgRefundStatus`
 * makes this object fail to type-check until the new state is classified.
 */
const STATUS_LAW: Record<MmgRefundStatus, StatusClass> = {
  OWED: { open: true, carriesSend: false, countsTowardCap: true, refundEvidenced: false },
  SENT: { open: true, carriesSend: true, countsTowardCap: true, refundEvidenced: false },
  CONFIRMED: { open: false, carriesSend: true, countsTowardCap: true, refundEvidenced: true },
  DISPUTED: { open: true, carriesSend: true, countsTowardCap: true, refundEvidenced: false },
  SETTLED: { open: false, carriesSend: true, countsTowardCap: true, refundEvidenced: true },
  VOIDED: { open: false, carriesSend: false, countsTowardCap: false, refundEvidenced: false },
};

export const MMG_REFUND_STATUSES = Object.keys(STATUS_LAW) as MmgRefundStatus[];
const statusesWhere = (test: (c: StatusClass) => boolean) => MMG_REFUND_STATUSES.filter((s) => test(STATUS_LAW[s]));

/** States somebody still has to act on. The rest are final. */
export const MMG_REFUND_OPEN_STATUSES: readonly MmgRefundStatus[] = statusesWhere((c) => c.open);
/** States a send covers: the list the migration's CHECK names. */
export const MMG_REFUND_SEND_STATUSES: readonly MmgRefundStatus[] = statusesWhere((c) => c.carriesSend);
/** States counted against the attested cap. */
export const MMG_REFUND_CAPPED_STATUSES: readonly MmgRefundStatus[] = statusesWhere((c) => c.countsTowardCap);
/** The only states any surface may call "refunded". */
export const MMG_REFUND_EVIDENCED_STATUSES: readonly MmgRefundStatus[] = statusesWhere((c) => c.refundEvidenced);

export function isMmgRefundEvidenced(status: MmgRefundStatus): boolean {
  return STATUS_LAW[status].refundEvidenced;
}

// ─── The edges ──────────────────────────────────────────────────────────────

export type MmgRefundEvent =
  /** The store's "Refund sent", covering every OWED obligation on the order. */
  | 'SEND'
  /** The deadline sweeper found `dueAt` behind it. */
  | 'DEADLINE_PASSED'
  /** The customer's answer to a send. */
  | 'CUSTOMER_RECEIVED'
  | 'CUSTOMER_NOT_RECEIVED'
  /** Support's finding on a disputed send (C3). */
  | 'SUPPORT_RECEIVED'
  | 'SUPPORT_NOT_RECEIVED'
  /** Support voids the obligation (C4, two people). */
  | 'VOID';

const REFUSED = null;

/** Every (state, event) pair, answered. `null` = refused. */
const EDGES: Record<MmgRefundStatus, Record<MmgRefundEvent, MmgRefundStatus | null>> = {
  OWED: {
    SEND: 'SENT', DEADLINE_PASSED: 'OWED',
    CUSTOMER_RECEIVED: REFUSED, CUSTOMER_NOT_RECEIVED: REFUSED,
    SUPPORT_RECEIVED: REFUSED, SUPPORT_NOT_RECEIVED: REFUSED,
    VOID: 'VOIDED',
  },
  SENT: {
    SEND: REFUSED, DEADLINE_PASSED: REFUSED,
    CUSTOMER_RECEIVED: 'CONFIRMED', CUSTOMER_NOT_RECEIVED: 'DISPUTED',
    SUPPORT_RECEIVED: REFUSED, SUPPORT_NOT_RECEIVED: REFUSED,
    VOID: 'VOIDED',
  },
  CONFIRMED: {
    SEND: REFUSED, DEADLINE_PASSED: REFUSED,
    CUSTOMER_RECEIVED: REFUSED, CUSTOMER_NOT_RECEIVED: REFUSED,
    SUPPORT_RECEIVED: REFUSED, SUPPORT_NOT_RECEIVED: REFUSED,
    VOID: REFUSED,
  },
  DISPUTED: {
    SEND: REFUSED, DEADLINE_PASSED: REFUSED,
    CUSTOMER_RECEIVED: REFUSED, CUSTOMER_NOT_RECEIVED: REFUSED,
    SUPPORT_RECEIVED: 'SETTLED', SUPPORT_NOT_RECEIVED: 'OWED',
    VOID: 'VOIDED',
  },
  SETTLED: {
    SEND: REFUSED, DEADLINE_PASSED: REFUSED,
    CUSTOMER_RECEIVED: REFUSED, CUSTOMER_NOT_RECEIVED: REFUSED,
    SUPPORT_RECEIVED: REFUSED, SUPPORT_NOT_RECEIVED: REFUSED,
    VOID: REFUSED,
  },
  VOIDED: {
    SEND: REFUSED, DEADLINE_PASSED: REFUSED,
    CUSTOMER_RECEIVED: REFUSED, CUSTOMER_NOT_RECEIVED: REFUSED,
    SUPPORT_RECEIVED: REFUSED, SUPPORT_NOT_RECEIVED: REFUSED,
    VOID: REFUSED,
  },
};

export const MMG_REFUND_EVENTS = Object.keys(EDGES.OWED) as MmgRefundEvent[];

/** Where `event` takes an obligation in `from`, or null when it is refused. */
export function mmgRefundEdge(from: MmgRefundStatus, event: MmgRefundEvent): MmgRefundStatus | null {
  return EDGES[from][event];
}

const STATUS_WORDS: Record<MmgRefundStatus, string> = {
  OWED: 'still owed by the store',
  SENT: 'marked sent and waiting for the customer',
  CONFIRMED: 'confirmed received by the customer',
  DISPUTED: 'disputed and with Swift support',
  SETTLED: 'settled by Swift support',
  VOIDED: 'voided by Swift support',
};

const EVENT_WORDS: Record<MmgRefundEvent, string> = {
  SEND: 'marked sent',
  DEADLINE_PASSED: 'marked late',
  CUSTOMER_RECEIVED: 'confirmed',
  CUSTOMER_NOT_RECEIVED: 'disputed',
  SUPPORT_RECEIVED: 'settled',
  SUPPORT_NOT_RECEIVED: 'reopened',
  VOID: 'voided',
};

// ─── Decisions (pure) ───────────────────────────────────────────────────────

/** An obligation's facts, as read under its order's row lock. */
export interface MmgRefundObligationFacts {
  id: string;
  status: MmgRefundStatus;
  amount: Prisma.Decimal;
  deadlineHours: number;
  dueAt: Date;
  missedAt: Date | null;
  sendId: string | null;
  revision: number;
}

export type MmgRefundCommand =
  | { event: 'SEND'; sendId: string }
  | { event: 'DEADLINE_PASSED' }
  | { event: 'CUSTOMER_RECEIVED'; actorId: string }
  | { event: 'CUSTOMER_NOT_RECEIVED'; actorId: string }
  | { event: 'SUPPORT_RECEIVED'; actorId: string; note: string }
  /** `countAsMiss` defaults to true: a "Refund sent" support finds false is a
   *  missed deadline (coordinator ruling 3). */
  | { event: 'SUPPORT_NOT_RECEIVED'; actorId: string; note: string; policy: MmgRefundPolicy; countAsMiss?: boolean }
  | { event: 'VOID'; actorId: string; note: string };

export type MmgRefundDecision =
  | { kind: 'UNCHANGED' }
  | {
    kind: 'MOVE';
    from: MmgRefundStatus;
    to: MmgRefundStatus;
    /** The generation the caller's compare-and-set must still find. */
    expectedRevision: number;
    data: Prisma.MmgRefundObligationUncheckedUpdateManyInput;
  };

/**
 * One obligation's next state, decided on the LOCKED row. Every move advances
 * `revision`. A refused move throws 409 MMG_REFUND_TRANSITION_REFUSED; the one
 * exception is the deadline, which is the sweeper's question rather than a
 * person's command: a state the clock does not run on, a deadline not yet
 * reached and a miss already recorded all answer UNCHANGED.
 */
export function decideMmgRefundObligation(o: MmgRefundObligationFacts, command: MmgRefundCommand, now: Date): MmgRefundDecision {
  const to = EDGES[o.status][command.event];
  if (command.event === 'DEADLINE_PASSED') {
    if (to === null || o.missedAt !== null || now.getTime() < o.dueAt.getTime()) return { kind: 'UNCHANGED' };
    return move(o, to, { missedAt: now });
  }
  if (to === null) {
    throw new AppError(
      409,
      'MMG_REFUND_TRANSITION_REFUSED',
      `This MMG refund is ${STATUS_WORDS[o.status]}, so it cannot be ${EVENT_WORDS[command.event]}. Refresh to see where it stands.`,
      { status: o.status, event: command.event, revision: o.revision },
    );
  }
  switch (command.event) {
    case 'SEND':
      return move(o, to, { sendId: command.sendId });
    case 'CUSTOMER_RECEIVED':
      return move(o, to, { resolvedAt: now, resolvedById: command.actorId });
    case 'CUSTOMER_NOT_RECEIVED':
      return move(o, to, {});
    case 'SUPPORT_RECEIVED':
      return move(o, to, { resolvedAt: now, resolvedById: command.actorId, resolutionNote: command.note });
    case 'SUPPORT_NOT_RECEIVED': {
      // The send is spent (its reference stays unique in mmg_refund_sends); the
      // obligation is owed again, on a deadline from TODAY's policy.
      const deadline = mmgRefundDeadline(command.policy, now);
      const missed = (command.countAsMiss ?? true) ? (o.missedAt ?? now) : o.missedAt;
      return move(o, to, {
        sendId: null,
        deadlineHours: deadline.deadlineHours,
        dueAt: deadline.dueAt,
        missedAt: missed,
        resolutionNote: command.note,
      });
    }
    case 'VOID':
      // VOIDED carries no send (the CHECK); the send keeps the history in coveredObligationIds.
      return move(o, to, { sendId: null, resolvedAt: now, resolvedById: command.actorId, resolutionNote: command.note });
    default: {
      const unreachable: never = command;
      throw new Error(`decideMmgRefundObligation: unhandled command ${JSON.stringify(unreachable)}`);
    }
  }
}

function move(
  o: MmgRefundObligationFacts,
  to: MmgRefundStatus,
  data: Prisma.MmgRefundObligationUncheckedUpdateManyInput,
): MmgRefundDecision {
  return { kind: 'MOVE', from: o.status, to, expectedRevision: o.revision, data: { ...data, status: to, revision: o.revision + 1 } };
}

// ─── Opening an obligation ──────────────────────────────────────────────────

/**
 * One obligation per CAUSE, ever: the key is unique in the table. The two ways
 * a line comes off an order (staff remove it, the customer rejects its
 * substitute) are one cause, so a race between them can never mint two
 * obligations for one line. A cheaper substitute is a different cause: the
 * line stays, only the difference is owed.
 */
const CAUSE_KEY: Record<MmgRefundKind, (subjectId: string) => string> = {
  CANCELLATION: (orderId) => `order:${orderId}:cancel`,
  LINE_REMOVED: (orderItemId) => `line:${orderItemId}:close`,
  SUBSTITUTE_REJECTED: (orderItemId) => `line:${orderItemId}:close`,
  SUBSTITUTE_CHEAPER: (orderItemId) => `line:${orderItemId}:cheaper`,
};

/** The cause key of an obligation: the order for a cancellation, the line for the rest. */
export function mmgRefundCauseKey(kind: MmgRefundKind, subjectId: string): string {
  if (!subjectId) throw new Error(`mmgRefundCauseKey: ${kind} needs the id of what caused it`);
  return CAUSE_KEY[kind](subjectId);
}

export interface OpenMmgRefundInput {
  kind: MmgRefundKind;
  tenantId: string;
  orderId: string;
  vendorId: string;
  customerId: string;
  /** Required for every kind but CANCELLATION. */
  orderItemId?: string | null;
  amount: Prisma.Decimal;
  currencyCode: string;
  basis: string;
  reason?: string | null;
  /** null = the system. */
  createdById: string | null;
}

/**
 * A new OWED obligation. The deadline is the policy's AT THIS MOMENT, copied
 * onto the row: a later change to the policy never moves the deadline of an
 * obligation that already exists.
 */
export function openMmgRefundObligation(
  input: OpenMmgRefundInput,
  policy: MmgRefundPolicy,
  now: Date,
): Prisma.MmgRefundObligationUncheckedCreateInput {
  const subject = input.kind === 'CANCELLATION' ? input.orderId : input.orderItemId;
  if (!subject) {
    throw new AppError(400, 'MMG_REFUND_LINE_REQUIRED', 'A refund for a line change must name the line it is for.', { kind: input.kind });
  }
  const amount = assertMmgRefundAmount(input.amount);
  const deadline = mmgRefundDeadline(policy, now);
  return {
    tenantId: input.tenantId,
    orderId: input.orderId,
    vendorId: input.vendorId,
    customerId: input.customerId,
    orderItemId: input.kind === 'CANCELLATION' ? null : subject,
    kind: input.kind,
    causeKey: mmgRefundCauseKey(input.kind, subject),
    status: 'OWED',
    amount,
    currencyCode: input.currencyCode,
    basis: input.basis,
    reason: input.reason ?? null,
    deadlineHours: deadline.deadlineHours,
    dueAt: deadline.dueAt,
    createdById: input.createdById,
    revision: 0,
  };
}

// ─── The money (Prisma.Decimal only) ────────────────────────────────────────

const ZERO = new Prisma.Decimal(0);
/** The largest amount a Decimal(12,2) column holds. */
const COLUMN_MAX = new Prisma.Decimal('9999999999.99');

type Owing = { status: MmgRefundStatus; amount: Prisma.Decimal };

/**
 * An amount this rail can record: a Decimal above zero, with at most two
 * decimal places, that fits the column. Returned unchanged.
 */
export function assertMmgRefundAmount(amount: Prisma.Decimal): Prisma.Decimal {
  if (
    !Prisma.Decimal.isDecimal(amount)
    || !amount.isFinite()
    || amount.lte(ZERO)
    || amount.decimalPlaces() > 2
    || amount.gt(COLUMN_MAX)
  ) {
    throw new AppError(400, 'MMG_REFUND_AMOUNT_INVALID', 'An MMG refund is an amount above zero, to the cent.');
  }
  return amount;
}

function sumWhere(obligations: readonly Owing[], counts: (s: MmgRefundStatus) => boolean): Prisma.Decimal {
  return obligations.reduce((sum, o) => (counts(o.status) ? sum.plus(o.amount) : sum), ZERO);
}

/** Everything held against the attested cap: every obligation but the voided. */
export function mmgRefundCapped(obligations: readonly Owing[]): Prisma.Decimal {
  return sumWhere(obligations, (s) => STATUS_LAW[s].countsTowardCap);
}

/** What the store still owes and has not said it sent: the exact figure a send must state. */
export function mmgRefundOwed(obligations: readonly Owing[]): Prisma.Decimal {
  return sumWhere(obligations, (s) => s === 'OWED');
}

/**
 * What is left of the attested amount once every obligation already held
 * against it is taken off: the amount a cancellation owes. Nothing attested,
 * nothing left.
 */
export function mmgRefundRemainder(attested: Prisma.Decimal | null, obligations: readonly Owing[]): Prisma.Decimal {
  if (attested === null) return ZERO;
  const left = attested.minus(mmgRefundCapped(obligations));
  return left.gt(ZERO) ? left : ZERO;
}

/**
 * The cap, as the application states it before the database does: a new
 * obligation of `amount` must fit inside what the store attested, beside
 * everything already held against it.
 */
export function assertWithinAttested(attested: Prisma.Decimal | null, obligations: readonly Owing[], amount: Prisma.Decimal): void {
  if (attested === null) {
    throw new AppError(409, 'MMG_PAYMENT_NOT_ATTESTED', 'The store never confirmed receiving an MMG payment for this order, so there is nothing to refund by MMG.');
  }
  const total = mmgRefundCapped(obligations).plus(amount);
  if (total.gt(attested)) {
    throw new AppError(
      409,
      'MMG_REFUND_OVER_ATTESTED',
      'That would refund more than the customer paid by MMG for this order.',
      { attested: attested.toFixed(2), alreadyOwed: mmgRefundCapped(obligations).toFixed(2), requested: amount.toFixed(2) },
    );
  }
}

/** A send states exactly the owed total it covers, to the cent. */
export function sendMatchesOwed(stated: Prisma.Decimal, obligations: readonly Owing[]): boolean {
  const owed = mmgRefundOwed(obligations);
  return owed.gt(ZERO) && stated.equals(owed);
}

export type MmgSubstituteRefund =
  | { kind: 'SAME_PRICE' }
  | { kind: 'CHEAPER'; refund: Prisma.Decimal }
  /** A dearer substitute stays refused: there is no rail to collect the extra (ALG-52). */
  | { kind: 'DEARER'; extra: Prisma.Decimal };

/** What a substitute changes on a paid MMG line, taking both line totals as they stand. */
export function mmgSubstituteRefund(originalLineTotal: Prisma.Decimal, substituteLineTotal: Prisma.Decimal): MmgSubstituteRefund {
  if (substituteLineTotal.equals(originalLineTotal)) return { kind: 'SAME_PRICE' };
  if (substituteLineTotal.lt(originalLineTotal)) return { kind: 'CHEAPER', refund: originalLineTotal.minus(substituteLineTotal) };
  return { kind: 'DEARER', extra: substituteLineTotal.minus(originalLineTotal) };
}

// ─── Misses (owner decision (c)) ────────────────────────────────────────────

/**
 * Missed deadlines are counted per ORDER (coordinator ruling 3), from the
 * obligations themselves, never from a stored counter: the distinct orders
 * with an obligation missed after the store's last clear.
 */
export function mmgRefundMissedOrders(
  obligations: ReadonlyArray<{ orderId: string; missedAt: Date | null }>,
  clearedAt: Date | null,
): number {
  const orders = new Set<string>();
  for (const o of obligations) {
    if (o.missedAt === null) continue;
    if (clearedAt !== null && o.missedAt.getTime() <= clearedAt.getTime()) continue;
    orders.add(o.orderId);
  }
  return orders.size;
}

/** The store's MMG checkout pauses once its missed orders reach the limit. */
export function mmgRefundMissLimitReached(missedOrders: number, policy: MmgRefundPolicy): boolean {
  return missedOrders >= policy.missLimit;
}

// ─── The policy ─────────────────────────────────────────────────────────────

/** The PlatformConfig keys an operator edits. */
export const MMG_REFUND_DEADLINE_HOURS_KEY = 'mmg_refund_deadline_hours';
export const MMG_REFUND_MISS_LIMIT_KEY = 'mmg_refund_miss_limit';

/** Owner decision (b), as the coordinator ruled it: 72 hours, clamped 24 to 168. */
export const MMG_REFUND_DEADLINE_HOURS = { fallback: 72, min: 24, max: 168 } as const;
/** Owner decision (c): 2 missed deadlines, clamped 1 to 5. */
export const MMG_REFUND_MISS_LIMIT = { fallback: 2, min: 1, max: 5 } as const;

export interface MmgRefundPolicy {
  deadlineHours: number;
  missLimit: number;
}

type Dial = { fallback: number; min: number; max: number };

/** A config value as a whole number, or null. A PlatformConfig value is JSON:
 *  a bare number or a digits-only string reads; nothing else is coerced
 *  (`Number(null)` is 0, and a zero nobody typed is not a policy). */
function wholeNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^\s*-?\d{1,6}\s*$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function readDial(rows: ReadonlyArray<{ key: string; value: unknown }>, key: string, dial: Dial, notes: string[]): number {
  const row = rows.find((r) => r.key === key);
  if (!row) return dial.fallback;
  const value = wholeNumber(row.value);
  if (value === null) {
    notes.push(`${key} is not a whole number; using ${dial.fallback}`);
    return dial.fallback;
  }
  // Clamped, not discarded: an operator who asks for more than the ceiling
  // gets the ceiling, never the default in the other direction.
  const clamped = Math.min(dial.max, Math.max(dial.min, value));
  if (clamped !== value) notes.push(`${key}=${value} is outside ${dial.min}-${dial.max}; clamped to ${clamped}`);
  return clamped;
}

/** The policy the config rows state. Pure: the clamps and the fallbacks, with a note for each. */
export function resolveMmgRefundPolicy(rows: ReadonlyArray<{ key: string; value: unknown }>): { policy: MmgRefundPolicy; notes: string[] } {
  const notes: string[] = [];
  return {
    policy: {
      deadlineHours: readDial(rows, MMG_REFUND_DEADLINE_HOURS_KEY, MMG_REFUND_DEADLINE_HOURS, notes),
      missLimit: readDial(rows, MMG_REFUND_MISS_LIMIT_KEY, MMG_REFUND_MISS_LIMIT, notes),
    },
    notes,
  };
}

/**
 * The deadline and miss limit in force: PlatformConfig, else the owner's
 * defaults. Like `vendorResponseSlaMinutes` (order/response-sla.ts) it FAILS
 * SAFE: a missing, malformed or unreadable config falls back to the defaults
 * rather than leaving an obligation with no deadline, and each fallback or
 * clamp is logged.
 */
export async function mmgRefundPolicy(prisma: { platformConfig: Pick<Prisma.TransactionClient['platformConfig'], 'findMany'> }): Promise<MmgRefundPolicy> {
  try {
    const rows = await prisma.platformConfig.findMany({
      where: { key: { in: [MMG_REFUND_DEADLINE_HOURS_KEY, MMG_REFUND_MISS_LIMIT_KEY] } },
      select: { key: true, value: true },
    });
    const { policy, notes } = resolveMmgRefundPolicy(rows);
    if (notes.length > 0) log().warn({ notes }, 'MMG refund policy config adjusted');
    return policy;
  } catch (err) {
    log().warn({ err }, 'MMG refund policy config read failed; using the defaults');
    return { deadlineHours: MMG_REFUND_DEADLINE_HOURS.fallback, missLimit: MMG_REFUND_MISS_LIMIT.fallback };
  }
}

/** The deadline a new (or reopened) obligation carries: the policy's hours from `now`. */
export function mmgRefundDeadline(policy: MmgRefundPolicy, now: Date): { deadlineHours: number; dueAt: Date } {
  return { deadlineHours: policy.deadlineHours, dueAt: new Date(now.getTime() + policy.deadlineHours * 3_600_000) };
}

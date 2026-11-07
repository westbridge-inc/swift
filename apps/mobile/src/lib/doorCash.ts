import { parseHandoverAuthority } from './handoverAuthority';

// ---------------------------------------------------------------------------
// [L02 · row 56] THE CASH AT THE DOOR, AS THE RIDER STATES IT (build 12).
//
// The server decides what a statement means (api cash/door-cash.ts, #1542):
// the amount due is the order's own total, an amount over it is refused, a
// short amount with the goods still in hand is refused ("customer can't pay
// in full" sends the order back to the store), and a short amount the rider
// says they already handed over is recorded short and held for operations.
//
// This file only (1) reads what the rider typed, (2) builds the exact body
// fields the handover route expects, and (3) reads back what the SERVER said
// it recorded. It never subtracts, compares or rounds money the server owns:
// a shortfall, a "paid in full" or a held amount shown to the rider is the
// server's figure, never one computed here.
// ---------------------------------------------------------------------------

/** The handover route's ceiling for a whole-unit amount (api utils/money-schema MONEY_MAX_WHOLE). */
export const CASH_ENTRY_MAX = 99_999_999;

/**
 * Whole Guyana dollars typed by the rider. Digits only, with spaces or commas
 * between groups ("2,500" / "2 500"). Anything else is refused rather than
 * guessed: no decimals (GYD is whole), no sign, nothing above the route's
 * ceiling. Empty = not stated yet.
 */
export function parseCashEntry(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}(?:[ ,]?\d{3})*$|^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed.replace(/[ ,]/g, ''));
  return Number.isSafeInteger(value) && value <= CASH_ENTRY_MAX ? value : null;
}

/** What the rider tells the server happened at the door. */
export type DoorCashStatement =
  /** The customer paid; the rider took `collected` and hands the goods over. */
  | { kind: 'paid'; collected: number }
  /** The rider already handed the goods over for `collected` (owner ruling 5 Oct: recorded short, held). */
  | { kind: 'handed-over-short'; collected: number }
  /** The customer can't pay in full: no hand-over, the order goes back to the store (5 Oct).
   *  Partial cash taken is handed back first (7 Oct): `cashReturned` answers whether it was. */
  | { kind: 'cannot-pay'; collected: number; cashReturned: boolean | null };

export interface DoorCashFields {
  outcome: 'paid' | 'short_payment';
  collectedAmount: number;
  handedOverShort?: true;
  cashReturned?: boolean;
}

/** True when the statement still needs the "did you give it back?" answer. */
export function needsReturnAnswer(s: DoorCashStatement): boolean {
  return s.kind === 'cannot-pay' && s.collected > 0 && s.cashReturned === null;
}

/**
 * The handover body fields for a statement, exactly as the route reads them:
 * `cashReturned` travels only with partial cash on the can't-pay outcome (the
 * server refuses it anywhere else), `handedOverShort` only with a paid one.
 */
export function doorCashFields(s: DoorCashStatement): DoorCashFields {
  if (s.kind === 'paid') return { outcome: 'paid', collectedAmount: s.collected };
  if (s.kind === 'handed-over-short') return { outcome: 'paid', collectedAmount: s.collected, handedOverShort: true };
  if (s.collected === 0) return { outcome: 'short_payment', collectedAmount: 0 };
  if (s.cashReturned === null) throw new Error('Say whether the partial cash was handed back before recording it.');
  return { outcome: 'short_payment', collectedAmount: s.collected, cashReturned: s.cashReturned };
}

/** The amount due at this door, as the server states it (door authority first, then the order row). */
export function doorCashDue(job: { handover?: unknown; totalAmount?: unknown; currencyCode?: unknown } | null | undefined): { amount: number; currency: string } | null {
  const authority = parseHandoverAuthority(job?.handover);
  if (authority && authority.rail === 'CASH' && Number.isFinite(authority.amount)) {
    return { amount: authority.amount, currency: authority.currency };
  }
  const raw = job?.totalAmount;
  if ((typeof raw !== 'number' && typeof raw !== 'string') || (typeof raw === 'string' && raw.trim() === '')) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return null;
  return { amount, currency: typeof job?.currencyCode === 'string' ? job.currencyCode : 'GYD' };
}

/** What the server says it recorded. Every figure here is the server's. */
export type DoorCashRecord =
  | { kind: 'paid-in-full'; due: number; collected: number }
  | { kind: 'short-held'; due: number; collected: number; shortfall: number }
  | { kind: 'returned'; amount: number }
  | { kind: 'held'; amount: number }
  | { kind: 'resolved'; amount: number }
  /** Sent back to the store with no partial cash taken. */
  | { kind: 'returning' }
  /** Completed, but the answer carries no cash detail (a retry the server answered from what it already wrote). */
  | { kind: 'complete' };

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

function returnRecord(status: unknown, amountRaw: unknown): DoorCashRecord | null {
  const amount = num(amountRaw);
  if (amount === null) return null;
  if (status === 'RETURNED') return { kind: 'returned', amount };
  if (status === 'HELD') return { kind: 'held', amount };
  if (status === 'RESOLVED') return { kind: 'resolved', amount };
  return null;
}

/** The handover route's answer (`data` of POST /rider/orders/:id/handover), read back. */
interface HandoverAnswer {
  status?: unknown;
  cashReturn?: { amount?: unknown; status?: unknown } | null;
  cash?: { due?: unknown; collected?: unknown; shortfall?: unknown; heldForReview?: unknown } | null;
}

export function doorCashRecordFrom(res: unknown): DoorCashRecord | null {
  if (!res || typeof res !== 'object') return null;
  const r = res as HandoverAnswer;
  if (r.cashReturn && typeof r.cashReturn === 'object') {
    const rec = returnRecord(r.cashReturn.status, r.cashReturn.amount);
    if (rec) return rec;
  }
  const cash = r.cash;
  if (cash && typeof cash === 'object') {
    const due = num(cash.due);
    const collected = num(cash.collected);
    const shortfall = num(cash.shortfall);
    if (due !== null && collected !== null) {
      if (cash.heldForReview === true && shortfall !== null) return { kind: 'short-held', due, collected, shortfall };
      if (cash.heldForReview === false) return { kind: 'paid-in-full', due, collected };
    }
  }
  if (r.status === 'RETURNING') return { kind: 'returning' };
  if (r.status === 'DELIVERED') return { kind: 'complete' };
  return null;
}

/** The partial cash recorded on a job the server still lists (a goods order going back to the store). */
export function doorCashReturnOnJob(job: { doorCashReturnStatus?: unknown; doorCashReturnAmount?: unknown } | null | undefined): DoorCashRecord | null {
  return returnRecord(job?.doorCashReturnStatus, job?.doorCashReturnAmount);
}

/**
 * The words for a record. `held` = a person still has to act (operations
 * reviews a short hand-over, or follows up cash the rider still holds).
 * `fmt` is the app's one money formatter (lib/money), passed in.
 */
export function doorCashRecordCopy(rec: DoorCashRecord, fmt: (n: number) => string): { title: string; body: string; held: boolean } {
  switch (rec.kind) {
    case 'paid-in-full':
      return { title: 'Cash recorded', body: `${fmt(rec.collected)} collected of ${fmt(rec.due)} due. Delivery complete.`, held: false };
    case 'short-held':
      return {
        title: 'Recorded short — held for review',
        body: `Handed over for ${fmt(rec.collected)} of ${fmt(rec.due)} due (${fmt(rec.shortfall)} short). Swift deducted nothing; operations will review it.`,
        held: true,
      };
    case 'returned':
      return { title: 'Recorded: cash given back', body: `You gave the customer's ${fmt(rec.amount)} back at the door. Take the order back to the store.`, held: false };
    case 'held':
      return {
        title: 'Recorded: you still hold the cash',
        body: `You still hold ${fmt(rec.amount)} of the customer's cash. Operations will follow up with you to return it. Take the order back to the store.`,
        held: true,
      };
    case 'resolved':
      return { title: 'Settled by operations', body: `Operations recorded the customer's ${fmt(rec.amount)} as settled.`, held: false };
    case 'returning':
      return { title: 'Recorded: going back to the store', body: 'No cash was taken. Take the order back to the store.', held: false };
    case 'complete':
      return { title: 'Delivery complete', body: 'Swift had already recorded this hand-over.', held: false };
  }
}

/** Server refusals the popup answers in place (the server's own words, the rider's entry kept). */
export const CASH_STATEMENT_REFUSALS: ReadonlySet<string> = new Set([
  'CASH_OVER_DUE', 'CASH_SHORT_NO_HANDOVER', 'CASH_NOT_SHORT', 'CASH_AMOUNT_REQUIRED',
  'CASH_RETURN_CONFIRMATION_REQUIRED', 'CASH_OUTCOME_CONFLICT', 'CASH_RETURN_ALREADY_RECORDED',
  'CASH_ALREADY_RECORDED', 'ORDER_TOTAL_UNREADABLE', 'SHORT_PAYMENT_NOT_AVAILABLE',
  'CASH_AMOUNT_NOT_AVAILABLE', 'NOT_AT_DOOR',
]);

/** The door-code refusals: the code is fixed on the screen, not in the popup. */
export const DOOR_CODE_REFUSALS: ReadonlySet<string> = new Set(['MISSING_PIN', 'INVALID_PIN', 'MAX_ATTEMPTS']);

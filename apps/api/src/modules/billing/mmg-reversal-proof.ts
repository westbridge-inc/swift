import type { MmgLookupClient, MmgLookupDetail, MmgTxResult } from '../../providers/mmg/mmg-provider';

// ---------------------------------------------------------------------------
// [MMG REVERSAL · owner decision #11] What MMG's answers PROVE about a
// whole-payment reversal, and what Swift therefore records. Pure: the reversal
// service and the owner's UAT runner (scripts/mmg-reversal-uat.ts) use this
// one rule, so the UAT shows exactly what production would do.
// ---------------------------------------------------------------------------

/** A SENT reversal MMG has not proven within this long is held for a person. */
export const REVERSAL_PROOF_WINDOW_MS = 24 * 3_600_000;
/** A SENDING claim older than this lost its process: the sweep asks MMG's lookup. */
export const REVERSAL_SENDING_STALE_MS = 2 * 60_000;

export const amountMinorOf = (amount: { toString(): string } | number | string): number => Math.round(Number(amount.toString()) * 100);

export interface ProofSubject {
  readonly mmgTransactionId: string;
  /** The reversal transaction MMG's own answer named, when it named one. */
  readonly providerReference: string | null;
  readonly amount: { toString(): string } | number | string;
  readonly currencyCode: string;
}

export type ReversalProof =
  | { proven: true; how: 'ORIGINAL_REVERSED' | 'REVERSAL_COMPLETED' }
  /** `namedInFlight`: the reversal MMG's own answer named is still pending at
   *  MMG, or could not be read [review S3-2]. `namedKnownPayment`: MMG named a
   *  reference Swift has on record as a payment (never a return) [DS1124 S2]. */
  | { proven: false; standing: boolean; unreadable: boolean; namedInFlight?: boolean; namedKnownPayment?: boolean };

/** mmg_txn_canon in TypeScript: an MMG transaction id trimmed and upper-cased. */
const canon = (id: string): string => id.trim().toUpperCase();

/**
 * [review S2-2] The reversal transaction MMG's answer named, or null when it
 * named none or named the PAYMENT itself (its transaction id or its ledger
 * number, in any spelling): a lookup of the payment answers "successful" for
 * the same amount and would read as a completed reversal.
 */
export function namedReversalOf(row: ProofSubject, original: MmgLookupDetail): string | null {
  if (!row.providerReference) return null;
  const named = canon(row.providerReference);
  if (named === '' || named === canon(row.mmgTransactionId)) return null;
  if (original.outcome === 'found' && original.ledgerReference && named === canon(original.ledgerReference)) return null;
  return row.providerReference;
}

function matchesAmount(detail: Extract<MmgLookupDetail, { outcome: 'found' }>, row: ProofSubject): boolean {
  return detail.amountMinor !== null && detail.amountMinor === amountMinorOf(row.amount) && detail.currencyCode === row.currencyCode;
}

/**
 * MMG's lookup is the only proof. Proven when MMG reports the original
 * transaction REVERSED, or reports the reversal transaction its own answer
 * named as completed — either way for exactly this amount and currency.
 * `standing` = MMG reports the original still successful, for exactly the
 * amount; `unreadable` = MMG could not be asked or does not know it.
 */
export async function lookupProof(
  client: MmgLookupClient, row: ProofSubject,
  /** [DS1124 S2] Is this reference one Swift has on record as a payment (or another return's)? */
  isKnownPayment?: (reference: string) => Promise<boolean>,
): Promise<ReversalProof> {
  const original = await client.transactionLookupDetail(row.mmgTransactionId);
  if (original.outcome === 'found' && original.status === 'reversed' && matchesAmount(original, row)) {
    return { proven: true, how: 'ORIGINAL_REVERSED' };
  }
  let named = namedReversalOf(row, original);
  let namedKnownPayment = false;
  if (named && isKnownPayment && await isKnownPayment(named)) {
    // A payment is never a return: neither proof nor a return in flight.
    named = null;
    namedKnownPayment = true;
  }
  let namedInFlight = false;
  if (named) {
    const reversal = await client.transactionLookupDetail(named);
    if (reversal.outcome === 'found' && reversal.status === 'approved' && matchesAmount(reversal, row)) {
      return { proven: true, how: 'REVERSAL_COMPLETED' };
    }
    // [DS1124 S3] Only MMG still working on it (or not answering now) is "in flight"; a final
    // answer for another amount or currency is not a return of this payment.
    namedInFlight = reversal.outcome === 'error' || (reversal.outcome === 'found' && reversal.status === 'pending');
  }
  return {
    proven: false,
    standing: original.outcome === 'found' && original.status === 'approved' && matchesAmount(original, row),
    unreadable: original.outcome !== 'found',
    ...(namedInFlight ? { namedInFlight: true } : {}),
    ...(namedKnownPayment ? { namedKnownPayment: true } : {}),
  };
}

/** MMG said "already reversed" (a duplicate): an answer that contradicts a standing payment. */
export const saysDuplicate = (reason: string | null | undefined): boolean => /duplicate/i.test(reason ?? '');

export interface OpenReversal {
  readonly state: 'SENDING' | 'SENT' | 'HELD';
  /** MMG's answer to the reversal request: pending | reversed | declined | error, or null before one. */
  readonly providerStatus: string | null;
  readonly providerReason: string | null;
  readonly sentAt: Date;
}

export type SettleDecision =
  | { action: 'apply'; how: 'ORIGINAL_REVERSED' | 'REVERSAL_COMPLETED' }
  | { action: 'fail' }
  | { action: 'wait'; lookupStatus: string }
  | { action: 'hold'; heldReason: string; lookupStatus: string }
  | { action: 'leave' };

/**
 * THE rule, after MMG's lookup:
 *   proof                                   -> apply (debit once)
 *   MMG refused (not "already reversed")
 *     and the payment still stands          -> fail (nothing changed)
 *   MMG accepted, inside its window         -> wait
 *   a fresh claim still in its own request  -> leave (the sweep only holds a stale one)
 *   anything else                           -> hold for a person
 */
export function decideAfterLookup(proof: ReversalProof, row: OpenReversal, opts: { now: Date; afterAnswer: boolean }): SettleDecision {
  if (proof.proven) return { action: 'apply', how: proof.how };
  if (row.providerStatus === 'declined' && !saysDuplicate(row.providerReason) && proof.standing) return { action: 'fail' };
  const lookupStatus = proof.unreadable ? 'UNREADABLE' : proof.standing ? 'STANDING' : 'NOT_PROVEN';
  if (row.state === 'SENT' && row.providerStatus !== 'declined' && opts.now.getTime() - row.sentAt.getTime() < REVERSAL_PROOF_WINDOW_MS) {
    return { action: 'wait', lookupStatus };
  }
  if (row.state === 'SENDING' && !opts.afterAnswer && opts.now.getTime() - row.sentAt.getTime() < REVERSAL_SENDING_STALE_MS) {
    return { action: 'leave' };
  }
  const heldReason = row.providerStatus === null || row.providerStatus === 'error' ? 'NO_ANSWER_FROM_MMG'
    : saysDuplicate(row.providerReason) ? 'MMG_SAYS_ALREADY_REVERSED'
      : row.providerStatus === 'declined' ? 'MMG_REFUSED_LOOKUP_UNCLEAR'
        : 'NOT_PROVEN_IN_TIME';
  return { action: 'hold', heldReason, lookupStatus };
}

/** For the owner's UAT: what Swift would record right after MMG's answer and lookup. */
export function verdictOf(proof: ReversalProof, answer: MmgTxResult, now = new Date()): { state: string; detail: string | null } {
  const accepted = answer.status === 'pending' || answer.status === 'reversed' || answer.status === 'approved';
  const decision = decideAfterLookup(proof, {
    state: answer.status === 'error' ? 'SENDING' : 'SENT',
    providerStatus: answer.status,
    providerReason: answer.reason ?? null,
    sentAt: now,
  }, { now, afterAnswer: true });
  switch (decision.action) {
    case 'apply': return { state: 'REVERSED — the payment would be deducted from the partner\'s weekly fees once', detail: decision.how };
    case 'fail': return { state: 'FAILED — MMG refused and the payment still stands; nothing changes', detail: null };
    case 'wait': return { state: "SENT — waiting for MMG's lookup to show the return", detail: `${accepted ? 'MMG accepted' : 'MMG answered'}; lookup ${decision.lookupStatus}` };
    case 'hold': return { state: 'HELD — a person must look', detail: `${decision.heldReason}; lookup ${decision.lookupStatus}` };
    case 'leave': return { state: 'SENDING', detail: null };
    default: {
      const unhandled: never = decision;
      return unhandled;
    }
  }
}

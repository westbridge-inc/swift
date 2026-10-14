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
  | { proven: false; standing: boolean; unreadable: boolean };

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
export async function lookupProof(client: MmgLookupClient, row: ProofSubject): Promise<ReversalProof> {
  const original = await client.transactionLookupDetail(row.mmgTransactionId);
  if (original.outcome === 'found' && original.status === 'reversed' && matchesAmount(original, row)) {
    return { proven: true, how: 'ORIGINAL_REVERSED' };
  }
  if (row.providerReference && row.providerReference !== row.mmgTransactionId) {
    const reversal = await client.transactionLookupDetail(row.providerReference);
    if (reversal.outcome === 'found' && reversal.status === 'approved' && matchesAmount(reversal, row)) {
      return { proven: true, how: 'REVERSAL_COMPLETED' };
    }
  }
  return {
    proven: false,
    standing: original.outcome === 'found' && original.status === 'approved' && matchesAmount(original, row),
    unreadable: original.outcome !== 'found',
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
    case 'apply': return { state: 'REVERSED — the fee balance would be debited once', detail: decision.how };
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

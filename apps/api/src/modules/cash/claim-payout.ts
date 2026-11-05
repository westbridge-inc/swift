import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { getTenantId } from '../../plugins/tenant-context';
import { assertAmountAttested, isDuplicateOn, normaliseReference } from '../money/evidence';

// ---------------------------------------------------------------------------
// [A-11] CLOSING A CLAIM IS A REAL PAYOUT, AND IT NEEDS REAL EVIDENCE.
//
// A reimbursement claim is money Swift owes a mover for a delivery a customer
// refused or never answered for. Paying it happens on a MANUAL rail — a bank
// transfer or an MMG send — so the only proof that ever exists is the reference
// the payer types in afterwards.
//
// WR-004 already made that reference required, and the transition is already
// compare-and-set so two admins cannot pay the same claim twice. Two gaps
// remained:
//
//  1. THE REFERENCE WAS NOT UNIQUE. The same string could close ten claims.
//  2. NOTHING BOUND THE PAYMENT TO THE AMOUNT, so a GY$2,000 claim could be
//     closed by a GY$200 transfer and the record would look identical.
//
// The mechanics now live in modules/money/evidence.ts, so the next surface that
// closes a money obligation on a manual rail inherits them instead of learning
// them a third time. What stays here is what is specific to a CLAIM: its
// wording.
// ---------------------------------------------------------------------------

export function normaliseClaimPaymentRef(raw: unknown): string {
  return normaliseReference(raw, {
    required: 'Enter the bank or MMG reference for the transfer you sent — it is the only proof this payout happened.',
    invalid: 'That does not look like a transfer reference. Copy it from the bank or MMG receipt.',
  }, 'PAYMENT_REF');
}

/**
 * The payer states what they sent, and it must be the claim's own figure to the
 * cent. A claim cannot be closed for an amount nobody agreed to.
 */
export function assertClaimAmountAttested(claimAmount: unknown, attested: unknown): number {
  return assertAmountAttested(claimAmount, attested, {
    required: 'State the amount you actually transferred before marking this paid.',
    unreadable: 'This record has no readable amount and cannot be closed.',
    mismatch: (owed, sent) =>
      `This is for GY$${owed.toLocaleString()}, not GY$${sent.toLocaleString()}. Pay that amount, or reject it and raise a new one.`,
  }, 'PAID_AMOUNT');
}

/** A Prisma unique-constraint violation on the claim's reference, translated. */
export function isDuplicateReferenceError(err: unknown): boolean {
  return isDuplicateOn(err, 'paymentRef');
}

/**
 * One lock per case, held to the end of the transaction. The approval gate writes an ask to record a payment under it,
 * and a reject takes it before looking for that ask, so neither can commit around the other. On this rail the money
 * leaves before the record, so the ask is the first sign that it may have left. Same shape as the refund ask lock.
 */
export async function lockClaimPaymentAsks(tx: Prisma.TransactionClient, claimId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`claim-payment-ask:${claimId}`}, 0))`;
}

/** Run by the approval gate under that lock: an ask that could never be recorded is refused before it is written. */
export async function validateClaimPayAsk(tx: Prisma.TransactionClient, claimId: string): Promise<void> {
  const row = await tx.reimbursementClaim.findUnique({ where: { id: claimId }, select: { status: true, orderId: true } });
  if (!row || row.status === 'APPROVED') return;
  // Another operator's admin learns nothing here: the handler answers them, as it always has.
  const tenantId = getTenantId();
  if (tenantId) {
    const order = await tx.order.findUnique({ where: { id: row.orderId }, select: { tenantId: true } });
    if (order?.tenantId !== tenantId) return;
  }
  if (row.status === 'AUTO_APPROVED') throw new AppError(409, 'RLP_PERSON_MUST_DECIDE', 'Nobody has decided this one yet. A person must approve it before it is paid.');
  throw new AppError(400, 'INVALID_CLAIM_STATE', row.status === 'PENDING_REVIEW' ? 'A person must approve this before it is paid.' : 'This case is closed, so no payment can be recorded on it.');
}

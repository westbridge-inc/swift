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
    required: 'State the amount you actually transferred before marking this claim paid.',
    unreadable: 'This claim has no readable amount and cannot be closed.',
    mismatch: (owed, sent) =>
      `This claim is for GY$${owed.toLocaleString()}, not GY$${sent.toLocaleString()}. Pay the claim amount, or reject it and raise a new one.`,
  }, 'PAID_AMOUNT');
}

/** A Prisma unique-constraint violation on the claim's reference, translated. */
export function isDuplicateReferenceError(err: unknown): boolean {
  return isDuplicateOn(err, 'paymentRef');
}

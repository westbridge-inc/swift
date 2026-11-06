import { isProduction } from './runtime-mode';

// ---------------------------------------------------------------------------
// [OWNER 8 Oct 22:20 + 8 Oct 23:58 (4)] Production holds the agent rails — an
// agent payment (MMG agent cash, a Swift Number) and the admin top-up that
// names an MMG or bank transfer — with BILLING_TOPUP_HOLD=1.
//
// [OWNER 5 Nov 2026] A weekly fee may also be paid directly to Westbridge Inc.
// in person. That has its own narrow door (billing/in-person-payment.ts), which
// does not read this hold: this hold still keeps agent cash off, and it stays
// exactly 1 in production (boot-config.ts).
//
// The hold fails CLOSED in production: an unset BILLING_TOPUP_HOLD there is a
// hold, so a production host that forgot the line still cannot credit a fee by
// hand. Only an explicit BILLING_TOPUP_HOLD=0 opens it (the M-08 rollback,
// for a test server). Outside production an unset value stays open, as before.
// Any other value is a hold: a switch written wrongly still holds.
// ---------------------------------------------------------------------------

export function manualFeeCreditHeld(env: Record<string, string | undefined> = process.env): boolean {
  const value = env['BILLING_TOPUP_HOLD'];
  if (value !== undefined && value !== '') return value !== '0';
  // Unset: held in production. A posture the parser refuses is held too.
  try { return isProduction(env); } catch { return true; }
}

/** The words an operator sees when the hold refuses a credit by hand. */
export const MANUAL_FEE_CREDIT_HELD_MESSAGE =
  'This way of recording a fee payment is on hold by operations — nothing was recorded. Money paid directly to the company by cash, cheque or bank transfer is recorded with Record in-person payment. Refund a payment that came through an agent or a Swift Number.';

import { isProduction } from './runtime-mode';

// ---------------------------------------------------------------------------
// [OWNER 8 Oct 22:20 + 8 Oct 23:58 (4)] Weekly fees are paid ONLY through the
// MMG checkout page (card later). Production holds every way of crediting a
// fee by hand — an admin-recorded fee payment, an agent payment (MMG agent
// cash, a Swift Number) — with BILLING_TOPUP_HOLD=1.
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
  'Recording fee payments by hand is on hold by operations — nothing was recorded. Partners pay the weekly fee through the MMG checkout page; refund a payment that arrived another way.';

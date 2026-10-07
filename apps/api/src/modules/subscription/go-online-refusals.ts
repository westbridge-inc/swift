import { AppError } from '../../utils/errors';

/**
 * [NO-DEAD-ENDS · owner, 6 Oct] Why GO snapped back, and where to fix it.
 *
 * A rider or driver whose GO is refused sees the server's sentence under the
 * switch (the store build in review shows it verbatim). Several sentences
 * named a problem with no place to fix it, and one pointed at a door that
 * does not exist ("Top up": Swift has no wallet; the weekly fee is paid on
 * the MMG checkout page under Weekly fee). Each refusal now names the screen
 * that fixes it. Codes and statuses are unchanged, so every app branches as
 * before; newer apps also offer the screen as a button (by code).
 */
export type GoOnlineRefusal = 'DOCUMENTS' | 'FEE_GRACE_LAPSED' | 'FEE_INACTIVE';

const DOCUMENTS = 'Your documents must be verified before you can go online. Open Documents in your account to see which one needs attention.';
const GRACE = 'Your grace period has ended — pay this week’s fee to go back online. Open Weekly fee in your account to pay it.';
const UNPAID = 'Your weekly fee is unpaid, so you can’t go online. Open Weekly fee in your account to pay it.';
const NOT_ACTIVE = 'Your weekly fee isn’t active, so you can’t go online. Open Weekly fee in your account to pay it, or ask Swift support through Get Help if it should be active.';

/** The refusal for each GO gate, with the historical status and code of the route that throws it. */
export function goOnlineRefusal(kind: GoOnlineRefusal, route: 'RIDER' | 'DRIVER'): AppError {
  switch (kind) {
    case 'DOCUMENTS':
      return new AppError(403, 'VERIFICATION_REQUIRED', DOCUMENTS, { nextStep: 'OPEN_DOCUMENTS' });
    case 'FEE_GRACE_LAPSED':
      return new AppError(403, 'SUBSCRIPTION_PAST_DUE', GRACE, { nextStep: 'OPEN_WEEKLY_FEE' });
    case 'FEE_INACTIVE':
    default:
      // Each route keeps the status and code it has always answered.
      return route === 'RIDER'
        ? new AppError(403, 'SUBSCRIPTION_SUSPENDED', UNPAID, { nextStep: 'OPEN_WEEKLY_FEE' })
        : new AppError(400, 'SUBSCRIPTION_REQUIRED', NOT_ACTIVE, { nextStep: 'OPEN_WEEKLY_FEE' });
  }
}

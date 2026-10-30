import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { isProviderVerified } from './services.service';
import { assertProFeeAllowsNewWork } from './pro-fee';

// ---------------------------------------------------------------------------
// [BOOK-P2] CAN THIS PRO TAKE NEW WORK RIGHT NOW? — the one gate a booking from
// a pro's menu passes (the slot list and the booking itself).
//
// Today it is the live verification the quote flow already applies to new work
// (services.routes.ts quote and confirm; services.service.ts job request): the
// pro's account is ACTIVE and their whole document checklist is approved and
// unexpired (isProviderVerified).
//
// [BILL-PRO PR3] The pro weekly fee (owner 28 Oct 2026, GY$8,000 through the MMG
// checkout page; switch PRO_WEEKLY_FEE, off): the fee's one predicate
// (pro-fee.ts proFeeStanding, subscriptionOperability) is checked INSIDE this
// function, so every booking path that calls it is gated by the fee. Work already booked
// is never gated (a reschedule, a start, a completion, a cancel), the vendor
// IN_FLIGHT rule.
// ---------------------------------------------------------------------------

type OperateDb = Prisma.TransactionClient | PrismaClient;

export const PROVIDER_CANNOT_TAKE_BOOKINGS_CODE = 'PROVIDER_NOT_VERIFIED';
export const PROVIDER_CANNOT_TAKE_BOOKINGS_MESSAGE = 'This provider can’t take bookings right now. Choose another provider, or try again later.';

/** Refuses (409) unless the pro may take a new booking now. See the header: the weekly-fee
 *  check is BILL-PRO PR3's, added here. */
export async function assertProviderCanOperate(db: OperateDb, provider: { userId: string }): Promise<void> {
  if (!(await isProviderVerified(db, provider.userId))) {
    throw new AppError(409, PROVIDER_CANNOT_TAKE_BOOKINGS_CODE, PROVIDER_CANNOT_TAKE_BOOKINGS_MESSAGE);
  }
  // [BILL-PRO PR3] The pro weekly fee (PRO_WEEKLY_FEE on only): the agreement accepted and the fee operable.
  await assertProFeeAllowsNewWork(db, provider.userId, 'customer');
}

import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { proAgreementAccepted, proAgreementState } from '../legal/reaccept';
import { isProviderVerified } from './services.service';
import { latestProFeeTick, liveServicesStoreFee, PRO_FEE_NOT_DUE, tickIsFor, proWeeklyFeeEnabled, type ProFeeTick } from './pro-fee';

const notDue = (why: string) => new AppError(409, PRO_FEE_NOT_DUE, `The pro weekly fee is not due: ${why}.`);

/** The switch, read before the activation prices anything (off: PRO_FEE_NOT_DUE, nothing read or written). */
export function proFeeSwitchedOn(env: Record<string, string | undefined> = process.env): void {
  if (!proWeeklyFeeEnabled(env)) throw notDue('the pro weekly fee is switched off');
}

/**
 * [BILL-PRO PR3] Is a pro's weekly fee due to be born now? Read inside the activation transaction
 * (SubscriptionService.proActivation, under the identity lock). Refuses with PRO_FEE_NOT_DUE, writing nothing, when:
 * the switch is off; the pro's documents are not approved now (the live verification); the pro has not accepted the
 * Business Agreement that covers Providers (never charged without the tick, owner A1/A3) or not ticked "I understand
 * the weekly fee" as a pro AT THE AMOUNT THE FEE IS BORN AT (owner B3; REVIEW-G #2230 S3-1: `bornAt` is the exact
 * rate and currency the activation writes, so a tick given to an older rate never starts a fee at a newer one); or a
 * Services store fee of theirs is live (one fee, owner B1).
 */
export async function assertProFeeDue(db: PrismaClient | Prisma.TransactionClient, userId: string, bornAt: ProFeeTick, env: Record<string, string | undefined> = process.env): Promise<void> {
  proFeeSwitchedOn(env);
  if (!(await isProviderVerified(db, userId))) throw notDue('documents not approved');
  if (!proAgreementAccepted(await proAgreementState(db, userId))) throw notDue('agreement not accepted');
  if (!tickIsFor(await latestProFeeTick(db, userId), bornAt)) throw notDue('weekly fee not acknowledged at the amount it would start at');
  if (await liveServicesStoreFee(db, userId)) throw notDue('their Services store fee covers them');
}

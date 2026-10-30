import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { proAgreementAccepted, proAgreementState } from '../legal/reaccept';
import { isProviderVerified } from './services.service';
import { liveServicesStoreFee, PRO_FEE_NOT_DUE, proFeeAcknowledged, proWeeklyFeeEnabled } from './pro-fee';

/**
 * [BILL-PRO PR3] Is a pro's weekly fee due to be born now? Read inside the activation transaction
 * (SubscriptionService.proActivation, under the identity lock). Refuses with PRO_FEE_NOT_DUE, writing nothing, when:
 * the switch is off; the pro's documents are not approved now (the live verification); the pro has not accepted the
 * Business Agreement that covers Providers (never charged without the tick, owner A1/A3) or not ticked "I understand
 * the weekly fee" as a pro (owner B3); or a Services store fee of
 * theirs is live (one fee, owner B1).
 */
export async function assertProFeeDue(db: PrismaClient | Prisma.TransactionClient, userId: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  const notDue = (why: string) => new AppError(409, PRO_FEE_NOT_DUE, `The pro weekly fee is not due: ${why}.`);
  if (!proWeeklyFeeEnabled(env)) throw notDue('the pro weekly fee is switched off');
  if (!(await isProviderVerified(db, userId))) throw notDue('documents not approved');
  if (!proAgreementAccepted(await proAgreementState(db, userId))) throw notDue('agreement not accepted');
  if (!(await proFeeAcknowledged(db, userId))) throw notDue('weekly fee not acknowledged');
  if (await liveServicesStoreFee(db, userId)) throw notDue('their Services store fee covers them');
}

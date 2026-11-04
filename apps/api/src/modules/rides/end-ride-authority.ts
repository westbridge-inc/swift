import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { assertClearOfParties } from '../integrity/party-authority';

/** [BUG-HUNT-2 G01] Who may end a ride: the one rule in party-authority.ts, in a ride's words. */
export function assertMayEndRide(tx: Prisma.TransactionClient, actorId: string, parties: readonly string[]): Promise<void> {
  return assertClearOfParties(tx, actorId, parties, {
    own: new AppError(403, 'OWN_RIDE', 'You are on this ride. Someone else at Swift must end it.'),
    staff: new AppError(403, 'STAFF_ON_RIDE', 'A staff account is on this ride. Only a SUPER_ADMIN who is not on it can end it.'),
  });
}

import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { consoleRoleOf } from '../auth/console-role';
import { identityAuthority } from '../integrity/identity-review';

/**
 * [BUG-HUNT-2 G01] Who may end a ride. Nobody ends a ride they are on, through any account of theirs. A ride with a staff
 * account on either side goes to a SUPER_ADMIN who is not on it, so a colleague's ride is never out of everyone's reach.
 *
 * Call it inside the transition, on the people the locked row names. The roles are the database's at that moment, never
 * the session's: the guard ran earlier, and the house lock order is User then Order, so this reads the rows and locks none.
 */
export async function assertMayEndRide(tx: Prisma.TransactionClient, actorId: string, parties: readonly string[]): Promise<void> {
  for (const party of parties) {
    const { memberIds } = await identityAuthority(tx, party);
    if ([party, ...memberIds].includes(actorId)) throw new AppError(403, 'OWN_RIDE', 'You are on this ride. Someone else at Swift must end it.');
  }
  const people = await tx.user.findMany({ where: { id: { in: [actorId, ...parties] } }, select: { id: true, roles: true } });
  const consoleRole = (userId: string) => consoleRoleOf(people.find((person) => person.id === userId)?.roles);
  if (parties.some((party) => consoleRole(party) !== null) && consoleRole(actorId) !== 'SUPER_ADMIN') {
    throw new AppError(403, 'STAFF_ON_RIDE', 'A staff account is on this ride. Only a SUPER_ADMIN who is not on it can end it.');
  }
}

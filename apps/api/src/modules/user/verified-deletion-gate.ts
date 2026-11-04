import type { Prisma, PrismaClient, UserStatus } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { openCasesOf } from '../verification/abandoned-application';
import { identityReviewOpenFor } from '../verification/investigation-hold-core';

/**
 * [BUG-HUNT F20] What the staff door for a verified deletion refuses, and only it: a person's own deletion is unchanged
 * (a hold there is escrowed and the deletion goes on, AG-XF-013). Staff acting for someone are not that person, and this
 * door must not become a way out of an investigation or a ban. Any of these goes to the owner:
 *  - a banned account: measured, a closed account's number signs up again, identity tombstones on or off;
 *  - any open case, on any account, by the abandoned-application census, so the two lists cannot drift;
 *  - a suspension that came from enforcement or safety. An account carries no source for its suspension, so that is read
 *    from what such a suspension leaves: an enforcement action, or an incident that took an interim action.
 *
 * Runs in the erasure's own transaction, under its person lock, so a case raised at the same moment is either seen or
 * waits. The owner wall hides another person's rows from a request login, which would make this census see too little
 * and read as "no case": it reads bound as the person, then restores the caller.
 */
export async function refuseVerifiedDeletion(
  tx: Prisma.TransactionClient,
  person: { id: string; status: UserStatus; tenantId: string },
): Promise<void> {
  const goesToOwner = (code: string, why: string) => new AppError(409, code, `${why} Nothing was deleted. This one goes to the owner.`);
  if (person.status === 'BANNED') throw goesToOwner('BANNED_ACCOUNT', 'This account is banned, and closing it would let its number sign up again.');

  const [caller] = await tx.$queryRaw<Array<{ tenant: string | null; owner: string | null }>>`
    SELECT current_setting('app.current_tenant', true) AS tenant, current_setting('app.current_user', true) AS owner`;
  await tx.$executeRaw`SELECT set_config('app.current_tenant', ${person.tenantId}, true), set_config('app.current_user', ${person.id}, true)`;
  const open = (await openCasesOf(tx as unknown as PrismaClient, person.id)).length > 0 || await identityReviewOpenFor(tx, person.id);
  const marked = person.status === 'SUSPENDED' && (
    await tx.enforcementAction.count({ where: { accountId: person.id, level: { not: 'NONE' } } }) > 0
    || await tx.incidentCase.count({ where: { subjectUserId: person.id, interimAction: { not: 'NONE' } } }) > 0
  );
  await tx.$executeRaw`SELECT set_config('app.current_tenant', ${caller?.tenant ?? ''}, true), set_config('app.current_user', ${caller?.owner ?? ''}, true)`;

  if (open) throw goesToOwner('OPEN_CASE', 'This account has an open case.');
  if (marked) throw goesToOwner('SUSPENDED_BY_ENFORCEMENT', 'This account was suspended by enforcement or safety.');
}

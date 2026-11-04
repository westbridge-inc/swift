import type { Prisma, PrismaClient } from '@prisma/client';
import { assertNameNotReserved } from '../../lib/fixture-filter';
import { bindTenantTransaction } from '../../plugins/prisma';
import { AppError, NotFoundError } from '../../utils/errors';
import { refuseStaffAccount } from '../admin/admin-email-change';
import { NAME_CHECKED_DOC_TYPES } from '../verification/doc-registry';

/**
 * [BUG-HUNT F21 · COORD 4 Nov 2026] A verified driver could type another name and stay verified: passengers are told
 * "<first name> is heading to pick you up", the Review Center's name check compared the old name, and a store's seller
 * line prints the owner's name. GUARDRAILS s.8 rule 4: nothing is labelled verified unless a person checked it. Once a
 * person has approved a paper that carries the name, it changes only through a person (PUT /admin/users/:id/name).
 */
export const NAME_LOCKED_WORDS = 'A person at Swift checked your name against your documents, so it can’t be changed here. To change it, contact Swift support: a person checks the new name first.';

/**
 * Support's door, on the row read under the person's lock. A staff account is out of reach, and a closed account stays
 * closed: a name written over an erased one would undo the erasure. The number is read for the reserved-name rule and
 * stops here. `within` is the trail, in the same commit.
 */
export async function changeLegalName(
  prisma: PrismaClient, id: string, next: { firstName: string; lastName: string },
  within: (tx: Prisma.TransactionClient, changed: string[]) => Promise<void>,
): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    await bindTenantTransaction(tx);
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${id} FOR UPDATE`;
    const person = await tx.user.findUnique({ where: { id }, select: { firstName: true, lastName: true, phone: true, status: true, roles: true, activeRole: true } });
    if (!person) throw new NotFoundError('User', id);
    refuseStaffAccount(person);
    if (person.phone.startsWith('deleted:') || person.status === 'DEACTIVATED') {
      throw new AppError(409, 'ACCOUNT_CLOSED', 'This account has been closed. Its name cannot be changed.');
    }
    const changed = [...(next.firstName !== person.firstName ? ['firstName'] : []), ...(next.lastName !== person.lastName ? ['lastName'] : [])];
    if (changed.length === 0) throw new AppError(409, 'NOTHING_TO_CHANGE', 'That is already the name on this account.');
    assertNameNotReserved(next.firstName, person.phone, person.firstName);
    await tx.user.update({ where: { id }, data: next });
    await within(tx, changed);
    return changed;
  });
}

const sameName = (next: string | undefined, current: string | null) => next === undefined || next.trim() === (current ?? '').trim();

/** The apps send the name back on every save (an email edit, say): an unchanged name is never a change. */
export async function assertNameNotLocked(db: Pick<PrismaClient, 'user' | 'verificationDocument'>, userId: string, body: { firstName?: string; lastName?: string }): Promise<void> {
  if (body.firstName === undefined && body.lastName === undefined) return;
  const me = await db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
  if (!me || (sameName(body.firstName, me.firstName) && sameName(body.lastName, me.lastName))) return;
  const checked = await db.verificationDocument.findFirst({
    where: { userId, status: 'APPROVED', docType: { in: [...NAME_CHECKED_DOC_TYPES] } }, select: { id: true },
  });
  if (checked) throw new AppError(409, 'NAME_LOCKED', NAME_LOCKED_WORDS);
}

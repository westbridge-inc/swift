import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';

/**
 * [BUG-HUNT F21 · COORD 4 Nov 2026] A verified driver could type another name and stay verified: passengers are told
 * "<first name> is heading to pick you up", the Review Center's name check compared the old name, and a store's seller
 * line prints the owner's name. GUARDRAILS s.8 rule 4: nothing is labelled verified unless a person checked it. Once a
 * person has approved a paper that carries the name, it changes only through a person (PUT /admin/users/:id/name).
 */
export const NAME_CHECKED_DOC_TYPES: readonly string[] = ['national_id', 'owner_national_id', 'drivers_licence', 'hire_car_driver_licence', 'own_name_declaration'];

export const NAME_LOCKED_WORDS = 'A person at Swift checked your name against your documents, so it can’t be changed here. To change it, contact Swift support: a person checks the new name first.';

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

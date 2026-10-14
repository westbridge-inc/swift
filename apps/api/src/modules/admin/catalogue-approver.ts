/**
 * [GUARDRAILS §8 · Opus S3-9] THE CATALOGUE APPROVER GRANT — who may show an
 * item a banned word is holding.
 *
 * Approving a held item ("Rum cake", a "Beers & Wines" section) puts it in
 * front of customers. Selling banned goods is a criminal-liability matter, so
 * this is not something any moderator does: it needs an explicit grant that
 * `*` and the role defaults never imply — the same machinery as the document
 * reviewer grant (admin-authority EXPLICIT_ONLY_CAPABILITIES, #1525). A
 * SUPER_ADMIN grants or revokes it, to themselves too, with a recorded reason.
 * Removing an item (the strict direction) stays open to every moderator.
 */
import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { CATALOGUE_APPROVER_CAPABILITY } from './admin-authority';

export { CATALOGUE_APPROVER_CAPABILITY };

export const CATALOGUE_APPROVER_REQUIRED = 'CATALOGUE_APPROVER_REQUIRED';
/** What the console shows. Plain words, and it says what to do next. */
export const CATALOGUE_APPROVER_MESSAGE =
  'You need the catalogue-approver permission to show a held item. Ask a super-admin to grant it to you. You can still remove an item.';

export function catalogueApproverRequired(): AppError {
  return new AppError(403, CATALOGUE_APPROVER_REQUIRED, CATALOGUE_APPROVER_MESSAGE);
}

/** The grant is held only by its exact name — never by `*` or a wildcard. */
export function holdsCatalogueApproverGrant(permissions: readonly string[] | null | undefined): boolean {
  return Array.isArray(permissions) && permissions.includes(CATALOGUE_APPROVER_CAPABILITY);
}

/**
 * Grant or revoke, inside the caller's transaction, under a row lock on the
 * target's Admin row. Granting adds the entry beside whatever the list holds
 * (an explicit-only entry never narrows an actor — capabilitiesOf); revoking
 * removes exactly that entry. Revoking from no row changes nothing.
 */
export async function setCatalogueApproverGrant(
  tx: Prisma.TransactionClient,
  targetUserId: string,
  grant: boolean,
): Promise<{ userId: string; catalogueApprover: boolean; changed: boolean }> {
  await tx.$queryRaw`SELECT "id" FROM "admins" WHERE "userId" = ${targetUserId} FOR UPDATE`;
  const row = await tx.admin.findUnique({ where: { userId: targetUserId }, select: { permissions: true } });
  const current = row?.permissions ?? [];
  const holds = holdsCatalogueApproverGrant(current);
  if (holds === grant) return { userId: targetUserId, catalogueApprover: holds, changed: false };
  if (grant) {
    if (row) await tx.admin.update({ where: { userId: targetUserId }, data: { permissions: [...current, CATALOGUE_APPROVER_CAPABILITY] } });
    else await tx.admin.create({ data: { userId: targetUserId, permissions: [CATALOGUE_APPROVER_CAPABILITY] } });
  } else {
    await tx.admin.update({ where: { userId: targetUserId }, data: { permissions: current.filter((p) => p !== CATALOGUE_APPROVER_CAPABILITY) } });
  }
  return { userId: targetUserId, catalogueApprover: grant, changed: true };
}

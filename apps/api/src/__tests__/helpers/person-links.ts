/**
 * [Row 331 (b) · REVIEW-F #1879 S3-1] ONE rule for "this column points at a person", shared by the export
 * register census (account-export-register.test) and the erasure register census
 * (account-erasure-register.test): a relation to User or to a mover/provider profile, or a column named
 * for a person. Read from the generated schema (Prisma DMMF).
 */
import { Prisma } from '@prisma/client';

export const PERSON_NAME = /(^|[a-z])([uU]serId|[cC]ustomerId|raterId|rateeId|[cC]reatedBy|reporterId|[sS]enderId|[rR]ecipientId|[aA]ccountId|subjectId|[sS]ubjectUserId|[pP]assengerUserId|[dD]riverUserId|requesterId|actorId|ownerUserId|accessorUserId|counterpartyUserId|setByUserId|[uU]serIds?)$/;
export const PROFILES = ['Rider', 'Driver', 'ServiceProvider'];

/** Every `Model.column` that points at a person: a User relation, a person-named column, or a mover/provider profile. */
export function personLinks(): string[] {
  const links = new Set<string>();
  for (const m of Prisma.dmmf.datamodel.models) {
    if (m.name === 'User') continue;
    for (const f of m.fields) {
      if (f.kind === 'object' && (f.type === 'User' || PROFILES.includes(f.type))) for (const c of f.relationFromFields ?? []) links.add(`${m.name}.${c}`);
      if (f.kind === 'scalar' && f.type === 'String' && (PERSON_NAME.test(f.name) || /^(riderId|driverId|providerId)$/.test(f.name))) links.add(`${m.name}.${f.name}`);
    }
  }
  return [...links].sort();
}

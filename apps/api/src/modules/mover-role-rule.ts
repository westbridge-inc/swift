import type { UserRole } from '@prisma/client';

/** May this account's active role go online as this kind of mover? Kept apart from mover-authority.ts, which pulls in
 *  dispatch and custody, so the fee can read the same rule. */
export function moverRoleMayGo(activeRole: UserRole, kind: 'DRIVER' | 'RIDER'): boolean {
  return activeRole === 'MOVER' || activeRole === kind;
}

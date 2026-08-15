import type { SessionAuthMethod, UserRole } from '@prisma/client';

const PRIVILEGED_ROLES = new Set<UserRole>(['ADMIN', 'SUPER_ADMIN']);

/** Platform privilege is account authority, not merely the currently selected
 * UI surface. Checking both fields also fails closed on temporarily inconsistent
 * rows during a repair or interrupted role transition. */
export function requiresPrivilegedSessionAssurance(
  activeRole: UserRole,
  roles: readonly UserRole[],
): boolean {
  return PRIVILEGED_ROLES.has(activeRole)
    || roles.some((role) => PRIVILEGED_ROLES.has(role));
}

/** OTP is the only currently certified privileged authentication proof.
 * LEGACY deliberately does not infer assurance from row age or token validity;
 * PASSWORD remains valid only for non-privileged account use. */
export function hasPrivilegedSessionAssurance(authMethod: SessionAuthMethod): boolean {
  return authMethod === 'OTP';
}

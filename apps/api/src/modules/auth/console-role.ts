import type { UserRole } from '@prisma/client';

/** The roles that open the admin console, Mission Control and the ops routes. */
export type ConsoleRole = Extract<UserRole, 'ADMIN' | 'SUPER_ADMIN'>;

/**
 * [ADMIN-ROLE] Console authority is the admin role an account HOLDS
 * (`users.roles`), never the app's active mode (`users.activeRole`).
 *
 * The phone app's role switch moves `activeRole` between customer, store and
 * mover modes, and there is no way back to an admin mode. While the console
 * read `activeRole`, an admin whose phone was switched into rider mode got 403
 * on every console call, with no way to undo it. The roles list is what the
 * rest of the platform already treats as authority: the OTP-only session rule,
 * the admin pager's audience, the approver roster, the finance decision and the
 * console's own sign-in all read it.
 *
 * Only a role the account holds counts: a mode never grants anything, and an
 * account whose admin role is removed loses the console on its next request
 * (the roles are read with the session on every request). An account holding
 * both is judged by the higher one.
 */
export function consoleRoleOf(roles: readonly string[] | null | undefined): ConsoleRole | null {
  if (!Array.isArray(roles)) return null;
  if (roles.includes('SUPER_ADMIN')) return 'SUPER_ADMIN';
  if (roles.includes('ADMIN')) return 'ADMIN';
  return null;
}

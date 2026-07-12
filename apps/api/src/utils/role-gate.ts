import type { FastifyInstance } from 'fastify';
import type { UserRole } from '@prisma/client';
import { AppError, NotFoundError } from './errors';

/**
 * Called when a role-scoped profile lookup (driver/rider/vendor) comes back
 * empty for an authenticated user. Two very different situations end up here:
 *
 *  - an OUTSIDER (a customer token on /driver/*) — authorization failure, 403.
 *    Answering 404 here is authorization-by-absence: it confirms the route,
 *    accepts the token, and hands wrong-role callers a working oracle.
 *  - an INSIDER who simply hasn't finished onboarding this profile yet
 *    (a MOVER with a rider row but no driver row) — a real 404 the app relies
 *    on to route to onboarding.
 *
 * Legacy RIDER/DRIVER role values count as MOVER (locked domain model).
 */
export async function throwForMissingProfile(
  app: FastifyInstance,
  userId: string,
  requiredRole: UserRole,
  entity: string,
): Promise<never> {
  const user = await app.prisma.user.findUnique({
    where: { id: userId },
    select: { roles: true },
  });
  const roles = user?.roles ?? [];
  const hasRole =
    roles.includes(requiredRole) ||
    (requiredRole === 'MOVER' && (roles.includes('RIDER') || roles.includes('DRIVER')));
  if (!hasRole) {
    throw new AppError(403, 'FORBIDDEN', 'This account cannot access this resource');
  }
  throw new NotFoundError(entity);
}

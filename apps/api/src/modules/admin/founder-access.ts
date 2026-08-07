import { ForbiddenError } from '../../utils/errors';

/**
 * The cross-tenant integrity graph is visible only to the founder role.
 * Keep the decision pure so authorization behavior is testable without a
 * database, Redis, or the rest of the admin plugin.
 */
export function assertFounderAccess(role: string): void {
  if (role !== 'SUPER_ADMIN') {
    throw new ForbiddenError('Founder access required');
  }
}

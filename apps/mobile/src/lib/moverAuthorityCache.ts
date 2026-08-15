import type { QueryClient } from '@tanstack/react-query';

export type RememberedMoverRole = 'DRIVER' | 'RIDER';
export type CanonicalUserRole =
  | 'CUSTOMER'
  | 'RIDER'
  | 'DRIVER'
  | 'MOVER'
  | 'VENDOR_OWNER'
  | 'ADMIN'
  | 'SUPER_ADMIN';

export interface CanonicalMoverAuthority {
  activeRole: CanonicalUserRole;
  lastMoverRole: RememberedMoverRole | null;
}

const CANONICAL_USER_ROLES: readonly CanonicalUserRole[] = [
  'CUSTOMER',
  'RIDER',
  'DRIVER',
  'MOVER',
  'VENDOR_OWNER',
  'ADMIN',
  'SUPER_ADMIN',
];

function isUserRole(value: unknown): value is CanonicalUserRole {
  return typeof value === 'string' && (CANONICAL_USER_ROLES as readonly string[]).includes(value);
}

/**
 * Turn a role-changing API response into the only authority shape the auth
 * store is allowed to persist. The server response wins over the requested
 * role: a generic MOVER request may resolve to a remembered RIDER or DRIVER.
 * Older servers may omit lastMoverRole, so a specific active role remains a
 * safe fallback while customer/vendor transitions preserve existing memory.
 */
export function canonicalMoverAuthority(
  data: unknown,
  requestedRole: string,
  previousLastMoverRole?: string | null,
): CanonicalMoverAuthority {
  const payload = data && typeof data === 'object'
    ? data as { activeRole?: unknown; lastMoverRole?: unknown }
    : {};
  const requestedActiveRole = requestedRole === 'VENDOR'
    ? 'VENDOR_OWNER'
    : isUserRole(requestedRole)
      ? requestedRole
      : 'CUSTOMER';
  const activeRole = isUserRole(payload.activeRole)
    ? payload.activeRole
    : requestedActiveRole;

  let lastMoverRole: RememberedMoverRole | null =
    previousLastMoverRole === 'DRIVER' || previousLastMoverRole === 'RIDER'
      ? previousLastMoverRole
      : null;
  if (Object.prototype.hasOwnProperty.call(payload, 'lastMoverRole')) {
    lastMoverRole = payload.lastMoverRole === 'DRIVER' || payload.lastMoverRole === 'RIDER'
      ? payload.lastMoverRole
      : null;
  } else if (activeRole === 'DRIVER' || activeRole === 'RIDER') {
    lastMoverRole = activeRole;
  }

  return { activeRole, lastMoverRole };
}

/**
 * Server role switching takes an idle mover offline. Remove every cached mover
 * profile before navigation leaves that surface so an immediate return cannot
 * revive a stale `isOnline=true` snapshot and restart native GPS.
 */
export function clearMoverAuthorityCache(
  queryClient: Pick<QueryClient, 'removeQueries'>,
): void {
  queryClient.removeQueries({ queryKey: ['mover'] });
}

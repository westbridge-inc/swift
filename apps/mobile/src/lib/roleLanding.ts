// The account-answers routing law [first-open spec 2.2/2.3, SO-4] — PURE.
// `intent` is what the person is here for right now; roles are what the
// account HAS. Landing = intent clamped to roles; when there is no usable
// intent (fresh sign-in, reinstall), the server's activeRole — the last-used
// role it already remembers — decides. Nobody with an account is ever asked
// who they are.

export type Intent = 'customer' | 'mover' | 'vendor' | 'advertiser';

/** The account's own roles and entities, as the session carries them. */
export interface AccountRoles {
  roles?: readonly string[] | null;
  driver?: unknown;
  rider?: unknown;
  vendorOwner?: unknown;
}

/**
 * Does THIS account hold a surface's role? ONE predicate, shared by the
 * switcher (instant switch vs. "Join"), the sign-in landing and the earner
 * shells (dashboard vs. onboarding), so a surface can never read as owned on
 * one screen and joinable on the next.
 *
 * Customer is the open surface. Advertiser membership is not a UserRole.
 * Store STAFF never hold a role here — the server's own profile answer (200
 * with their memberships) seats them; this only says what the account holds.
 */
export function accountHoldsRole(account: AccountRoles | null | undefined, intent: Intent): boolean {
  if (intent === 'customer') return true;
  const roles = account?.roles ?? [];
  if (intent === 'mover') {
    return roles.includes('MOVER') || roles.includes('DRIVER') || roles.includes('RIDER')
      || !!account?.driver || !!account?.rider;
  }
  if (intent === 'vendor') {
    return roles.includes('VENDOR_OWNER') || roles.includes('VENDOR') || !!account?.vendorOwner;
  }
  return false;
}

export interface AccountShape {
  isVendor: boolean;
  isMover: boolean;
  /** Server UserRole, e.g. CUSTOMER | VENDOR_OWNER | DRIVER | RIDER. */
  activeRole: string | null;
}

export function landingIntent(prev: Intent | null, account: AccountShape): Intent {
  // A living choice wins — but only where the account actually holds the role
  // (a driver signing in after a vendor session on a shared device must not
  // land in the vendor dashboard). customer/advertiser are open surfaces.
  if (prev === 'customer' || prev === 'advertiser') return prev;
  if (prev === 'vendor' && account.isVendor) return prev;
  if (prev === 'mover' && account.isMover) return prev;

  // No usable choice → the account's last-used role answers (FO-04/FO-05).
  if (account.activeRole === 'VENDOR_OWNER' && account.isVendor) return 'vendor';
  if ((account.activeRole === 'MOVER' || account.activeRole === 'DRIVER' || account.activeRole === 'RIDER') && account.isMover) return 'mover';
  if (account.activeRole === 'CUSTOMER') return 'customer';

  // No activeRole signal → the single owned role, else the open surface.
  if (account.isVendor && !account.isMover) return 'vendor';
  if (account.isMover && !account.isVendor) return 'mover';
  return 'customer';
}

/** The switch-role sync payload for an owned surface — keeps the server's
 *  activeRole tracking "last used" so the NEXT sign-in lands right. */
export function switchRolePayload(
  intent: Intent,
  roles: string[],
  lastMoverRole?: string | null,
): 'CUSTOMER' | 'VENDOR' | 'MOVER' | 'DRIVER' | 'RIDER' | null {
  if (intent === 'customer') return 'CUSTOMER';
  if (intent === 'vendor') return roles.includes('VENDOR_OWNER') ? 'VENDOR' : null;
  if (intent === 'mover') {
    if ((lastMoverRole === 'DRIVER' || lastMoverRole === 'RIDER') && roles.includes(lastMoverRole)) {
      return lastMoverRole;
    }
    const specific = (['DRIVER', 'RIDER'] as const).filter((role) => roles.includes(role));
    if (specific.length === 1) return specific[0]!;
    // A legacy dual-profile account with no durable memory must choose inside
    // mover mode; null deliberately avoids silently defaulting to taxi.
    if (specific.length > 1) return null;
    if (roles.includes('MOVER')) return 'MOVER';
    return null;
  }
  return null; // advertiser is AdvertiserMember-based, not a UserRole
}

/** Which operational mover profile should be probed first. A dual-profile
 * account must follow the server's specific activeRole; otherwise a newly
 * selected delivery rider can silently land in the legacy Driver profile. */
export function moverKindOrder(
  activeRole: string | null | undefined,
  lastMoverRole?: string | null,
): readonly ('DRIVER' | 'RIDER')[] {
  const preferred = activeRole === 'DRIVER' || activeRole === 'RIDER'
    ? activeRole
    : lastMoverRole === 'DRIVER' || lastMoverRole === 'RIDER'
      ? lastMoverRole
      : null;
  return preferred
    ? [preferred, preferred === 'DRIVER' ? 'RIDER' : 'DRIVER']
    : [];
}

/** Server authority transition for a surface pick. Entering an unowned JOIN
 * flow from the mover app still leaves mover supply first (via CUSTOMER), so
 * navigation cannot unmount GPS while the account remains dispatchable. */
export function roleSwitchAuthorityPayload(
  current: Intent,
  target: Intent,
  targetOwned: boolean,
  roles: string[],
  lastMoverRole?: string | null,
) {
  if (targetOwned) return switchRolePayload(target, roles, lastMoverRole);
  return current === 'mover' ? 'CUSTOMER' as const : null;
}

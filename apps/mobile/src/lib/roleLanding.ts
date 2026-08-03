// The account-answers routing law [first-open spec 2.2/2.3, SO-4] — PURE.
// `intent` is what the person is here for right now; roles are what the
// account HAS. Landing = intent clamped to roles; when there is no usable
// intent (fresh sign-in, reinstall), the server's activeRole — the last-used
// role it already remembers — decides. Nobody with an account is ever asked
// who they are.

export type Intent = 'customer' | 'mover' | 'vendor' | 'advertiser';

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
  if ((account.activeRole === 'DRIVER' || account.activeRole === 'RIDER') && account.isMover) return 'mover';
  if (account.activeRole === 'CUSTOMER') return 'customer';

  // No activeRole signal → the single owned role, else the open surface.
  if (account.isVendor && !account.isMover) return 'vendor';
  if (account.isMover && !account.isVendor) return 'mover';
  return 'customer';
}

/** The switch-role sync payload for an owned surface — keeps the server's
 *  activeRole tracking "last used" so the NEXT sign-in lands right. */
export function switchRolePayload(intent: Intent, roles: string[]): 'CUSTOMER' | 'VENDOR' | 'DRIVER' | 'RIDER' | null {
  if (intent === 'customer') return 'CUSTOMER';
  if (intent === 'vendor') return roles.includes('VENDOR_OWNER') ? 'VENDOR' : null;
  if (intent === 'mover') {
    if (roles.includes('DRIVER')) return 'DRIVER';
    if (roles.includes('RIDER')) return 'RIDER';
    return null;
  }
  return null; // advertiser is AdvertiserMember-based, not a UserRole
}

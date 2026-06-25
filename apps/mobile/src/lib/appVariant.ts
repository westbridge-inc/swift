/**
 * App variant — Swift ships as two store apps built from this one codebase:
 *   - customer ("Swift")         : the consumer super-app (shop / movement / services / orders)
 *   - partner  ("Swift Partner") : movers + vendors, i.e. the weekly-subscription earners
 *
 * The variant is fixed at build time via EXPO_PUBLIC_APP_VARIANT (set per EAS build
 * profile in eas.json; defaults to `customer` for a plain local `expo start`). Keep
 * this module free of React / React Native imports so it stays unit-testable under
 * vitest's node environment.
 */
export type AppVariant = 'customer' | 'partner';

export function getAppVariant(): AppVariant {
  return process.env['EXPO_PUBLIC_APP_VARIANT'] === 'partner' ? 'partner' : 'customer';
}

/**
 * Which partner stack to mount for a given active role. A pure string mapping so
 * RootNavigator (which owns the actual screen components) stays declarative and this
 * stays testable. Anything that isn't an earner role lands on `onboarding` — the role
 * picker that turns a user into a mover or vendor.
 */
export type PartnerStackKey = 'mover' | 'vendor' | 'onboarding';

export function partnerStackKey(activeRole?: string | null): PartnerStackKey {
  switch (activeRole) {
    case 'MOVER':
    case 'RIDER':
    case 'DRIVER':
      return 'mover';
    case 'VENDOR_OWNER':
      return 'vendor';
    default:
      return 'onboarding';
  }
}

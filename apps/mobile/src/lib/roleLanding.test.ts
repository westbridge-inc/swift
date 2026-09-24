import { describe, it, expect } from 'vitest';
import { accountHoldsRole, landingIntent, moverKindOrder, roleSwitchAuthorityPayload, switchRolePayload } from './roleLanding';

// ---------------------------------------------------------------------------
// [phone feedback P2] ONE "holds" predicate. The switcher decided "switch vs.
// Join" with an inline copy of this rule, and the earner shells decided
// "dashboard vs. onboarding" with none at all — so a customer who tapped
// "Swift Business" to list a first store read "Join" on one screen and
// "This account cannot open that store" on the next. Every reader now asks
// the same question of the same function.
// ---------------------------------------------------------------------------
describe('accountHoldsRole', () => {
  it('the owner’s fresh account — a customer with no partner entity — holds neither earner surface', () => {
    const fresh = { roles: ['CUSTOMER'], driver: null, rider: null, vendorOwner: null };
    expect(accountHoldsRole(fresh, 'vendor')).toBe(false);
    expect(accountHoldsRole(fresh, 'mover')).toBe(false);
    expect(accountHoldsRole(fresh, 'advertiser')).toBe(false);
  });

  it('customer is the open surface — always held, even by no account at all', () => {
    expect(accountHoldsRole({ roles: ['CUSTOMER'] }, 'customer')).toBe(true);
    expect(accountHoldsRole(null, 'customer')).toBe(true);
    expect(accountHoldsRole(undefined, 'customer')).toBe(true);
  });

  it('vendor: the VENDOR_OWNER role or a vendorOwner entity', () => {
    expect(accountHoldsRole({ roles: ['CUSTOMER', 'VENDOR_OWNER'] }, 'vendor')).toBe(true);
    expect(accountHoldsRole({ roles: ['CUSTOMER'], vendorOwner: { id: 'vo1' } }, 'vendor')).toBe(true);
    expect(accountHoldsRole({ roles: ['CUSTOMER', 'MOVER'] }, 'vendor')).toBe(false);
  });

  it('mover: the unified MOVER role, a legacy DRIVER / RIDER role, or a driver / rider entity', () => {
    expect(accountHoldsRole({ roles: ['CUSTOMER', 'MOVER'] }, 'mover')).toBe(true);
    expect(accountHoldsRole({ roles: ['CUSTOMER', 'DRIVER'] }, 'mover')).toBe(true);
    expect(accountHoldsRole({ roles: ['CUSTOMER', 'RIDER'] }, 'mover')).toBe(true);
    expect(accountHoldsRole({ roles: ['CUSTOMER'], driver: { id: 'd1' } }, 'mover')).toBe(true);
    expect(accountHoldsRole({ roles: ['CUSTOMER'], rider: { id: 'r1' } }, 'mover')).toBe(true);
    expect(accountHoldsRole({ roles: ['CUSTOMER', 'VENDOR_OWNER'] }, 'mover')).toBe(false);
  });

  it('a store STAFF member holds nothing here — the server’s own 200 with memberships seats them', () => {
    // No UserRole exists for staff; the vendor shell still probes the profile
    // and follows a 200. This predicate only ever says what the account HOLDS.
    expect(accountHoldsRole({ roles: ['CUSTOMER'] }, 'vendor')).toBe(false);
  });

  it('no account, or an account with no roles list, holds only the open surface', () => {
    for (const intent of ['vendor', 'mover', 'advertiser'] as const) {
      expect(accountHoldsRole(null, intent)).toBe(false);
      expect(accountHoldsRole({}, intent)).toBe(false);
      expect(accountHoldsRole({ roles: null }, intent)).toBe(false);
    }
  });
});

// FO-04/FO-05 in miniature: reinstall/sign-in lands by the account's memory,
// never a question; a living valid choice survives; role-less intents clamp.

describe('landingIntent', () => {
  it('a valid living choice wins', () => {
    expect(landingIntent('vendor', { isVendor: true, isMover: true, activeRole: 'DRIVER' })).toBe('vendor');
    expect(landingIntent('mover', { isVendor: true, isMover: true, activeRole: 'VENDOR_OWNER' })).toBe('mover');
    expect(landingIntent('customer', { isVendor: true, isMover: true, activeRole: 'VENDOR_OWNER' })).toBe('customer');
  });

  it('a choice the account cannot hold is clamped, not honored', () => {
    // Shared device: previous session was vendor; this account is a driver.
    expect(landingIntent('vendor', { isVendor: false, isMover: true, activeRole: 'DRIVER' })).toBe('mover');
    expect(landingIntent('mover', { isVendor: true, isMover: false, activeRole: 'VENDOR_OWNER' })).toBe('vendor');
  });

  it('FO-04: reinstall single-role → straight in, no question', () => {
    expect(landingIntent(null, { isVendor: true, isMover: false, activeRole: null })).toBe('vendor');
    expect(landingIntent(null, { isVendor: false, isMover: true, activeRole: null })).toBe('mover');
    expect(landingIntent(null, { isVendor: false, isMover: false, activeRole: null })).toBe('customer');
  });

  it('FO-05: multi-role reinstall lands in the LAST-USED role (activeRole)', () => {
    expect(landingIntent(null, { isVendor: true, isMover: true, activeRole: 'VENDOR_OWNER' })).toBe('vendor');
    expect(landingIntent(null, { isVendor: true, isMover: true, activeRole: 'MOVER' })).toBe('mover');
    expect(landingIntent(null, { isVendor: true, isMover: true, activeRole: 'DRIVER' })).toBe('mover');
    expect(landingIntent(null, { isVendor: true, isMover: true, activeRole: 'RIDER' })).toBe('mover');
    expect(landingIntent(null, { isVendor: true, isMover: true, activeRole: 'CUSTOMER' })).toBe('customer');
  });

  it('a stale activeRole for a role the account lost falls through safely', () => {
    expect(landingIntent(null, { isVendor: false, isMover: true, activeRole: 'VENDOR_OWNER' })).toBe('mover');
  });
});

describe('switchRolePayload', () => {
  it('syncs the locked unified MOVER role without pretending it is legacy DRIVER', () => {
    expect(switchRolePayload('mover', ['MOVER', 'CUSTOMER'])).toBe('MOVER');
  });
  it('maps owned surfaces to the server role names, driver preferred over rider', () => {
    expect(switchRolePayload('customer', ['CUSTOMER'])).toBe('CUSTOMER');
    expect(switchRolePayload('vendor', ['VENDOR_OWNER'])).toBe('VENDOR');
    expect(switchRolePayload('mover', ['DRIVER', 'RIDER'], 'DRIVER')).toBe('DRIVER');
    expect(switchRolePayload('mover', ['RIDER'])).toBe('RIDER');
  });

  it('preserves Rider and Driver across customer/business round trips', () => {
    expect(switchRolePayload('mover', ['MOVER', 'DRIVER', 'RIDER'], 'RIDER')).toBe('RIDER');
    expect(switchRolePayload('mover', ['MOVER', 'DRIVER', 'RIDER'], 'DRIVER')).toBe('DRIVER');
    expect(switchRolePayload('mover', ['MOVER', 'DRIVER', 'RIDER'], null)).toBeNull();
  });

  it('un-owned or non-UserRole surfaces sync nothing', () => {
    expect(switchRolePayload('vendor', ['CUSTOMER'])).toBeNull();
    expect(switchRolePayload('mover', ['CUSTOMER'])).toBeNull();
    expect(switchRolePayload('advertiser', ['CUSTOMER'])).toBeNull();
  });
});

describe('moverKindOrder', () => {
  it('honours the server-selected Rider profile for a dual-profile mover', () => {
    expect(moverKindOrder('CUSTOMER', 'RIDER')).toEqual(['RIDER', 'DRIVER']);
  });

  it('prefers Driver for explicit Driver and legacy unified authority', () => {
    expect(moverKindOrder('DRIVER', 'RIDER')).toEqual(['DRIVER', 'RIDER']);
    expect(moverKindOrder('MOVER', null)).toEqual([]);
  });
});

describe('roleSwitchAuthorityPayload', () => {
  it('leaves mover supply before opening an unowned join flow', () => {
    expect(roleSwitchAuthorityPayload('mover', 'vendor', false, ['MOVER', 'CUSTOMER'], null))
      .toBe('CUSTOMER');
  });

  it('does not invent a server role when a non-mover opens an unowned join flow', () => {
    expect(roleSwitchAuthorityPayload('customer', 'vendor', false, ['CUSTOMER'], null))
      .toBeNull();
  });
});

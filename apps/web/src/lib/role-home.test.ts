import { describe, expect, it } from 'vitest';
import { roleHome } from './role-home';

// [BUG-HUNT F03] Where an account belongs. Branch staff hold no partner role; the server's `storeStaff` decides, and it
// only fills that gap: a business stays a business and a rider who also works at a store keeps the portal.
describe('roleHome', () => {
  it.each([
    [{ roles: ['CUSTOMER'], storeStaff: true }, { home: '/dashboard', kind: 'staff' }],
    [{ roles: ['CUSTOMER', 'VENDOR_OWNER'], storeStaff: true }, { home: '/dashboard', kind: 'business' }],
    [{ roles: ['CUSTOMER', 'MOVER'], storeStaff: true }, { home: '/portal', kind: 'earner' }],
    [{ roles: ['CUSTOMER'], storeStaff: false }, { home: '/', kind: 'customer' }],
    [{ roles: ['CUSTOMER'] }, { home: '/', kind: 'customer' }],
    [{ roles: ['CUSTOMER'], storeStaff: 'yes' }, { home: '/', kind: 'customer' }],
  ])('%j', (user, expected) => {
    expect(roleHome(user)).toEqual(expected);
  });
});

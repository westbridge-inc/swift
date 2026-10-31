import { describe, expect, it } from 'vitest';
import { History, Receipt } from 'lucide-react';
import { dashboardNav as navFor } from '@/app/dashboard/dashboard-shell';
import { NAV as portalNav } from '@/app/portal/portal-shell';

describe('console navigation', () => {
  // Owner ruling (11 Oct): the website has the app's four sections
  // (apps/mobile/src/modules/vendor/VendorStack.tsx): Orders · the items tab
  // named for the store type · Insights (owners and managers) · Account. Staff
  // see the items tab as "Availability" and no Insights, as in the app.
  it.each(['Menu', 'Inventory', 'Products', 'Services'] as const)('an owner or manager of a %s store sees the app\'s four sections, in the rail and the dock', (name) => {
    const nav = navFor(name, 'MANAGER');
    expect(nav.map(({ label }) => label)).toEqual(['Orders', name, 'Insights', 'Account']);
    expect(nav.map(({ href }) => href)).toEqual(['/dashboard/orders', '/dashboard/inventory', '/dashboard/insights', '/dashboard/settings']);
    // [OPEN-EARLY PR-2] the owner also has Documents (the phone's Account → Documents, owner only)
    expect(navFor(name, 'OWNER').map(({ label }) => label)).toEqual(['Orders', name, 'Insights', 'Documents', 'Account']);
  });

  // [OPEN-EARLY PR-2 · owner 31 Oct 2026] A store's documents are its owner's, as on the phone: the owner reaches them
  // from the rail and the menu (not the phone dock, which keeps the app's sections); managers and staff never see them.
  it('only the owner has Documents, before Account, off the phone dock', () => {
    const owner = navFor('Menu', 'OWNER', 'RESTAURANT');
    const docs = owner.find(({ label }) => label === 'Documents');
    expect(docs).toMatchObject({ href: '/dashboard/documents', dock: false });
    expect(owner.map(({ label }) => label).indexOf('Documents')).toBe(owner.length - 2);
    expect(navFor('Services', 'OWNER', 'SERVICE').map(({ label }) => label)).toEqual(['Orders', 'Schedule', 'Services', 'Insights', 'Documents', 'Account']);
    for (const role of ['MANAGER', 'STAFF', undefined] as const) {
      expect(navFor('Menu', role, 'RESTAURANT').some(({ href }) => href === '/dashboard/documents')).toBe(false);
    }
  });

  // The app's R1 tab (VendorStack: isService && manager): a Services store runs its
  // day from a booking agenda, so its owners and managers get Schedule after Orders.
  it.each(['OWNER', 'MANAGER'] as const)('a %s of a Services store also sees Schedule, right after Orders', (role) => {
    const nav = navFor('Services', role, 'SERVICE');
    expect(nav.map(({ label }) => label)).toEqual(['Orders', 'Schedule', 'Services', 'Insights', ...(role === 'OWNER' ? ['Documents'] : []), 'Account']);
    expect(nav[1]?.href).toBe('/dashboard/schedule');
  });

  it('no Schedule for a Services store\'s staff, nor for any other store type, as in the app', () => {
    expect(navFor('Services', 'STAFF', 'SERVICE').map(({ label }) => label)).toEqual(['Orders', 'Availability', 'Account']);
    expect(navFor('Services', undefined, 'SERVICE').map(({ label }) => label)).toEqual(['Orders', 'Availability', 'Account']);
    for (const [name, type] of [['Menu', 'RESTAURANT'], ['Inventory', 'SUPERMARKET'], ['Products', 'STORE']] as const) {
      expect(navFor(name, 'OWNER', type).map(({ label }) => label)).toEqual(['Orders', name, 'Insights', 'Documents', 'Account']);
    }
  });

  it('a staff login sees Orders, Availability and Account, as in the app', () => {
    expect(navFor('Menu', 'STAFF').map(({ label }) => label)).toEqual(['Orders', 'Availability', 'Account']);
    // Unknown role reads as least privilege (the app's vendorSurfaceForRole).
    expect(navFor('Menu', undefined).map(({ label }) => label)).toEqual(['Orders', 'Availability', 'Account']);
  });

  it('places Weekly fee after the portal work items and before Account', () => {
    expect(portalNav.map(({ label }) => label)).toEqual([
      'Earnings', 'History', 'Documents', 'Weekly fee', 'Account',
    ]);
  });

  it('gives the portal Weekly fee link its own receipt icon', () => {
    const portalFee = portalNav.find(({ label }) => label === 'Weekly fee');
    expect(portalFee?.icon).toBe(Receipt);
    expect(portalFee?.icon).not.toBe(History);
  });
});

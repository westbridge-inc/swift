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
    expect(nav.map(({ label }) => label)).toEqual(['Orders', name, 'Insights', 'Account', 'Help']);
    expect(nav.map(({ href }) => href)).toEqual(['/dashboard/orders', '/dashboard/inventory', '/dashboard/insights', '/dashboard/settings', '/dashboard/help']);
    // [BUG-HUNT F04] Help is in the rail and the menu; the phone dock keeps the app's sections.
    expect(nav.filter(({ dock }) => dock !== false).map(({ label }) => label)).toEqual(['Orders', name, 'Insights', 'Account']);
    // [OPEN-EARLY PR-2] the owner also has Documents (the phone's Account → Documents, owner only)
    expect(navFor(name, 'OWNER').map(({ label }) => label)).toEqual(['Orders', name, 'Insights', 'Documents', 'Account', 'Help']);
  });

  // [OPEN-EARLY PR-2 · owner 31 Oct 2026] A store's documents are its owner's, as on the phone: the owner reaches them
  // from the rail and the menu (not the phone dock, which keeps the app's sections); managers and staff never see them.
  it('only the owner has Documents, before Account, off the phone dock', () => {
    const owner = navFor('Menu', 'OWNER', 'RESTAURANT');
    const docs = owner.find(({ label }) => label === 'Documents');
    expect(docs).toMatchObject({ href: '/dashboard/documents', dock: false });
    expect(owner.map(({ label }) => label).indexOf('Documents')).toBe(owner.length - 3);
    expect(navFor('Services', 'OWNER', 'SERVICE').map(({ label }) => label)).toEqual(['Orders', 'Schedule', 'Services', 'Insights', 'Documents', 'Account', 'Help']);
    for (const role of ['MANAGER', 'STAFF', undefined] as const) {
      expect(navFor('Menu', role, 'RESTAURANT').some(({ href }) => href === '/dashboard/documents')).toBe(false);
    }
  });

  // The app's R1 tab (VendorStack: isService && manager): a Services store runs its
  // day from a booking agenda, so its owners and managers get Schedule after Orders.
  it.each(['OWNER', 'MANAGER'] as const)('a %s of a Services store also sees Schedule, right after Orders', (role) => {
    const nav = navFor('Services', role, 'SERVICE');
    expect(nav.map(({ label }) => label)).toEqual(['Orders', 'Schedule', 'Services', 'Insights', ...(role === 'OWNER' ? ['Documents'] : []), 'Account', 'Help']);
    expect(nav[1]?.href).toBe('/dashboard/schedule');
  });

  it('no Schedule for a Services store\'s staff, nor for any other store type, as in the app', () => {
    expect(navFor('Services', 'STAFF', 'SERVICE').map(({ label }) => label)).toEqual(['Orders', 'Availability', 'Account', 'Help']);
    expect(navFor('Services', undefined, 'SERVICE').map(({ label }) => label)).toEqual(['Orders', 'Availability', 'Account', 'Help']);
    for (const [name, type] of [['Menu', 'RESTAURANT'], ['Inventory', 'SUPERMARKET'], ['Products', 'STORE']] as const) {
      expect(navFor(name, 'OWNER', type).map(({ label }) => label)).toEqual(['Orders', name, 'Insights', 'Documents', 'Account', 'Help']);
    }
  });

  it('a staff login sees Orders, Availability and Account, as in the app', () => {
    expect(navFor('Menu', 'STAFF').map(({ label }) => label)).toEqual(['Orders', 'Availability', 'Account', 'Help']);
    // Unknown role reads as least privilege (the app's vendorSurfaceForRole).
    expect(navFor('Menu', undefined).map(({ label }) => label)).toEqual(['Orders', 'Availability', 'Account', 'Help']);
  });

  it('places Weekly fee after the portal work items and before Account', () => {
    expect(portalNav.map(({ label }) => label)).toEqual([
      'Earnings', 'History', 'Documents', 'Weekly fee', 'Account', 'Help',
    ]);
  });

  it('gives the portal Weekly fee link its own receipt icon', () => {
    const portalFee = portalNav.find(({ label }) => label === 'Weekly fee');
    expect(portalFee?.icon).toBe(Receipt);
    expect(portalFee?.icon).not.toBe(History);
  });
});

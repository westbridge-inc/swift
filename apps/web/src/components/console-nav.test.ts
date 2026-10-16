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
    expect(navFor(name, 'OWNER').map(({ label }) => label)).toEqual(['Orders', name, 'Insights', 'Account']);
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

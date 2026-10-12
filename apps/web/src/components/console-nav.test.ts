import { describe, expect, it } from 'vitest';
import { History, Receipt, Settings } from 'lucide-react';
import { dashboardNav as navFor } from '@/app/dashboard/dashboard-shell';

const dashboardNav = navFor('Products');
import { NAV as portalNav } from '@/app/portal/portal-shell';

describe('console navigation', () => {
  it('keeps Today first and places Weekly fee between Bulk import and Settings', () => {
    expect(dashboardNav.map(({ label }) => label)).toEqual([
      'Today', 'Orders', 'Products', 'Bulk import', 'Weekly fee', 'Settings',
    ]);
  });

  // Owner ruling (11 Oct): the items tab carries the app's name for the store's type.
  it.each(['Menu', 'Inventory', 'Products', 'Services'] as const)('shows %s in the phone dock beside Orders, Weekly fee and Settings', (name) => {
    expect(navFor(name).filter((item) => item.dock !== false).map(({ label }) => label)).toEqual(['Orders', name, 'Weekly fee', 'Settings']);
    expect(navFor(name).find((item) => item.href === '/dashboard/inventory')?.label).toBe(name);
  });

  it('places Weekly fee after the portal work items and before Account', () => {
    expect(portalNav.map(({ label }) => label)).toEqual([
      'Earnings', 'History', 'Documents', 'Weekly fee', 'Account',
    ]);
  });

  it('gives both Weekly fee links their own receipt icon', () => {
    const dashboardFee = dashboardNav.find(({ label }) => label === 'Weekly fee');
    const portalFee = portalNav.find(({ label }) => label === 'Weekly fee');
    expect(dashboardFee?.icon).toBe(Receipt);
    expect(portalFee?.icon).toBe(Receipt);
    expect(dashboardFee?.icon).not.toBe(Settings);
    expect(portalFee?.icon).not.toBe(History);
  });
});

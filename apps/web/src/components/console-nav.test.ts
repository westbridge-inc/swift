import { describe, expect, it } from 'vitest';
import { History, Receipt, Settings } from 'lucide-react';
import { NAV as dashboardNav } from '@/app/dashboard/dashboard-shell';
import { NAV as portalNav } from '@/app/portal/portal-shell';

describe('console navigation', () => {
  it('keeps Today first and places Weekly fee between Bulk import and Settings', () => {
    expect(dashboardNav.map(({ label }) => label)).toEqual([
      'Today', 'Orders', 'Products', 'Bulk import', 'Weekly fee', 'Settings',
    ]);
  });

  // Owner ruling (11 Oct): the app's words — the items tab is "Products" for every store.
  it('shows Products in the phone dock beside Orders, Weekly fee and Settings', () => {
    expect(dashboardNav.filter((item) => item.dock !== false).map(({ label }) => label)).toEqual(['Orders', 'Products', 'Weekly fee', 'Settings']);
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

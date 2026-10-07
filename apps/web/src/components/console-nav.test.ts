import { describe, expect, it } from 'vitest';
import { History, Receipt, Settings } from 'lucide-react';
import { NAV as dashboardNav } from '@/app/dashboard/dashboard-shell';
import { NAV as portalNav } from '@/app/portal/portal-shell';

describe('console navigation', () => {
  it('keeps Today first and places Documents and Weekly fee between Bulk import and Settings, in the portal’s order', () => {
    expect(dashboardNav.map(({ label }) => label)).toEqual([
      'Today', 'Orders', 'Inventory', 'Bulk import', 'Documents', 'Weekly fee', 'Settings',
    ]);
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

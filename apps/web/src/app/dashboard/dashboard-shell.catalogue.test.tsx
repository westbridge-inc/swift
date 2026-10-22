import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner ruling (11 Oct 2026): the items tab is named exactly like the app, by
// the selected store's type, in the side rail and the phone dock alike.

const fx = vi.hoisted(() => ({ getStores: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => '/dashboard/orders' }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>();
  return { ...real, sessionProbe: vi.fn().mockResolvedValue({ ok: true, user: { id: 'u1' } }), setSelectedStore: vi.fn() };
});
vi.mock('@/lib/vendor-api', () => ({ getStores: fx.getStores }));

import { DashboardShell } from './dashboard-shell';

const store = (vendorType: string) => ({
  stores: [{ id: 'store-1', name: 'Sample store', vendorType, isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }],
  selectedId: 'store-1',
  myRole: 'OWNER',
});

beforeEach(() => { fx.getStores.mockReset(); });

const NAMES = ['Menu', 'Inventory', 'Products', 'Services'];

describe('the items tab is named for the store type, like the app', () => {
  it.each([['RESTAURANT', 'Menu'], ['SUPERMARKET', 'Inventory'], ['STORE', 'Products'], ['SERVICE', 'Services']])('a %s store sees %s in the rail and the phone dock', async (vendorType, name) => {
    fx.getStores.mockResolvedValue(store(vendorType));
    render(<DashboardShell><p>console</p></DashboardShell>);
    await waitFor(() => expect(fx.getStores).toHaveBeenCalled());
    const rail = await screen.findByRole('navigation', { name: 'Business navigation' });
    const dock = screen.getByRole('navigation', { name: 'Business tabs' });
    await waitFor(() => expect(within(rail).getByRole('link', { name }).getAttribute('href')).toBe('/dashboard/inventory'));
    expect(within(dock).getByRole('link', { name }).getAttribute('href')).toBe('/dashboard/inventory');
    for (const other of NAMES.filter((n) => n !== name)) {
      expect(within(rail).queryByRole('link', { name: other })).toBeNull();
      expect(within(dock).queryByRole('link', { name: other })).toBeNull();
    }
    // The app's four sections, for an owner (the fixture's role); a Services store's
    // owner also has Schedule right after Orders (the app's VendorStack R1 tab).
    const sections = vendorType === 'SERVICE' ? ['Orders', 'Schedule', name, 'Insights', 'Account'] : ['Orders', name, 'Insights', 'Account'];
    expect(within(dock).getAllByRole('link').map((link) => link.textContent)).toEqual(sections);
    expect(within(rail).getAllByRole('link').map((link) => link.textContent)).toEqual(expect.arrayContaining(sections));
  });
});

import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner ruling (11 Oct 2026): the app's words — the items tab is "Products"
// for every store, food and shops alike, in the side rail and the phone dock.

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

describe('the items tab is Products for every store', () => {
  it.each([['RESTAURANT'], ['SUPERMARKET'], ['STORE'], ['SERVICE']])('a %s store sees Products in the rail and the phone dock', async (vendorType) => {
    const name = 'Products';
    fx.getStores.mockResolvedValue(store(vendorType));
    render(<DashboardShell><p>console</p></DashboardShell>);
    await waitFor(() => expect(fx.getStores).toHaveBeenCalled());
    const rail = await screen.findByRole('navigation', { name: 'Business navigation' });
    const dock = screen.getByRole('navigation', { name: 'Business tabs' });
    await waitFor(() => expect(within(rail).getByRole('link', { name }).getAttribute('href')).toBe('/dashboard/inventory'));
    expect(within(dock).getByRole('link', { name }).getAttribute('href')).toBe('/dashboard/inventory');
    for (const other of ['Menu', 'Inventory']) {
      expect(within(rail).queryByRole('link', { name: other })).toBeNull();
      expect(within(dock).queryByRole('link', { name: other })).toBeNull();
    }
  });
});

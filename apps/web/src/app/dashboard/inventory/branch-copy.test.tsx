import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InventoryPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// [CHAINS PR2] The menu page: an EMPTY menu of a business with several branches offers "Copy the menu from another
// branch"; a menu with items offers managers "Export menu (CSV)" (the selected store's, as a file).
const store = (id: string, name: string) => ({ id, name, vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true, status: 'ACTIVE', awaitingApproval: false });

function api(opts: { items: unknown[]; stores: unknown[]; role?: string }) {
  return mockApi(({ url }: ApiRequest) => {
    if (url.pathname === '/api/v1/vendor/items') return { body: { data: opts.items } };
    if (url.pathname === '/api/v1/vendor/categories') return { body: { data: opts.items.length ? [{ id: 'c1', name: 'Mains' }] : [] } };
    if (url.pathname === '/api/v1/vendor/stores') return { body: { data: { stores: opts.stores, selectedId: 'camp', myRole: opts.role ?? 'OWNER' } } };
    return { status: 404, body: { success: false } };
  });
}

beforeEach(async () => {
  (await import('@/lib/auth')).setSelectedStore('camp');
});

describe('[CHAINS] menu copy and export on the menu page', () => {
  it('an empty menu with another branch: the copy card shows', async () => {
    api({ items: [], stores: [store('camp', 'Royal Camp'), store('north', 'Royal North')] });
    renderWithQuery(<InventoryPage />);
    expect(await screen.findByText('Copy the menu from another branch')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Export menu (CSV)' })).toBeNull();
  });

  it('one store only: no copy card', async () => {
    const fetchMock = api({ items: [], stores: [store('camp', 'Royal Camp')] });
    renderWithQuery(<InventoryPage />);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/vendor/stores'))).toBe(true));
    await screen.findByText('No items match.');
    expect(screen.queryByText('Copy the menu from another branch')).toBeNull();
  });

  it('a manager exports the menu as a CSV file of the selected store', async () => {
    const created = vi.fn(() => 'blob:menu');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
    const base = api({ items: [{ id: 'i1', name: 'Rice', basePrice: '1200.00', isAvailable: true, category: { id: 'c1', name: 'Mains' } }], stores: [store('camp', 'Royal Camp'), store('north', 'Royal North')] });
    const { user } = renderWithQuery(<InventoryPage />);
    const button = await screen.findByRole('button', { name: 'Export menu (CSV)' });
    const csvFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/v1/vendor/menu/export')) {
        expect((init?.headers as Record<string, string>)['x-vendor-id']).toBe('camp');
        return new Response('category,name\nMains,Rice', { status: 200, headers: { 'Content-Type': 'text/csv' } });
      }
      return base(input, init);
    });
    vi.stubGlobal('fetch', csvFetch);
    await user.click(button);
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Copy the menu from another branch')).toBeNull();
  });
});

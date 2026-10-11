import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import InventoryPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

describe('inventory count and phone column order', () => {
  it('uses singular count and shows price and stock before SKU', async () => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/vendor/items') return { body: { data: [{ id: 'item-1', name: 'Rice', basePrice: '1200.00', stockQuantity: 7, sku: 'RICE-1', isAvailable: true }] } };
      if (url.pathname === '/api/v1/vendor/categories') return { body: { data: [] } };
      if (url.pathname === '/api/v1/vendor/stores') return { body: { data: { stores: [], selectedId: null, myRole: 'OWNER' } } };
      throw new Error(`Unexpected request: ${url}`);
    });
    renderWithQuery(<InventoryPage />);
    await screen.findByText('Rice');
    expect(screen.getByText('1 item')).toBeTruthy();
    const item = screen.getByRole('article', { name: 'Rice' });
    expect(within(item).getByRole('button', { name: '$1,200' })).toBeTruthy();
    expect(within(item).getByRole('button', { name: '7 in stock · Adjust stock' })).toBeTruthy();
    expect(within(item).getByText('SKU: RICE-1')).toBeTruthy();
    expect(within(item).getByRole('switch', { name: 'In stock: Rice' }).getAttribute('aria-checked')).toBe('true');
    // Phone order: price and stock read before the SKU.
    const text = item.textContent ?? '';
    expect(text.indexOf('$1,200')).toBeLessThan(text.indexOf('7 in stock'));
    expect(text.indexOf('7 in stock')).toBeLessThan(text.indexOf('SKU: RICE-1'));
  });

  it('flags an item at or under its low-stock line, and only that item', async () => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/vendor/items') return { body: { data: [
        { id: 'item-1', name: 'Rice', basePrice: '1200.00', stockQuantity: 3, lowStockThreshold: 5, isAvailable: true },
        { id: 'item-2', name: 'Flour', basePrice: '900.00', stockQuantity: 40, lowStockThreshold: 5, isAvailable: true },
        { id: 'item-3', name: 'Sugar', basePrice: '700.00', stockQuantity: null, isAvailable: true },
      ] } };
      if (url.pathname === '/api/v1/vendor/categories') return { body: { data: [] } };
      throw new Error(`Unexpected request: ${url}`);
    });
    renderWithQuery(<InventoryPage />);
    const low = await screen.findByRole('article', { name: 'Rice' });
    expect(within(low).getByText('Low stock')).toBeTruthy();
    expect(within(screen.getByRole('article', { name: 'Flour' })).queryByText('Low stock')).toBeNull();
    expect(within(screen.getByRole('article', { name: 'Sugar' })).queryByText('Low stock')).toBeNull();
  });

  // Owner ruling (11 Oct): named exactly like the app — the title is the store
  // type's name (Menu / Inventory / Products / Services), then the app's
  // "Your menu" line with how many items are live and sold out.
  it.each([['RESTAURANT', 'Menu'], ['SUPERMARKET', 'Inventory'], ['STORE', 'Products'], ['SERVICE', 'Services']])('a %s store sees the page titled %s', async (vendorType, name) => {
    const fetchMock = mockApi(({ url }) => {
      if (url.pathname === '/api/v1/vendor/items') return { body: { data: [
        { id: 'item-1', name: 'Rice', basePrice: '1200.00', stockQuantity: 7, isAvailable: true },
        { id: 'item-2', name: 'Flour', basePrice: '900.00', stockQuantity: 0, isAvailable: false },
        { id: 'item-3', name: 'Sugar', basePrice: '700.00', stockQuantity: null, isAvailable: true },
      ] } };
      if (url.pathname === '/api/v1/vendor/categories') return { body: { data: [] } };
      if (url.pathname === '/api/v1/vendor/stores') return { body: { data: { stores: [{ id: 'store-1', name: 'Sample store', vendorType, isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }], selectedId: 'store-1', myRole: 'OWNER' } } };
      throw new Error(`Unexpected request: ${url}`);
    });
    renderWithQuery(<InventoryPage />);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/v1/vendor/stores'))).toBe(true));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(name));
    expect(screen.getByText('Your menu')).toBeTruthy();
    expect(await screen.findByText('2 active · 1 sold out')).toBeTruthy();
  });
});

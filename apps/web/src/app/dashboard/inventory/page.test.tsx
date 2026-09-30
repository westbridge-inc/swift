import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import InventoryPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

describe('inventory count and phone column order', () => {
  it('uses singular count and shows price and stock before SKU', async () => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/vendor/items') return { body: { data: [{ id: 'item-1', name: 'Rice', basePrice: '1200.00', stockQuantity: 7, sku: 'RICE-1', isAvailable: true }] } };
      if (url.pathname === '/api/v1/vendor/categories') return { body: { data: [] } };
      throw new Error(`Unexpected request: ${url}`);
    });
    renderWithQuery(<InventoryPage />);
    await screen.findByText('Rice');
    expect(screen.getByText('1 item')).toBeTruthy();
    const headings = screen.getAllByRole('columnheader').map((heading) => heading.textContent);
    expect(headings.slice(0, 5)).toEqual(['Item', 'Category', 'Price', 'Stock', 'SKU']);
  });
});

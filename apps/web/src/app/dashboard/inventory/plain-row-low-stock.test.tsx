import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [FOLLOWUPS · REVIEW-F #2157 delta S4-d2, M-F536] Until the row tools arrive (their own chunk, fetched in the
// background after the page mounts), a tracked row draws its plain count. That plain row says "Low stock" too, for
// an item at or under its low-stock line and only that item, so the warning never waits on a chunk. The tools chunk
// is held back for this test, so what is on screen is the plain row.
// ---------------------------------------------------------------------------

const toolsArrived = vi.hoisted(() => ({ value: false }));
vi.mock('./menu-tools', async (importOriginal) => {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  toolsArrived.value = true;
  return importOriginal();
});

const { default: InventoryPage } = await import('./page');

describe('[FOLLOWUPS] the plain row (before the tools arrive) says "Low stock"', () => {
  it('at or under its line, and only that item', async () => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/vendor/items') return { body: { data: [
        { id: 'item-1', name: 'Rice', basePrice: '1200.00', stockQuantity: 3, lowStockThreshold: 5, isAvailable: true },
        { id: 'item-2', name: 'Flour', basePrice: '900.00', stockQuantity: 40, lowStockThreshold: 5, isAvailable: true },
        { id: 'item-3', name: 'Sugar', basePrice: '700.00', stockQuantity: null, isAvailable: true },
      ] } };
      if (url.pathname === '/api/v1/vendor/categories') return { body: { data: [] } };
      if (url.pathname === '/api/v1/vendor/stores') return { body: { data: { stores: [], selectedId: null, myRole: 'OWNER' } } };
      throw new Error(`Unexpected request: ${url}`);
    });
    renderWithQuery(<InventoryPage />);
    const low = await screen.findByRole('article', { name: 'Rice' });
    // The plain row: its count button, and no tools yet.
    expect(within(low).getByRole('button', { name: '3 in stock · Adjust stock' })).toBeTruthy();
    expect(toolsArrived.value).toBe(false);
    expect(within(low).getByText('Low stock')).toBeTruthy();
    expect(within(screen.getByRole('article', { name: 'Flour' })).queryByText('Low stock')).toBeNull();
    expect(within(screen.getByRole('article', { name: 'Sugar' })).queryByText('Low stock')).toBeNull();
    expect(toolsArrived.value).toBe(false);
  });
});

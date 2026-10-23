import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// [SPEED 22 Oct · owner: "switching the tabs from Orders to Products is slow"] The web
// Products page drew EVERY item row again for each in-stock tap, each background re-read
// and each key typed in Search. Now only a row whose own facts changed is drawn again.
// Rows are counted by their picture (one Pictogram per row); same reads, same server truth.
const drawn = vi.hoisted(() => ({ rows: 0 }));
vi.mock('@/components/glyphs', () => ({
  Pictogram: () => { drawn.rows += 1; return null; },
}));

import InventoryPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

const COUNT = 200;
let items: Array<Record<string, unknown>>;
beforeEach(() => {
  drawn.rows = 0;
  items = Array.from({ length: COUNT }, (_, i) => ({ id: `item-${i}`, name: `Product ${i}`, basePrice: '1000.00', stockQuantity: null, sku: `SKU-${i}`, isAvailable: true, category: { id: i % 2 ? 'odd' : 'even', name: i % 2 ? 'Odd' : 'Even' } }));
  mockApi(({ url, method, init }) => {
    if (url.pathname === '/api/v1/vendor/items' && method === 'GET') return { body: { data: items } };
    const avail = url.pathname.match(/^\/api\/v1\/vendor\/items\/([^/]+)\/availability$/);
    if (avail && method === 'PUT') {
      const { isAvailable } = JSON.parse(String(init?.body));
      items = items.map((row) => (row.id === avail[1] ? { ...row, isAvailable } : row));
      return { body: { data: items.find((row) => row.id === avail[1]) } };
    }
    if (url.pathname === '/api/v1/vendor/categories') return { body: { data: [{ id: 'even', name: 'Even' }, { id: 'odd', name: 'Odd' }] } };
    if (url.pathname === '/api/v1/vendor/stores') return { body: { data: { stores: [], selectedId: null, myRole: 'OWNER' } } };
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
});

describe('the web Products page draws again only what changed', () => {
  it('one in-stock tap re-draws that item, not all 200', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Product 199' });
    await waitFor(() => expect(screen.getByText('200 items')).toBeTruthy());
    const before = drawn.rows;
    const row = screen.getByRole('article', { name: 'Product 7' });
    await act(async () => { fireEvent.click(within(row).getByRole('switch', { name: 'In stock: Product 7' })); });
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'Product 7' })).getByRole('switch').getAttribute('aria-checked')).toBe('false'));
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'Product 7' })).getByRole('switch').hasAttribute('disabled')).toBe(false));
    expect(drawn.rows - before, 'rows drawn again for one tap').toBeLessThanOrEqual(4);
    expect(screen.getByText('199 active · 1 sold out')).toBeTruthy();
  });

  it('typing in Search never re-draws the rows that still match', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Product 199' });
    const before = drawn.rows;
    await act(async () => { fireEvent.change(screen.getByPlaceholderText('Search name or SKU'), { target: { value: 'Product 1' } }); });
    // 'Product 1', 'Product 10'-'19', 'Product 100'-'199' = 111 still shown, none drawn again.
    await waitFor(() => expect(screen.getByText('111 items')).toBeTruthy());
    expect(screen.getAllByRole('article')).toHaveLength(111);
    expect(screen.queryByRole('article', { name: 'Product 2' })).toBeNull();
    expect(drawn.rows - before, 'rows drawn again while typing').toBe(0);
    await act(async () => { fireEvent.change(screen.getByPlaceholderText('Search name or SKU'), { target: { value: 'SKU-42' } }); });
    await waitFor(() => expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Product 42']));
  });

  it('control: a row whose own facts changed is drawn with its new facts', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Product 3' });
    expect(within(screen.getByRole('article', { name: 'Product 3' })).queryByText('Sold out')).toBeNull();
    await act(async () => { fireEvent.click(within(screen.getByRole('article', { name: 'Product 3' })).getByRole('switch')); });
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'Product 3' })).getByText('Sold out')).toBeTruthy());
  });
});

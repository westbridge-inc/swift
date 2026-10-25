import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import InventoryPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5] Each item's VAT class, set by the owner of a store that told Swift it is VAT-registered.
// Only STANDARD goods carry VAT (and only once a person approved the store); the store is told it is responsible and
// pointed to the GRA. The rate on screen comes from the API. A store that never claimed VAT, or a manager, sees no
// VAT control. Synthetic store only.
// ---------------------------------------------------------------------------

const items = [
  { id: 'item-1', name: 'Soap', basePrice: '1000.00', stockQuantity: null, isAvailable: true, vatClass: 'STANDARD' },
  { id: 'item-2', name: 'Rice', basePrice: '600.00', stockQuantity: null, isAvailable: true, vatClass: 'ZERO_RATED' },
];
const vat = (status: string) => ({
  available: true, status, mode: status === 'NONE' ? null : 'PRICES_INCLUDE_VAT', vatRegistrationNumber: status === 'NONE' ? null : '012345678',
  effective: status === 'APPROVED', approved: null, reviewNote: null, certificate: null, ratePercent: 14, modesOffered: ['PRICES_INCLUDE_VAT'], sources: [],
});

function serve(myRole: string, vatStatus: string, writes: ApiRequest[] = []) {
  return mockApi((r) => {
    const path = r.url.pathname;
    if (r.method === 'PUT' && path.startsWith('/api/v1/vendor/items/')) { writes.push(r); return { body: { success: true, data: {} } }; }
    if (path === '/api/v1/vendor/items') return { body: { data: items } };
    if (path === '/api/v1/vendor/categories') return { body: { data: [] } };
    if (path === '/api/v1/vendor/stores') return { body: { data: { stores: [], selectedId: null, myRole } } };
    if (path === '/api/v1/vendor/profile') return { body: { data: { myRole, vendors: [{ id: 'store-1', name: 'Sample Shop' }] } } };
    if (path === '/api/v1/vendor/vat') return { body: { data: vat(vatStatus) } };
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

describe('[O-5] item VAT class on the inventory', () => {
  it('the owner of a store that claimed VAT sees each item’s class, and a change is saved for that item only', async () => {
    const user = userEvent.setup();
    const writes: ApiRequest[] = [];
    serve('OWNER', 'PENDING', writes);
    renderWithQuery(<InventoryPage />);
    const rice = await screen.findByRole('combobox', { name: 'VAT class: Rice' });
    expect((rice as HTMLSelectElement).value).toBe('ZERO_RATED');
    const soap = screen.getByRole('combobox', { name: 'VAT class: Soap' });
    expect(within(soap).getByRole('option', { name: 'Standard (14% VAT inside the price)' })).toBeTruthy();
    expect(screen.getByText(/you are responsible for it/)).toBeTruthy();
    await user.selectOptions(soap, 'EXEMPT');
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.url.pathname).toBe('/api/v1/vendor/items/item-1');
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ vatClass: 'EXEMPT' });
  });

  it('a store that never claimed VAT shows no VAT control', async () => {
    serve('OWNER', 'NONE');
    renderWithQuery(<InventoryPage />);
    await screen.findByText('Soap');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: /VAT class/ })).toBeNull());
    expect(screen.queryByText(/you are responsible for it/)).toBeNull();
  });

  it('a manager never sees the VAT control (and the owner-only VAT read is not even asked)', async () => {
    const fetchMock = serve('MANAGER', 'PENDING');
    renderWithQuery(<InventoryPage />);
    await screen.findByText('Soap');
    expect(screen.queryByRole('combobox', { name: /VAT class/ })).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/vendor/vat'))).toBe(false);
  });
});

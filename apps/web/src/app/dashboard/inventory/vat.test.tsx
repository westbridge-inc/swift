import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import InventoryPage from './page';
import { ItemEditor } from './menu-tools';
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
    // Before a person approved the store's VAT, nothing carries VAT yet, and the words do not say it does.
    expect(within(soap).getByRole('option', { name: 'Standard (VAT once your VAT is approved)' })).toBeTruthy();
    expect(within(soap).queryByRole('option', { name: /14%/ })).toBeNull();
    expect(screen.getByText(/you are responsible for it/)).toBeTruthy();
    await user.selectOptions(soap, 'EXEMPT');
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.url.pathname).toBe('/api/v1/vendor/items/item-1');
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ vatClass: 'EXEMPT' });
  });

  it('an APPROVED store’s standard items say the rate the API sends', async () => {
    serve('OWNER', 'APPROVED');
    renderWithQuery(<InventoryPage />);
    const soap = await screen.findByRole('combobox', { name: 'VAT class: Soap' });
    expect(within(soap).getByRole('option', { name: 'Standard (14% VAT inside the price)' })).toBeTruthy();
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

// [VAT-DOCS · owner 30 Oct 2026] A store whose VAT Swift adds to its prices: the row edits the price BEFORE VAT.
describe('[VAT-DOCS] the price of an item Swift adds VAT to', () => {
  it('the inline price edit starts at the price before VAT and sends vatListedPrice; another item sends basePrice', async () => {
    const user = userEvent.setup();
    const writes: ApiRequest[] = [];
    items.splice(0, items.length,
      { id: 'item-1', name: 'Soap', basePrice: '228.00', vatListedPrice: '200.00', stockQuantity: null, isAvailable: true, vatClass: 'STANDARD' } as never,
      { id: 'item-2', name: 'Rice', basePrice: '600.00', vatListedPrice: null, stockQuantity: null, isAvailable: true, vatClass: 'ZERO_RATED' } as never);
    serve('MANAGER', 'APPROVED', writes);
    renderWithQuery(<InventoryPage />);
    await user.click(await screen.findByRole('button', { name: /228/ }));
    const field = screen.getByRole('spinbutton', { name: 'Price before VAT: Soap' }) as HTMLInputElement;
    expect(field.value).toBe('200');
    await user.clear(field);
    await user.type(field, '250{Enter}');
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ vatListedPrice: 250 });
    await user.click(await screen.findByRole('button', { name: /600/ }));
    const rice = screen.getByRole('spinbutton', { name: 'Price: Rice' }) as HTMLInputElement;
    await user.clear(rice);
    await user.type(rice, '650{Enter}');
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(JSON.parse(String(writes[1]!.init?.body))).toEqual({ basePrice: 650 });
  });
});


// [REVIEW-F #2256 S4-2] A NEW item in a store whose VAT is added asks for the price before VAT, as the phone does.
describe('[VAT-DOCS] a new item in a store whose VAT is added to its prices', () => {
  const editor = (vatPricing: { adds: boolean; ratePercent: number } | null) => {
    mockApi((r) => { throw new Error(`Unexpected request: ${r.method} ${r.url}`); });
    // vatRate null: the VAT word comes from the profile, never from the owner-only VAT read.
    return renderWithQuery(<ItemEditor storeId="store-1" item={null} sections={[{ id: 'mains', name: 'Mains' }]} vendorType="SUPERMARKET"
      vatRate={null} vatEffective={false} vatPricing={vatPricing} onClose={() => undefined} />);
  };

  it('the price field asks for the price before VAT, with the same words as the phone', () => {
    editor({ adds: true, ratePercent: 14 });
    expect(screen.getByRole('textbox', { name: 'Price before VAT (GYD)' })).toBeTruthy();
    expect(screen.getByText('Type the price before VAT: 14% VAT is added to standard-rated items.')).toBeTruthy();
  });

  it('a store whose VAT is not added: the plain price field, no hint', () => {
    editor({ adds: false, ratePercent: 14 });
    expect(screen.getByRole('textbox', { name: 'Price (GYD)' })).toBeTruthy();
    expect(screen.queryByText(/Type the price before VAT/)).toBeNull();
  });

  it('[security review #2256] before the store’s VAT word has loaded, a new item cannot be saved', () => {
    editor(null);
    const add = screen.getByRole('button', { name: 'Loading the store’s prices…' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
  });
});

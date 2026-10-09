import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorefrontExperience } from './storefront-experience';
import { CustomerSessionProvider, type CustomerSession } from '@/components/customer-session';
import * as customer from '@/lib/customer';
import * as auth from '@/lib/auth';
import type { StorefrontDetail } from '@/lib/api';
import { GuestCart } from '@/components/guest-basket';
import { readGuestBasket } from '@/lib/basket';

// ---------------------------------------------------------------------------
// [W6] The one store page's menu: one tap for an item that needs no choice,
// "Choose" and a "From" price for one that does, a sheet that judges choices
// with the API's own validator and prices them with the API's own resolver,
// `?item=` deep links, quantity badges, real section links, and the keyboard.
// Synthetic store and items only.
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav }));

const option = (id: string, name: string, additionalPrice: string, extra: Partial<customer.OptionGroup['options'][number]> = {}) =>
  ({ id, name, additionalPrice, isAvailable: true, isDefault: false, ...extra });
const SIZE: customer.OptionGroup = { id: 'size', name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1,
  options: [option('regular', 'Regular', '0'), option('large', 'Large', '400')] };
const ROTI: customer.OptionGroup = { id: 'roti', name: 'Roti', isRequired: true, minSelect: 1, maxSelect: 1,
  options: [option('dhal', 'Dhal puri', '200'), option('paratha', 'Paratha', '300')] };
const EXTRAS: customer.OptionGroup = { id: 'extras', name: 'Extras', isRequired: false, minSelect: 2, maxSelect: 3,
  options: [option('egg', 'Egg', '150'), option('cheese', 'Cheese', '150'), option('plantain', 'Plantain', '100')] };

const soup = { id: 'soup', name: 'Pumpkin soup', description: 'Made by this store', basePrice: 800, imageUrl: null, unit: null,
  isPopular: false, fulfillment: 'DELIVERY', isAvailable: true, customerPrice: 800, optionGroups: [] as customer.OptionGroup[] };
const curry = { ...soup, id: 'curry', name: 'Curry & roti', basePrice: 1200, customerPrice: 1200, optionGroups: [SIZE, ROTI] };
const drink = { ...soup, id: 'drink', name: 'Sorrel', basePrice: 400, customerPrice: 400, optionGroups: [] as customer.OptionGroup[] };

type Item = typeof soup;
const store = (mains: Item[] = [soup, curry], drinks: Item[] = [drink]) => ({
  id: 'menu-store', slug: 'sample-kitchen', name: 'Sample Kitchen', description: null, vendorType: 'RESTAURANT',
  logoUrl: null, coverImageUrl: null, city: 'Georgetown', region: 'Demerara', cuisineTypes: [], tags: [],
  displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false, isCurrentlyOpen: true, acceptingOrders: true,
  estimatedPrepTime: 20, minOrderAmount: 0, isFeatured: false, addressLine1: 'Fixture street', operatingHours: [],
  categories: [{ id: 'mains', name: 'Mains', items: mains }, { id: 'drinks', name: 'Drinks', items: drinks }],
}) as unknown as StorefrontDetail;
const emptyCart = { items: [], vendor: null, subtotal: 0, subtotalCustomer: 0, totalAmount: 0, meetsMinimum: true } as unknown as customer.Cart;

let signedIn = true;
function live(mains?: Item[], drinks?: Item[]) {
  const s = store(mains, drinks);
  vi.spyOn(customer, 'getPublicStorefront').mockResolvedValue(s);
  vi.spyOn(customer, 'getPublicVendor').mockResolvedValue({ ...s, description: undefined } as unknown as customer.VendorDetail);
  return s;
}

function shellSession(ensureSignedIn: () => Promise<boolean>): CustomerSession {
  return { status: 'guest', scope: 'guest', epoch: 0, ensureSignedIn, nearPoint: null, setNearPoint: () => undefined };
}

async function start(options: { item?: string; wrap?: (_node: ReactNode) => ReactNode } = {}) {
  const page = <StorefrontExperience store={store()} returnPath="/store/sample-kitchen" initialItemId={options.item} />;
  render(<>{options.wrap ? options.wrap(page) : page}</>);
  await waitFor(() => expect((screen.getByRole('button', { name: signedIn ? 'Add Pumpkin soup' : 'Add Pumpkin soup' }) as HTMLButtonElement).disabled).toBe(false));
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  nav.push.mockReset();
  nav.refresh.mockReset();
  signedIn = true;
  vi.restoreAllMocks();
  vi.spyOn(auth, 'sessionProbe').mockImplementation(async () => ({ ok: signedIn }) as Awaited<ReturnType<typeof auth.sessionProbe>>);
  live();
  vi.spyOn(customer, 'getCart').mockResolvedValue(emptyCart);
  vi.spyOn(customer, 'getAddresses').mockResolvedValue([]);
  vi.spyOn(customer, 'addToCart').mockResolvedValue(emptyCart);
  vi.spyOn(customer, 'updateCartLine').mockResolvedValue(emptyCart);
});


describe('reviewer regression proofs', () => {
  it('a one-tap base-price Add does not increment a variant with paid extras', async () => {
    live([{ ...soup, optionGroups: [EXTRAS] }, curry]);
    vi.mocked(customer.getCart).mockResolvedValue({ ...emptyCart,
      vendor: { id: 'menu-store', name: 'Sample Kitchen' },
      items: [{ id: 'custom-line', itemId: 'soup', name: 'Pumpkin soup', quantity: 1,
        customerPrice: 1100, selectedOptions: { extras: ['egg', 'cheese'] }, isAvailable: true }],
    } as unknown as customer.Cart);
    render(<StorefrontExperience store={store()} returnPath="/store/sample-kitchen" />);
    const add = await screen.findByRole('button', { name: 'Add another Pumpkin soup' });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    expect(add.closest('article')?.textContent).toContain('$800');
    fireEvent.click(add);
    await waitFor(() => expect(customer.addToCart).toHaveBeenCalledExactlyOnceWith({ vendorId: 'menu-store', itemId: 'soup', quantity: 1 }));
    expect(customer.updateCartLine).not.toHaveBeenCalled();
  });
  it('keeps quantity 2 when a guest signs in at Place order', async () => {
    signedIn = false;
    const principal = vi.spyOn(auth, 'getSessionPrincipal').mockReturnValue(null);
    const ensureSignedIn = vi.fn(async () => { signedIn = true; principal.mockReturnValue('fixture-customer'); return true; });
    const merge = vi.spyOn(auth, 'apiFetch').mockImplementation(async () => ({ success: true, data: {
      applied: true, verdicts: readGuestBasket().lines.map(line => ({ clientLineId: line.clientLineId, status: 'ADDED' })),
    } }));
    await start({ wrap: node => <QueryClientProvider client={new QueryClient()}><CustomerSessionProvider value={shellSession(ensureSignedIn)}>{node}<GuestCart /></CustomerSessionProvider></QueryClientProvider> });
    fireEvent.click(screen.getByRole('button', { name: 'Choose options for Curry & roti' }));
    const sheet = screen.getByRole('dialog', { name: 'Curry & roti' });
    fireEvent.click(within(sheet).getByRole('radio', { name: /Large/ }));
    fireEvent.click(within(sheet).getByRole('radio', { name: /Paratha/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Increase quantity' }));
    expect(within(sheet).getByLabelText('Quantity 2')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: /^Add to order/ }));
    await waitFor(() => expect(readGuestBasket().lines[0]?.quantity).toBe(2));
    expect(ensureSignedIn).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(merge).toHaveBeenCalledTimes(1));
    expect(ensureSignedIn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(merge.mock.calls[0]?.[1]?.body)).lines[0]).toMatchObject({ quantity: 2, expectedUnitPrice: 1900, selectedOptions: { size: 'large', roti: 'paratha' } });
    await waitFor(() => expect(readGuestBasket().lines).toHaveLength(0));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalledTimes(1));
  });
  it('a deep-linked item remains open when Add is attempted before cart hydration completes', async () => {
    let resolveCart!: (_cart: customer.Cart) => void;
    vi.mocked(customer.getCart).mockImplementation(() => new Promise(resolve => { resolveCart = resolve; }));
    render(<StorefrontExperience store={store()} returnPath="/store/sample-kitchen" initialItemId="soup" />);
    const sheet = await screen.findByRole('dialog', { name: 'Pumpkin soup' });
    await waitFor(() => expect(customer.getCart).toHaveBeenCalled());
    const add = within(sheet).getByRole('button', { name: /^Add to order/ }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(screen.queryByRole('dialog', { name: 'Pumpkin soup' })).not.toBeNull();
    await act(async () => resolveCart(emptyCart));
    await waitFor(() => expect(add.disabled).toBe(false));
  });
});

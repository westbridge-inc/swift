import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorefrontExperience } from './storefront-experience';
import { CustomerSessionProvider, type CustomerSession } from '@/components/customer-session';
import * as customer from '@/lib/customer';
import * as auth from '@/lib/auth';
import type { StorefrontDetail } from '@/lib/api';
// The item sheet's code is split from the page; load it up front so a busy
// test run waits on the sheet's behaviour, not on fetching its code.
import './item-options-panel';

// ---------------------------------------------------------------------------
// [W6] The one store page's menu: one tap for an item that needs no choice,
// "Choose" and a "From" price for one that does, a sheet that judges choices
// with the API's own validator and prices them with the API's own resolver,
// `?item=` deep links, quantity badges, real section links, and the keyboard.
// Synthetic store and items only.
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ push: vi.fn() }));
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
  sessionStorage.clear(); localStorage.clear();
  nav.push.mockReset();
  signedIn = true;
  vi.restoreAllMocks();
  vi.spyOn(auth, 'sessionProbe').mockImplementation(async () => ({ ok: signedIn }) as Awaited<ReturnType<typeof auth.sessionProbe>>);
  live();
  vi.spyOn(customer, 'getCart').mockResolvedValue(emptyCart);
  vi.spyOn(customer, 'getAddresses').mockResolvedValue([]);
  vi.spyOn(customer, 'addToCart').mockResolvedValue(emptyCart);
  vi.spyOn(customer, 'updateCartLine').mockResolvedValue(emptyCart);
});

describe('[W6] one tap or Choose', () => {
  it('adds an item that needs no choice in one tap, without a sheet', async () => {
    await start();
    fireEvent.click(screen.getByRole('button', { name: 'Add Pumpkin soup' }));
    await waitFor(() => expect(customer.addToCart).toHaveBeenCalledExactlyOnceWith({ vendorId: 'menu-store', itemId: 'soup', quantity: 1 }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('Pumpkin soup added to your order.')).toBeTruthy();
  });

  it('shows the lowest price an item with required choices can be ordered at, as "From", and opens its choices instead of adding', async () => {
    await start();
    const choose = screen.getByRole('button', { name: 'Choose options for Curry & roti' });
    const card = choose.closest('article')!;
    // 1,200 + Regular (0) + the cheaper roti (Dhal puri, 200).
    expect(card.textContent).toContain('From');
    expect(card.textContent).toContain('$1,400');
    expect(within(screen.getByRole('button', { name: 'Add Pumpkin soup' }).closest('article')!).queryByText('From')).toBeNull();
    fireEvent.click(choose);
    expect(await screen.findByRole('dialog', { name: 'Curry & roti' })).toBeTruthy();
    expect(customer.addToCart).not.toHaveBeenCalled();
  });

  it('keeps an item whose choices are all optional one tap, and offers its choices separately', async () => {
    live([{ ...soup, optionGroups: [EXTRAS] }, curry]);
    await start();
    fireEvent.click(screen.getByRole('button', { name: 'Add Pumpkin soup' }));
    await waitFor(() => expect(customer.addToCart).toHaveBeenCalledExactlyOnceWith({ vendorId: 'menu-store', itemId: 'soup', quantity: 1 }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Choices open once the Add has finished (the page is busy until then).
    const customise = screen.getByRole('button', { name: 'Choose options for Pumpkin soup' });
    await waitFor(() => expect((customise as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(customise);
    expect(await screen.findByRole('dialog', { name: 'Pumpkin soup' })).toBeTruthy();
  });

  it('opens the choices, already set to the store’s own pick, when an optional choice comes pre-selected — never adds it silently or drops it', async () => {
    // A store pick the phone app pre-selects: one tap must not leave it out of
    // the kitchen ticket, nor charge for it unseen. The sheet shows it chosen.
    const BREAD: customer.OptionGroup = { id: 'bread', name: 'Bread', isRequired: false, minSelect: 0, maxSelect: 1,
      options: [option('none', 'No bread', '0'), option('garlic', 'Garlic bread', '250', { isDefault: true })] };
    const stew = { ...soup, id: 'stew', name: 'Bean stew', optionGroups: [BREAD] };
    live([soup, curry, stew]);
    await start();
    const card = screen.getByRole('heading', { name: 'Bean stew' }).closest('article')!;
    expect(within(card).queryByRole('button', { name: 'Add Bean stew' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Choose options for Bean stew' }));
    const sheet = await screen.findByRole('dialog', { name: 'Bean stew' });
    expect(customer.addToCart).not.toHaveBeenCalled();
    expect((within(sheet).getByRole('checkbox', { name: /Garlic bread/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(sheet).getByRole('button', { name: /^Add to order/ }).textContent).toContain('$1,050');
    fireEvent.click(within(sheet).getByRole('button', { name: /^Add to order/ }));
    await waitFor(() => expect(customer.addToCart).toHaveBeenCalledExactlyOnceWith({
      vendorId: 'menu-store', itemId: 'stew', quantity: 1, selectedOptions: { bread: 'garlic' },
    }));
  });
});

describe('[W6] the item sheet', () => {
  it('blocks the Add until every required choice is made — nothing is sent before the server’s validator accepts it', async () => {
    await start();
    fireEvent.click(screen.getByRole('button', { name: 'Choose options for Curry & roti' }));
    const sheet = await screen.findByRole('dialog', { name: 'Curry & roti' });
    const add = within(sheet).getByRole('button', { name: /^Add to order/ });
    fireEvent.click(add);
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Choose an option for Size.');
    fireEvent.click(within(sheet).getByRole('radio', { name: /Regular/ }));
    fireEvent.click(add);
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Choose an option for Roti.');
    expect(customer.addToCart).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole('radio', { name: /Paratha/ }));
    fireEvent.click(add);
    await waitFor(() => expect(customer.addToCart).toHaveBeenCalledExactlyOnceWith({
      vendorId: 'menu-store', itemId: 'curry', quantity: 1, selectedOptions: { roti: 'paratha', size: 'regular' },
    }));
  });

  it('prices the item plus each chosen choice, times the labelled quantity, and sends that quantity', async () => {
    await start();
    fireEvent.click(screen.getByRole('button', { name: 'Choose options for Curry & roti' }));
    const sheet = await screen.findByRole('dialog', { name: 'Curry & roti' });
    fireEvent.click(within(sheet).getByRole('radio', { name: /Large/ }));
    fireEvent.click(within(sheet).getByRole('radio', { name: /Dhal puri/ }));
    expect(within(sheet).getByRole('button', { name: /^Add to order/ }).textContent).toContain('$1,800');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Increase quantity' }));
    expect(within(sheet).getByLabelText('Quantity 2')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: /^Add to order/ }).textContent).toContain('$3,600');
    fireEvent.click(within(sheet).getByRole('button', { name: /^Add to order/ }));
    await waitFor(() => expect(customer.addToCart).toHaveBeenCalledExactlyOnceWith({
      vendorId: 'menu-store', itemId: 'curry', quantity: 2, selectedOptions: { roti: 'dhal', size: 'large' },
    }));
  });

  it('judges choices exactly as the server does: an optional group may stay empty, but once started it needs its minimum', async () => {
    live([soup, { ...curry, optionGroups: [SIZE, EXTRAS] }]);
    await start();
    fireEvent.click(screen.getByRole('button', { name: 'Choose options for Curry & roti' }));
    const sheet = await screen.findByRole('dialog', { name: 'Curry & roti' });
    fireEvent.click(within(sheet).getByRole('radio', { name: /Regular/ }));
    fireEvent.click(within(sheet).getByRole('checkbox', { name: /Egg/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: /^Add to order/ }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Choose 2 options for Extras.');
    expect(customer.addToCart).not.toHaveBeenCalled();
    // Emptying the optional group again is a selection the server accepts.
    fireEvent.click(within(sheet).getByRole('checkbox', { name: /Egg/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: /^Add to order/ }));
    await waitFor(() => expect(customer.addToCart).toHaveBeenCalledExactlyOnceWith({
      vendorId: 'menu-store', itemId: 'curry', quantity: 1, selectedOptions: { size: 'regular' },
    }));
  });

  it('never offers a sold-out choice, and says so when a required group has none left', async () => {
    live([soup, { ...curry, optionGroups: [SIZE, { ...ROTI, options: ROTI.options.map((choice) => ({ ...choice, isAvailable: false })) }] }]);
    await start();
    fireEvent.click(screen.getByRole('button', { name: 'Choose options for Curry & roti' }));
    const sheet = await screen.findByRole('dialog', { name: 'Curry & roti' });
    expect(within(sheet).queryByRole('radio', { name: /Dhal puri/ })).toBeNull();
    fireEvent.click(within(sheet).getByRole('radio', { name: /Regular/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: /^Add to order/ }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('“Roti” is sold out right now.');
    expect(customer.addToCart).not.toHaveBeenCalled();
  });

  it('does not open a linked item (?item=) while the store is closed or has paused orders', async () => {
    for (const state of [{ isCurrentlyOpen: false }, { acceptingOrders: false }]) {
      const s = { ...store(), ...state } as StorefrontDetail;
      vi.spyOn(customer, 'getPublicStorefront').mockResolvedValue(s);
      vi.spyOn(customer, 'getPublicVendor').mockResolvedValue({ ...s, description: undefined } as unknown as customer.VendorDetail);
      const view = render(<StorefrontExperience store={s} returnPath="/store/sample-kitchen" initialItemId="curry" />);
      await waitFor(() => expect(screen.getByText(/Live menu checked at/)).toBeTruthy());
      expect(screen.queryByRole('dialog')).toBeNull();
      view.unmount();
    }
  });

  it('opens the item a link names (?item=) once the live menu is verified, and adds nothing', async () => {
    await start({ item: 'curry' });
    expect(await screen.findByRole('dialog', { name: 'Curry & roti' })).toBeTruthy();
    expect(customer.addToCart).not.toHaveBeenCalled();
  });

  it('traps Tab, makes the page behind inert, closes on Escape and returns focus to the button that opened it', async () => {
    render(<main><StorefrontExperience store={store()} returnPath="/store/sample-kitchen" /></main>);
    const trigger = screen.getByRole('button', { name: 'Choose options for Curry & roti' });
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Curry & roti' });
    expect(document.querySelector('main')?.closest('[inert]')).toBeTruthy();
    const close = within(dialog).getByRole('button', { name: 'Close item options' });
    await waitFor(() => expect(document.activeElement).toBe(close));
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(close);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.querySelector('main')?.closest('[inert]')).toBeNull();
  });
});

describe('[W6] the menu around the sheet', () => {
  it('shows on each item how many are already in the order', async () => {
    vi.mocked(customer.getCart).mockResolvedValue({ ...emptyCart, vendor: { id: 'menu-store', name: 'Sample Kitchen' },
      items: [
        { id: 'l1', itemId: 'curry', name: 'Curry & roti', quantity: 2, customerPrice: 1400, isAvailable: true, fulfillment: 'DELIVERY' },
        { id: 'l2', itemId: 'curry', name: 'Curry & roti', quantity: 1, customerPrice: 1500, isAvailable: true, fulfillment: 'DELIVERY' },
      ] } as unknown as customer.Cart);
    await start();
    const curryCard = screen.getByRole('button', { name: /Customize another Curry & roti; 3 currently in your order/ }).closest('article')!;
    expect(within(curryCard).getByText('3 in your order')).toBeTruthy();
    expect(within(screen.getByRole('button', { name: 'Add Pumpkin soup' }).closest('article')!).queryByText(/in your order/)).toBeNull();
  });

  it('section chips are real links to each section, and the one chosen is marked', async () => {
    await start();
    const chips = within(screen.getByRole('navigation', { name: 'Menu sections' })).getAllByRole('link');
    expect(chips.map((chip) => [chip.textContent, chip.getAttribute('href')])).toEqual([['Mains', '#section-mains'], ['Drinks', '#section-drinks']]);
    expect(document.getElementById('section-drinks')).toBeTruthy();
    expect(chips[0]!.getAttribute('aria-current')).toBe('true');
    fireEvent.click(chips[1]!);
    expect(chips[1]!.getAttribute('aria-current')).toBe('true');
    expect(chips[0]!.getAttribute('aria-current')).toBeNull();
  });

  it('refreshes the app’s cart count after a change made on this page', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await start({ wrap: (node) => <QueryClientProvider client={client}>{node}</QueryClientProvider> });
    fireEvent.click(screen.getByRole('button', { name: 'Add Pumpkin soup' }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['customer', 'cart'] }));
  });
});

describe('[W6] a guest at Add', () => {
  it('fills the basket as a guest and only renews the session at Place order', async () => {
    signedIn = false;
    const ensureSignedIn = vi.fn(async () => false);
    await start({ wrap: (node) => <CustomerSessionProvider value={shellSession(ensureSignedIn)}>{node}</CustomerSessionProvider> });
    fireEvent.click(screen.getByRole('button', { name: 'Choose options for Curry & roti' }));
    const sheet = await screen.findByRole('dialog', { name: 'Curry & roti' });
    fireEvent.click(within(sheet).getByRole('radio', { name: /Large/ }));
    fireEvent.click(within(sheet).getByRole('radio', { name: /Paratha/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: /^Add to order/ }));
    await waitFor(() => expect(localStorage.getItem('swift_guest_basket_v1')).not.toBeNull());
    expect(JSON.parse(localStorage.getItem('swift_guest_basket_v1')!).lines[0]).toMatchObject({
      vendorId: 'menu-store', itemId: 'curry', unitPrice: 1900, selectedOptions: { size: 'large', roti: 'paratha' },
    });
    expect(ensureSignedIn).not.toHaveBeenCalled(); expect(nav.push).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Place order' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
    // [W4] The code brings the customer to the one checkout, where the basket is uploaded.
    await waitFor(() => expect(nav.push).toHaveBeenCalledExactlyOnceWith('/login?next=%2Fcheckout'));
    expect(ensureSignedIn).toHaveBeenCalledOnce(); expect(customer.addToCart).not.toHaveBeenCalled();
  });

  it('tries the refresh cookie at Place order without silently placing an order', async () => {
    signedIn = false;
    const ensureSignedIn = vi.fn(async () => { signedIn = true; return true; });
    await start({ wrap: (node) => <CustomerSessionProvider value={shellSession(ensureSignedIn)}>{node}</CustomerSessionProvider> });
    fireEvent.click(screen.getByRole('button', { name: 'Add Pumpkin soup' }));
    expect(ensureSignedIn).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Place order' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
    // [W4] A renewed session goes straight to the one checkout; nothing is ordered or added here.
    await waitFor(() => expect(nav.push).toHaveBeenCalledExactlyOnceWith('/checkout'));
    expect(ensureSignedIn).toHaveBeenCalledOnce(); expect(customer.addToCart).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('swift_guest_basket_v1')!).lines[0].itemId).toBe('soup');
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import styles from './storefront.module.css';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import StorePage from '@/app/(app)/store/[slug]/page';
import LoginPage from '@/app/login/page';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CustomerSessionProvider } from '@/components/customer-session';
import { GuestBasketSync } from '@/components/guest-basket';
import { readGuestBasket } from '@/lib/basket';
import type { StorefrontDetail } from '@/lib/api';
import * as api from '@/lib/api';
import * as customer from '@/lib/customer';
import * as auth from '@/lib/auth';
// The item sheet's code is split from the page; load it up front so a busy
// test run waits on the sheet's behaviour, not on fetching its code.
import './item-options-panel';

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), query: '' }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, useSearchParams: () => new URLSearchParams(nav.query), notFound: () => { throw new Error('not found'); } }));

const store: StorefrontDetail = {
  id: 'qr-store', slug: 'garden-kitchen', name: 'Garden Kitchen', description: null,
  vendorType: 'RESTAURANT', logoUrl: null, coverImageUrl: null, city: 'Georgetown', region: 'Demerara',
  cuisineTypes: [], tags: [], displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false,
  isCurrentlyOpen: true, acceptingOrders: true, estimatedPrepTime: 20, minOrderAmount: 0, isFeatured: false,
  addressLine1: 'Market Road', operatingHours: [],
  categories: [{ id: 'lunch', name: 'Lunch menu', items: [{ id: 'roti', name: 'Pumpkin roti', description: null,
    basePrice: 800, imageUrl: null, unit: null, isPopular: false, fulfillment: 'DELIVERY' }] }],
};
const copy = 'Dining in? Browse our menu here and place your order with your server.';
const page = (search: Record<string, string | string[] | undefined> = {}) => StorePage({
  params: Promise.resolve({ slug: store.slug }), searchParams: Promise.resolve(search),
});

// happy-dom does not calculate layout bounds. Load the actual module rules
// under their transformed class names so computed-style assertions exercise CSS.
const stylesheet = document.createElement('style');
beforeAll(() => {
  stylesheet.textContent = readFileSync(`${process.cwd()}/src/components/storefront/storefront.module.css`, 'utf8')
    .replace(/\.([a-zA-Z][\w-]*)/g, (selector, name: string) => styles[name as keyof typeof styles] ? `.${styles[name as keyof typeof styles]}` : selector);
  document.head.append(stylesheet);
});
afterAll(() => stylesheet.remove());

beforeEach(() => {
  sessionStorage.clear(); localStorage.clear();
  nav.push.mockReset();
  nav.replace.mockReset();
  nav.query = '';
  vi.spyOn(auth, 'sendOtp').mockResolvedValue(undefined);
  vi.spyOn(auth, 'verifyPartnerLogin').mockResolvedValue({ home: '/dashboard' } as Awaited<ReturnType<typeof auth.verifyPartnerLogin>>);
  vi.spyOn(customer, 'verifyCustomerLogin').mockResolvedValue({ user: { id: 'customer' } } as Awaited<ReturnType<typeof customer.verifyCustomerLogin>>);
  vi.spyOn(api, 'fetchStorefront').mockResolvedValue(store);
  vi.spyOn(auth, 'sessionProbe').mockResolvedValue({ ok: false });
  vi.spyOn(customer, 'getPublicStorefront').mockResolvedValue(store);
  vi.spyOn(customer, 'getPublicVendor').mockResolvedValue({ ...store, description: undefined, categories: store.categories.map(category => ({
    ...category, items: category.items.map(item => ({ ...item, description: undefined, isAvailable: true })),
  })) });
  vi.spyOn(customer, 'getCart').mockRejectedValue(new Error('A guest must not load a cart'));
  vi.spyOn(customer, 'addToCart').mockRejectedValue(new Error('A guest must sign in before ordering'));
});

describe('the actual /store/[slug] QR arrival', () => {
  it('server-renders this store, attribution, menu and QR banner before hydration', async () => {
    const element = await page({ src: 'qr', c: 'BCDFGHJKMN', t: 'card' });
    const html = renderToString(element);
    expect(html).toContain('Garden Kitchen');
    // [W6] The store page sits inside Swift's own app frame now (rail, dock,
    // footer), so it has no store-branded top bar of its own; its section
    // chips are part of the server render.
    expect(html).toContain('Menu sections');
    expect(html).toContain('Pumpkin roti');
    expect(html).toContain(copy);
    render(element);
    expect(screen.getByRole('heading', { level: 1, name: store.name })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Lunch menu' })).toBeTruthy();
    const status = screen.getByText(copy).closest('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(customer.getCart).not.toHaveBeenCalled();
  });

  it.each([{}, { src: 'share' }, { c: 'BCDFGHJKMN' }, { src: ['qr', 'share'] }])(
    'does not show a dine-in banner for a non-QR arrival %j', async search => {
      render(await page(search));
      expect(screen.queryByText(copy)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Dismiss dining-in message' })).toBeNull();
    },
  );

  it('preserves the menu/cart flow slot and computed layout styles on dismissal', async () => {
    render(await page({ src: 'qr' }));
    const dismiss = screen.getByRole('button', { name: 'Dismiss dining-in message' });
    const slot = dismiss.parentElement!;
    const menu = screen.getByRole('region', { name: 'Menu' });
    const checkout = screen.getByRole('complementary', { name: 'Your order and checkout' });
    // [W6] The order panel is the store page's cart; a floating "View your
    // order" link joins it once something is in the order. (The old
    // store-branded top bar and its cart link are gone: the app's frame holds
    // the page now.)
    const cartLinks = screen.queryAllByRole('link', { name: /Your order/ });
    const layoutStyles = (element: Element) => {
      const computed = getComputedStyle(element);
      return Object.fromEntries([
        'display', 'position', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
        'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
        'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
        'border-top-width', 'border-bottom-width', 'border-left-width', 'border-right-width',
        'transform', 'translate', 'scale',
      ].map(property => [property, computed.getPropertyValue(property)]));
    };
    const beforeStyles = [slot, menu, checkout].map(layoutStyles);
    expect(getComputedStyle(slot).position).toBe('static');
    expect(getComputedStyle(slot).display).toBe('flex');
    for (const property of ['transform', 'translate', 'scale']) {
      expect(['', 'none']).toContain(getComputedStyle(slot).getPropertyValue(property));
    }
    expect(Number.parseFloat(getComputedStyle(dismiss).minWidth)).toBeGreaterThanOrEqual(44);
    expect(Number.parseFloat(getComputedStyle(dismiss).minHeight)).toBeGreaterThanOrEqual(44);
    expect(getComputedStyle(dismiss).flexShrink).toBe('0');
    const before = slot.getBoundingClientRect();
    const menuBounds = menu.getBoundingClientRect();
    if (before.height && menuBounds.height) {
      expect(before.bottom).toBeLessThanOrEqual(menuBounds.top);
      for (const cartLink of [checkout, ...cartLinks]) {
        const cartBounds = cartLink.getBoundingClientRect();
        expect(before.bottom <= cartBounds.top || before.top >= cartBounds.bottom || before.right <= cartBounds.left || before.left >= cartBounds.right).toBe(true);
      }
    } else {
      // No invented geometry: prove the stylesheet rule and separate flow slot.
      expect(stylesheet.textContent).toMatch(/position: static/);
      expect(slot.parentElement).toBe(menu.parentElement?.parentElement);
      expect(checkout.parentElement).toBe(menu.parentElement);
      expect(getComputedStyle(menu.parentElement!).display).toBe('grid');
      expect(slot.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(slot.compareDocumentPosition(checkout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      for (const cartLink of cartLinks) expect(slot.contains(cartLink)).toBe(false);
    }
    fireEvent.click(dismiss);
    expect(slot.isConnected).toBe(true);
    expect(slot.getAttribute('aria-hidden')).toBe('true');
    expect(getComputedStyle(slot).visibility).toBe('hidden');
    expect(getComputedStyle(slot).display).toBe('flex');
    expect([slot, menu, checkout].map(layoutStyles)).toEqual(beforeStyles);
    // happy-dom returns zero bounds: only compare geometry if it was computed.
    // The fallback proves CSS/DOM invariants, not a measured browser CLS score.
    if (before.height) expect(slot.getBoundingClientRect()).toEqual(before);
    expect(screen.queryByRole('button', { name: 'Dismiss dining-in message' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Menu' })).toBe(document.activeElement);
    expect(screen.getByRole('complementary', { name: 'Your order and checkout' })).toBe(checkout);
  });


  it('remembers dismissal for this store across remounts in the browser session', async () => {
    const first = render(await page({ src: 'qr' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss dining-in message' }));
    first.unmount();
    render(await page({ src: 'qr' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Dismiss dining-in message' })).toBeNull());
    expect(screen.getByText(copy).parentElement?.getAttribute('aria-hidden')).toBe('true');
  });

  it('does not carry dismissal to another store', async () => {
    const first = render(await page({ src: 'qr' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss dining-in message' }));
    first.unmount();
    vi.mocked(api.fetchStorefront).mockResolvedValue({ ...store, id: 'another-store', name: 'Another Store' });
    render(await page({ src: 'qr' }));
    expect(screen.getByRole('button', { name: 'Dismiss dining-in message' })).toBeTruthy();
  });

  it('still dismisses and leaves the menu usable when session storage is blocked', async () => {
    const blocked = vi.fn(() => { throw new Error('blocked'); });
    vi.stubGlobal('sessionStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    render(await page({ src: 'qr' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss dining-in message' }));
    expect(screen.queryByRole('button', { name: 'Dismiss dining-in message' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Menu' })).toBe(document.activeElement);
  });

  it('keeps QR items in a guest basket and signs in only at Place order', async () => {
    render(await page({ src: 'qr', c: 'BCDFGHJKMN' }));
    const add = await screen.findByRole('button', { name: /Add Pumpkin roti/ });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(add);
    expect(nav.push).not.toHaveBeenCalled(); expect(customer.addToCart).not.toHaveBeenCalled();
    await waitFor(() => expect(readGuestBasket().lines[0]).toMatchObject({ itemId: 'roti', quantity: 1, unitPrice: 800 }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Place order' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
    // [W4] The code brings the customer to the one checkout.
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/login?next=%2Fcheckout'));
  });

  it('takes a signed-in customer from the scanned menu to the one checkout, without the banner blocking it', async () => {
    vi.mocked(auth.sessionProbe).mockResolvedValue({ ok: true });
    const cart: customer.Cart = {
      items: [{ id: 'line', itemId: 'roti', name: 'Pumpkin roti', quantity: 1, customerPrice: 800, isAvailable: true, fulfillment: 'DELIVERY' }],
      vendor: { id: store.id, name: store.name, isCurrentlyOpen: true, acceptingOrders: true },
      deliveryAddress: { id: 'address' }, subtotalCustomer: 800, deliveryFee: 200, totalAmount: 1000,
    };
    vi.mocked(customer.getCart).mockResolvedValueOnce({ items: [] }).mockResolvedValue(cart);
    vi.mocked(customer.addToCart).mockResolvedValue(cart);
    vi.spyOn(customer, 'getAddresses').mockResolvedValue([{ id: 'address', label: 'Home', addressLine1: 'Example Street', city: 'Georgetown', isDefault: true }]);
    const order = vi.spyOn(customer, 'checkout');
    render(await page({ src: 'qr' }));
    const add = await screen.findByRole('button', { name: /Add Pumpkin roti/ });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);
    expect(customer.addToCart).toHaveBeenCalledWith({ vendorId: store.id, itemId: 'roti', quantity: 1 });
    // [W4] The store page shows the basket; the one checkout prices and places it.
    const next = await screen.findByRole('button', { name: 'Checkout · $800' });
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(next);
    expect(nav.push).toHaveBeenCalledWith('/checkout');
    expect(order).not.toHaveBeenCalled();
    expect(screen.getByText(copy)).toBeTruthy();
  });
});


describe('QR-01-W: guest basket → sign-in → one bulk upload', () => {
  it.each(['Place order', 'direct sign-in'])('preserves the QR basket through %s and uploads once without placing an order', async startingState => {
    const first = render(await page({ src: 'qr', c: 'BCDFGHJKMN' }));
    const add = await screen.findByRole('button', { name: /Add Pumpkin roti/ });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(add);
    await waitFor(() => expect(readGuestBasket().lines).toHaveLength(1));
    expect(nav.push).not.toHaveBeenCalled(); const line = readGuestBasket().lines[0]!;
    if (startingState === 'Place order') { await waitFor(() => expect((screen.getByRole('button', { name: 'Place order' }) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(screen.getByRole('button', { name: 'Place order' })); await waitFor(() => expect(nav.push).toHaveBeenCalledOnce()); }
    first.unmount(); nav.query = startingState === 'Place order' ? String(nav.push.mock.calls[0]?.[0]).split('?')[1]! : '';
    const login = render(<LoginPage />);
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001001' } }); await waitFor(() => expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } }); fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    // [W4] Place order signs in for the one checkout; a direct sign-in returns to the scanned store.
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith(startingState === 'Place order' ? '/checkout' : '/store/garden-kitchen?src=qr&c=BCDFGHJKMN')); login.unmount();
    expect(readGuestBasket().lines).toHaveLength(1);
    const upload = vi.spyOn(auth, 'apiFetch').mockResolvedValue({ data: { applied: true, verdicts: [{ clientLineId: line.clientLineId, status: 'ADDED' }], cart: { items: [] } } } as never);
    const order = vi.spyOn(customer, 'checkout');
    render(<QueryClientProvider client={new QueryClient()}><CustomerSessionProvider value={{ status: 'signed-in', scope: 'customer', epoch: 0, ensureSignedIn: async () => true, nearPoint: null, setNearPoint: () => undefined }}><GuestBasketSync /></CustomerSessionProvider></QueryClientProvider>);
    await waitFor(() => expect(readGuestBasket().lines).toEqual([])); expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toBe('/api/v1/customer/cart/merge');
    expect(JSON.parse(String(upload.mock.calls[0]?.[1]?.body)).lines[0]).toMatchObject({ itemId: 'roti', quantity: 1, expectedUnitPrice: 800 });
    expect(customer.addToCart).not.toHaveBeenCalled(); expect(order).not.toHaveBeenCalled();
  });
});

const savedIntent = { storeSlug: store.slug, itemId: 'roti', selectedOptions: { filling: ['chickpea'] }, returnPath: '/store/garden-kitchen?src=qr' };
const filling: customer.OptionGroup = { id: 'filling', name: 'Filling', isRequired: true, minSelect: 1, maxSelect: 1, options: [
  { id: 'pumpkin', name: 'Pumpkin', additionalPrice: '0', isDefault: true, isAvailable: true },
  { id: 'chickpea', name: 'Chickpea', additionalPrice: '100', isDefault: false, isAvailable: true },
] };
function signedInWithOptions() {
  vi.mocked(auth.sessionProbe).mockResolvedValue({ ok: true });
  vi.mocked(customer.getCart).mockResolvedValue({ items: [] });
  vi.spyOn(customer, 'getAddresses').mockResolvedValue([]);
  vi.mocked(customer.addToCart).mockResolvedValue({ items: [] });
  const vendor = { ...store, description: undefined, categories: [{ id: 'lunch', name: 'Lunch menu', items: [{
    ...store.categories[0]!.items[0]!, description: undefined, basePrice: 1200, isAvailable: true, optionGroups: [filling],
  }] }] };
  vi.mocked(customer.getPublicVendor).mockResolvedValue(vendor);
  return vendor;
}

describe('QR-01-W continuation boundaries', () => {
  it('restores chosen IDs with fresh prices and consumes on dialog cancellation', async () => {
    signedInWithOptions();
    sessionStorage.setItem('swift_storefront_add', JSON.stringify({ ...savedIntent, price: 1 }));
    const resumed = render(await page());
    const dialog = await screen.findByRole('dialog', { name: 'Pumpkin roti' });
    expect((screen.getByRole('radio', { name: /Chickpea/ }) as HTMLInputElement).checked).toBe(true);
    expect(dialog.textContent).toContain('$1,300');
    expect(dialog.textContent).not.toContain('GY$');
    expect(sessionStorage.getItem('swift_storefront_add')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close item options' }));
    resumed.unmount();
    render(await page());
    await waitFor(() => expect(customer.getCart).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(customer.addToCart).not.toHaveBeenCalled();
  });

  it('submits only the restored available choice IDs to this store', async () => {
    signedInWithOptions();
    sessionStorage.setItem('swift_storefront_add', JSON.stringify(savedIntent));
    render(await page());
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /^Add to order/ }));
    await waitFor(() => expect(customer.addToCart).toHaveBeenCalledExactlyOnceWith({ vendorId: store.id, itemId: 'roti', quantity: 1, selectedOptions: { filling: 'chickpea' } }));
  });

  it('does not substitute another store for the saved store', async () => {
    signedInWithOptions();
    sessionStorage.setItem('swift_storefront_add', JSON.stringify({ ...savedIntent, storeSlug: 'other-store', returnPath: '/store/other-store' }));
    render(await page());
    await waitFor(() => expect(customer.getCart).toHaveBeenCalledOnce());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(customer.addToCart).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('swift_storefront_add')).not.toBeNull();
  });

  it.each(['sold-out', 'closed', 'removed', 'price-missing', 'pickup'])('does not resume an item that is now %s', async change => {
    const vendor = signedInWithOptions();
    const item = vendor.categories[0]!.items[0]!;
    if (change === 'sold-out') item.isAvailable = false;
    if (change === 'closed') vendor.isCurrentlyOpen = false;
    if (change === 'removed') vendor.categories[0]!.items = [];
    if (change === 'price-missing') item.basePrice = NaN;
    if (change === 'pickup') item.fulfillment = 'PICKUP';
    sessionStorage.setItem('swift_storefront_add', JSON.stringify(savedIntent));
    render(await page());
    await screen.findByText('This item is not available to order right now. Please check the menu.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(customer.addToCart).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('swift_storefront_add')).toBeNull();
  });

  it('drops a saved choice that is no longer available and requires a new selection', async () => {
    const vendor = signedInWithOptions();
    vendor.categories[0]!.items[0]!.optionGroups = [{ ...filling, options: filling.options.map(option => ({ ...option, isAvailable: option.id !== 'chickpea' })) }];
    sessionStorage.setItem('swift_storefront_add', JSON.stringify(savedIntent));
    render(await page());
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /^Add to order/ }));
    expect(await screen.findByText('Choose an option for Filling.')).toBeTruthy();
    expect(customer.addToCart).not.toHaveBeenCalled();
  });

  it('cancels the saved Add from the actual sign-in page', async () => {
    sessionStorage.setItem('swift_storefront_add', JSON.stringify(savedIntent));
    render(<LoginPage />);
    fireEvent.click(await screen.findByRole('link', { name: 'Cancel and return to menu' }));
    expect(sessionStorage.getItem('swift_storefront_add')).toBeNull();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import styles from './storefront.module.css';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import StorePage from '@/app/store/[slug]/page';
import type { StorefrontDetail } from '@/lib/api';
import * as api from '@/lib/api';
import * as customer from '@/lib/customer';
import * as auth from '@/lib/auth';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, notFound: () => { throw new Error('not found'); } }));

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
  sessionStorage.clear();
  nav.push.mockReset();
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
    expect(html).toContain('powered by Swift');
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
    const cartLinks = screen.getAllByRole('link', { name: /Your order/ });
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
    expect(screen.getAllByRole('link', { name: /Your order/ }).length).toBeGreaterThan(0);
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
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(await page({ src: 'qr' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss dining-in message' }));
    expect(screen.queryByRole('button', { name: 'Dismiss dining-in message' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Menu' })).toBe(document.activeElement);
  });

  it('lets a guest start an order and returns sign-in to the same scanned store', async () => {
    render(await page({ src: 'qr', c: 'BCDFGHJKMN', t: 'card' }));
    const add = await screen.findByRole('button', { name: /Add Pumpkin roti/ });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);
    expect(nav.push).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/store/garden-kitchen?src=qr&c=BCDFGHJKMN&t=card')}`);
    expect(customer.addToCart).not.toHaveBeenCalled();
  });

  it('places an order from the scanned menu after sign-in, without the banner blocking checkout', async () => {
    vi.mocked(auth.sessionProbe).mockResolvedValue({ ok: true });
    const cart: customer.Cart = {
      items: [{ id: 'line', itemId: 'roti', name: 'Pumpkin roti', quantity: 1, customerPrice: 800, isAvailable: true, fulfillment: 'DELIVERY' }],
      vendor: { id: store.id, name: store.name, isCurrentlyOpen: true, acceptingOrders: true },
      deliveryAddress: { id: 'address' }, subtotalCustomer: 800, deliveryFee: 200, totalAmount: 1000,
    };
    vi.mocked(customer.getCart).mockResolvedValueOnce({ items: [] }).mockResolvedValue(cart);
    vi.mocked(customer.addToCart).mockResolvedValue(cart);
    vi.spyOn(customer, 'getAddresses').mockResolvedValue([{ id: 'address', label: 'Home', addressLine1: 'Example Street', city: 'Georgetown', isDefault: true }]);
    vi.spyOn(customer, 'setCartAddress').mockResolvedValue(cart);
    vi.spyOn(customer, 'checkout').mockResolvedValue({ order: { id: 'qr-order' } });
    render(await page({ src: 'qr' }));
    const add = await screen.findByRole('button', { name: /Add Pumpkin roti/ });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);
    expect(customer.addToCart).toHaveBeenCalledWith({ vendorId: store.id, itemId: 'roti', quantity: 1 });
    const place = await screen.findByRole('button', { name: 'Place cash order' });
    await waitFor(() => expect((place as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(place);
    await waitFor(() => expect(customer.checkout).toHaveBeenCalledWith({ paymentMethod: 'CASH', tipAmount: 0 }, expect.any(String)));
    expect(nav.push).toHaveBeenCalledWith('/orders/qr-order');
    expect(screen.getByText(copy)).toBeTruthy();
  });
});

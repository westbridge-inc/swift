import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => {
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

  it('dismisses without removing the reserved space or covering menu/cart', async () => {
    render(await page({ src: 'qr' }));
    const dismiss = screen.getByRole('button', { name: 'Dismiss dining-in message' });
    const slot = dismiss.parentElement!;
    expect(slot.style.position).not.toMatch(/fixed|absolute/);
    fireEvent.click(dismiss);
    expect(slot.isConnected).toBe(true);
    expect(slot.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Dismiss dining-in message' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Menu' })).toBe(document.activeElement);
    expect(screen.getAllByRole('link', { name: /Your order/ }).length).toBeGreaterThan(0);
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

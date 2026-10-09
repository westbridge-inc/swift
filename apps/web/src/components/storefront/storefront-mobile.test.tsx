import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorefrontExperience } from './storefront-experience';
import * as auth from '@/lib/auth';
import * as customer from '@/lib/customer';
import type { StorefrontDetail } from '@/lib/api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const store: StorefrontDetail = {
  id: 'test-store', slug: 'test-kitchen', name: 'Test Kitchen', description: null,
  vendorType: 'RESTAURANT', logoUrl: null, coverImageUrl: null, city: 'Georgetown', region: 'Demerara',
  cuisineTypes: [], tags: [], displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false,
  isCurrentlyOpen: true, acceptingOrders: true, estimatedPrepTime: 20, minOrderAmount: 0, isFeatured: false,
  addressLine1: 'Test street', operatingHours: [],
  categories: [{ id: 'lunch', name: 'Lunch', items: [
    { id: 'roti', name: 'Pumpkin roti', description: null, basePrice: 800,
      imageUrl: '/test-roti.jpg', unit: null, isPopular: false, fulfillment: 'DELIVERY' },
    { id: 'soup', name: 'Soup', description: null, basePrice: 600,
      imageUrl: null, unit: null, isPopular: false, fulfillment: 'DELIVERY' },
  ] }],
};
const vendor = { ...store, description: undefined, categories: store.categories.map(category => ({
  ...category, items: category.items.map(item => ({ ...item, description: undefined, isAvailable: true })),
})) };
type IntersectionReport = (_entries: Array<Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>>) => void;
let intersect: IntersectionReport | undefined;
const observe = vi.fn();
const disconnect = vi.fn();
const scrollIntoView = vi.fn();
const page = () => <StorefrontExperience store={store} returnPath="/store/test-kitchen" />;
const panel = () => screen.getByRole('complementary', { name: 'Your order and checkout' });
const dock = () => screen.queryByRole('link', { name: /View your order/ });
const reportIntersection = (isIntersecting: boolean) => act(() => {
  if (!intersect) throw new Error('Checkout observer was not installed');
  intersect([{ target: panel(), isIntersecting }]);
});

beforeEach(() => {
  intersect = undefined;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionReport) { intersect = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(scrollIntoView);
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
  vi.spyOn(auth, 'sessionProbe').mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof auth.sessionProbe>>);
  vi.spyOn(customer, 'getPublicStorefront').mockResolvedValue(store);
  vi.spyOn(customer, 'getPublicVendor').mockResolvedValue(vendor);
  vi.spyOn(customer, 'getAddresses').mockResolvedValue([]);
  vi.spyOn(customer, 'getCart').mockResolvedValue({
    vendor: { id: store.id, name: store.name },
    items: [{ id: 'line', itemId: 'roti', name: 'Pumpkin roti', quantity: 1, customerPrice: 800, fulfillment: 'DELIVERY' }],
    subtotal: 800, totalAmount: 800,
  });
});

async function renderCart() {
  const view = render(page());
  await waitFor(() => expect(screen.getByRole('link', { name: /Your order, 1 items/ })).toBeTruthy());
  return view;
}

describe('storefront mobile checkout access', () => {
  it('hides the dock until visibility is known, shows it off screen, hides it for any visible panel, and disconnects', async () => {
    const view = await renderCart();
    expect(dock()).toBeNull();
    expect(observe).toHaveBeenCalledWith(panel());
    reportIntersection(false);
    expect(dock()).not.toBeNull();
    reportIntersection(true);
    expect(dock()).toBeNull();
    expect(within(panel()).getByRole('button', { name: 'Place cash order' })).toBeTruthy();
    reportIntersection(false);
    expect(dock()).not.toBeNull();
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it.each([false, true])('both links scroll and focus the order heading on every tap (reduced motion: %s)', async reducedMotion => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: reducedMotion } as MediaQueryList);
    await renderCart();
    if (intersect) reportIntersection(false);
    const heading = within(panel()).getByRole('heading', { level: 2 });
    const focus = vi.spyOn(heading, 'focus');
    const basket = screen.getByRole('link', { name: /Your order, 1 items/ });
    for (const link of [dock()!, basket, basket]) {
      link.focus();
      fireEvent.click(link);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' });
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(panel());
      expect(document.activeElement).toBe(heading);
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    }
    expect(scrollIntoView).toHaveBeenCalledTimes(3);
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    if (intersect) reportIntersection(true);
    basket.focus();
    fireEvent.click(basket);
    expect(scrollIntoView).toHaveBeenCalledTimes(4);
    expect(document.activeElement).toBe(heading);
  });

  it('supports Enter from the basket link with the heading outside the tab order', async () => {
    await renderCart();
    const basket = screen.getByRole('link', { name: /Your order, 1 items/ });
    basket.focus();
    await userEvent.keyboard('{Enter}');
    const heading = within(panel()).getByRole('heading', { level: 2 });
    expect(document.activeElement).toBe(heading);
    expect(heading.tabIndex).toBe(-1);
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it('server-renders without browser observers and keeps checkout usable if the observer is unavailable', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    expect(renderToString(page())).toContain('id="checkout"');
    await renderCart();
    expect(dock()).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: /Your order, 1 items/ }));
    expect(document.activeElement).toBe(within(panel()).getByRole('heading', { level: 2 }));
  });

  it('retains measured clearance when the dock hides and updates it when text wraps', async () => {
    let resize: () => void = () => {};
    let height = 64;
    const stop = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe = vi.fn();
      disconnect = stop;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height }) as DOMRect);
    const view = await renderCart();
    reportIntersection(false);
    const clearance = () => view.container.querySelector('main')!.style.getPropertyValue('--swift-order-dock-height');
    expect(clearance()).toBe('64px');
    height = 96;
    act(resize);
    expect(clearance()).toBe('96px');
    reportIntersection(true);
    expect(clearance()).toBe('96px');
    expect(stop).toHaveBeenCalledOnce();
    const css = readFileSync(`${process.cwd()}/src/components/storefront/storefront.module.css`, 'utf8');
    expect(css).toMatch(/padding-block-end: calc\(var\(--swift-order-dock-height\).*env\(safe-area-inset-bottom, 0\)\)/);
    expect(css).toMatch(/\.rail\s*\{[^}]*scroll-margin-block-start:/);
    expect(css).toMatch(/\.railTitle:focus\s*\{[^}]*outline:/);
  });
});

describe('storefront item photo fallback', () => {
  it('replaces a failed photo with the same Swift pictogram tile used when no photo exists', async () => {
    await renderCart();
    const roti = screen.getByRole('heading', { name: 'Pumpkin roti' }).closest('article')!;
    const soup = screen.getByRole('heading', { name: 'Soup' }).closest('article')!;
    // The row also has an add button icon; the tile is its decorative final child.
    const tile = soup.lastElementChild!;
    expect(tile.getAttribute('aria-hidden')).toBe('true');
    expect(tile.querySelector('svg path')).not.toBeNull();
    expect(soup.querySelector('img')).toBeNull();
    fireEvent.error(within(roti).getByRole('img', { name: 'Pumpkin roti' }));
    expect(roti.querySelector('img')).toBeNull();
    expect(roti.lastElementChild?.outerHTML).toBe(tile.outerHTML);
  });

  it('tries a replacement photo after the live menu changes its URL', async () => {
    const interval = vi.spyOn(window, 'setInterval');
    await renderCart();
    fireEvent.error(screen.getByRole('img', { name: 'Pumpkin roti' }));
    expect(screen.queryByRole('img', { name: 'Pumpkin roti' })).toBeNull();
    vi.mocked(customer.getPublicVendor).mockResolvedValue({ ...vendor, categories: vendor.categories.map(category => ({
      ...category, items: category.items.map(item => item.id === 'roti' ? { ...item, imageUrl: '/replacement.jpg' } : item),
    })) });
    await act(async () => { (interval.mock.calls.find(([, delay]) => delay === 30_000)![0] as () => void)(); });
    expect((screen.getByRole('img', { name: 'Pumpkin roti' }) as HTMLImageElement).src)
      .toBe(new URL('/replacement.jpg', window.location.href).href);
  });
});

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorefrontExperience } from './storefront-experience';
import * as auth from '@/lib/auth';
import * as customer from '@/lib/customer';
import type { StorefrontDetail } from '@/lib/api';
import { swiftDesignVariables } from '@/lib/design-tokens';

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
// [W4] The floating button is one tap to the one checkout page.
const dock = () => screen.queryByRole('link', { name: /^Checkout · \d+ item/ });
const reportIntersection = (isIntersecting: boolean) => act(() => {
  if (!intersect) throw new Error('Checkout observer was not installed');
  intersect([{ target: panel(), isIntersecting }]);
});
// A busy main thread can queue several crossings of the panel edge; the browser then delivers
// them oldest first in ONE callback.
const reportCrossings = (...crossings: boolean[]) => act(() => {
  if (!intersect) throw new Error('Checkout observer was not installed');
  intersect(crossings.map(isIntersecting => ({ target: panel(), isIntersecting })));
});
// Every `@media <query> { … }` block of a stylesheet, brace-matched.
const mediaBlocks = (css: string, query: string) => {
  const blocks: string[] = [];
  for (let at = css.indexOf(`@media ${query} {`); at >= 0; at = css.indexOf(`@media ${query} {`, at + 1)) {
    const open = css.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (; end < css.length; end += 1) {
      if (css[end] === '{') depth += 1;
      if (css[end] === '}' && --depth === 0) break;
    }
    blocks.push(css.slice(open + 1, end));
  }
  return blocks;
};
const tokenPx = (name: `--${string}`) => Number.parseFloat(String(swiftDesignVariables[name]));

beforeEach(() => {
  intersect = undefined;
  // [W6] The one store page also watches its menu sections (to mark the chip
  // being read). Only the observer watching the order panel is driven and
  // counted here.
  vi.stubGlobal('IntersectionObserver', class {
    private watchesPanel = false;
    private readonly report: IntersectionReport;
    constructor(callback: IntersectionReport) { this.report = callback; }
    observe = (target: Element) => {
      observe(target);
      if (target.id === 'checkout') { this.watchesPanel = true; intersect = this.report; }
    };
    disconnect = () => { if (this.watchesPanel) disconnect(); };
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
  vi.spyOn(customer, 'addToCart').mockResolvedValue(undefined as never);
});

// [W6] The one store page sits inside the app's frame, so it has no store
// top bar and no top-bar order link. The order has loaded once its line is in
// the order panel.
async function renderCart() {
  const view = render(page());
  await waitFor(() => expect(within(panel()).getByText('1× Pumpkin roti')).toBeTruthy());
  return view;
}

// [W4] This page's other way to checkout (besides the floating button): the
// "Checkout" link of the notice an Add shows.
async function checkoutNoticeLink() {
  const add = await screen.findByRole('button', { name: 'Add Soup' });
  await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(add);
  return screen.findByRole('link', { name: 'Checkout' });
}
// [W4] The order panel's own way on: its Checkout button.
const panelCheckout = () => within(panel()).getByRole('button', { name: /^Checkout · / });

describe('storefront mobile checkout access', () => {
  it('hides the dock until visibility is known, shows it off screen, hides it for any visible panel, and disconnects', async () => {
    const view = await renderCart();
    expect(dock()).toBeNull();
    expect(observe).toHaveBeenCalledWith(panel());
    reportIntersection(false);
    expect(dock()).not.toBeNull();
    reportIntersection(true);
    expect(dock()).toBeNull();
    expect(panelCheckout()).toBeTruthy();
    reportIntersection(false);
    expect(dock()).not.toBeNull();
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  // [W4] The order is placed on the one checkout page, so the store page's
  // links go there instead of scrolling to the order panel (#1590's scroll
  // and focus on tap, and its reduced-motion scroll checks, have nothing to
  // act on here).
  it('both links go to the one checkout page', async () => {
    await renderCart();
    reportIntersection(false);
    expect(dock()!.getAttribute('href')).toBe('/checkout');
    expect((await checkoutNoticeLink()).getAttribute('href')).toBe('/checkout');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('server-renders without browser observers and keeps checkout usable if the observer is unavailable', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    expect(renderToString(page())).toContain('id="checkout"');
    await renderCart();
    expect(dock()).toBeNull();
    expect((panelCheckout() as HTMLButtonElement).disabled).toBe(false);
    expect((await checkoutNoticeLink()).getAttribute('href')).toBe('/checkout');
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
    // [W6] The app's frame owns <main>; the store page's own root carries the measurement.
    const clearance = () => (view.container.firstElementChild as HTMLElement).style.getPropertyValue('--swift-order-dock-height');
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

  it('measures the dock again when it comes back after an item’s sheet closes', async () => {
    let height = 64;
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height }) as DOMRect);
    // [W6] A link that names an item opens its sheet; the dock waits while it is open.
    const view = render(<StorefrontExperience store={store} returnPath="/store/test-kitchen" initialItemId="soup" />);
    const sheet = await screen.findByRole('dialog', { name: 'Soup' });
    const orderPanel = document.getElementById('checkout')!;
    await waitFor(() => expect(orderPanel.textContent).toContain('1× Pumpkin roti'));
    act(() => intersect!([{ target: orderPanel, isIntersecting: false }]));
    expect(dock()).toBeNull();
    height = 80;
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close item options' }));
    await waitFor(() => expect(dock()).not.toBeNull());
    expect((view.container.firstElementChild as HTMLElement).style.getPropertyValue('--swift-order-dock-height')).toBe('80px');
  });

  it('follows the latest crossing when one observer callback reports several, so the dock never sits over a visible panel', async () => {
    await renderCart();
    // Panel scrolled away and back before the callback ran: it is on screen now.
    reportCrossings(false, true);
    expect(dock()).toBeNull();
    expect(panelCheckout()).toBeTruthy();
    // Scrolled in and out again: it is off screen now, so the dock returns.
    reportCrossings(true, false);
    expect(dock()).not.toBeNull();
    reportCrossings(false, true, false, true);
    expect(dock()).toBeNull();
  });

  it('lands the order panel below the phone header and the stuck category bar', () => {
    const css = readFileSync(`${process.cwd()}/src/components/storefront/storefront.module.css`, 'utf8');
    // [W6] One column (the phone layout) starts at 68.75em on the one store page.
    const phone = mediaBlocks(css, '(max-width: 68.75em)').join('\n');
    const phoneRail = phone.match(/(?:^|\n)\s*\.rail\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(phoneRail).toMatch(/scroll-margin-block-start:\s*var\(--swift-section-scroll\);/);
    // [W6] Inside the app's frame nothing sits above the store's category bar
    // on a phone (no store header; the app's tabs are at the bottom). The bar
    // sticks at the top: a touch-size link, md padding above and below, a rule.
    expect(css).toMatch(/\.categoryNav\s*\{[^}]*position:\s*sticky;[^}]*inset-block-start:\s*0;[^}]*padding-block:\s*var\(--swift-space-md\);/);
    const stuckChrome = tokenPx('--swift-touch') + 2 * tokenPx('--swift-space-md') + 1;
    expect(tokenPx('--swift-section-scroll')).toBeGreaterThan(stuckChrome);
    // And the panel never lands higher than the menu sections do.
    const section = css.match(/(?:^|\n)\.section\s*\{[^}]*scroll-margin-block-start:\s*calc\(var\(--swift-touch\) \+ var\(--swift-space-2xl\)\);/);
    expect(section).not.toBeNull();
    expect(tokenPx('--swift-section-scroll')).toBeGreaterThanOrEqual(tokenPx('--swift-touch') + tokenPx('--swift-space-2xl'));
  });

  it('announces the order panel’s heading to screen readers as the order, with the visible title unchanged', async () => {
    await renderCart();
    const heading = within(panel()).getByRole('heading', { level: 2, name: 'Your order, Test Kitchen' });
    expect(heading.tabIndex).toBe(-1);
    const prefix = heading.querySelector('.sr-only');
    expect(prefix?.textContent).toBe('Your order, ');
    expect(heading.textContent?.slice(prefix?.textContent?.length ?? 0)).toBe('Test Kitchen');
  });
});

describe('storefront item photo fallback', () => {
  it('replaces a failed photo with the same Swift pictogram tile used when no photo exists', async () => {
    await renderCart();
    const roti = screen.getByRole('heading', { name: 'Pumpkin roti' }).closest('article')!;
    const soup = screen.getByRole('heading', { name: 'Soup' }).closest('article')!;
    // The row also has an add button icon; the tile is its decorative final child
    // ([W6] the app's shared photo placeholder: no text, and its pictogram is hidden).
    const tile = soup.lastElementChild!;
    expect(tile.textContent).toBe('');
    expect(tile.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
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
    // [W2b, #1523] A bare path is drawn from the API's origin, as the phone app does.
    expect((screen.getByRole('img', { name: 'Pumpkin roti' }) as HTMLImageElement).src)
      .toBe('http://vendor-api.test/replacement.jpg');
  });
});

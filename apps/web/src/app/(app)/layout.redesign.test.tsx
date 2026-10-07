import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiReply, type ApiRequest } from '@/test/test-utils';
import AppLayout from './layout';
import { StorefrontPage } from '@/components/storefront/storefront-page';
import { storefrontFixture } from '@/test/storefront-fixture';

const state = vi.hoisted(() => ({ pathname: '/', params: {} as Record<string, string>, push: vi.fn(), back: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useParams: () => state.params,
  useRouter: () => ({ push: state.push, back: state.back, replace: state.replace }),
}));

// ---------------------------------------------------------------------------
// [WEB-REDESIGN] The owner's design (4 Oct 2026) is ONE responsive app: below
// 760 px the phone layout with a bottom dock; from 760 px a side rail with
// the same four places, the cart count, a "Switch app" card and the person
// signed in. These pin that shell — its breakpoint, its badge, which place is
// lit, and Switch app — and the cart count's wiring to the account's cart.
// ---------------------------------------------------------------------------

const WEB_ROOT = join(__dirname, '..', '..', '..');

let signedIn = true;
let cartLines: Array<{ id: string; itemId: string; name: string; quantity: number; customerPrice: number }> = [];
let cartFails = false;
let api: (_request: ApiRequest) => ApiReply | null = () => null;
let fetchMock: ReturnType<typeof mockApi>;
const ok = (data: unknown) => ({ body: { success: true, data } });
const calls = (pathname: string) => fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname === pathname);

const STORE = {
  id: 'v1', name: 'Shanta Kitchen', slug: 'shanta-kitchen', vendorType: 'RESTAURANT', cuisineTypes: [], coverImageUrl: null,
  displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false, estimatedPrepTime: 20,
  isCurrentlyOpen: true, acceptingOrders: true,
  categories: [{ id: 'c1', name: 'Mains', items: [{ id: 'i1', name: 'Pepperpot bowl', basePrice: 1800, customerPrice: 1800, isAvailable: true, fulfillment: 'DELIVERY', optionGroups: [] }] }],
};

beforeEach(async () => {
  (await import('@/lib/auth')).clearSession();
  window.history.replaceState({}, '', '/');
  state.pathname = '/';
  state.params = {};
  signedIn = true;
  cartFails = false;
  cartLines = [
    { id: 'l1', itemId: 'i1', name: 'Pepperpot bowl', quantity: 1, customerPrice: 1800 },
    { id: 'l2', itemId: 'i2', name: 'Mauby', quantity: 2, customerPrice: 400 },
  ];
  api = () => null;
  fetchMock = mockApi((request) => {
    const special = api(request);
    if (special) return special;
    const { url, method } = request;
    if (url.pathname === '/api/v1/auth/me') return signedIn ? ok({ user: { id: 'c1' } }) : { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/auth/refresh') return { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/market/depth') return ok({ visible: true, items: 400, vendors: 9 });
    if (url.pathname === '/api/v1/customer/profile') return ok({ id: 'c1', firstName: 'Devi', lastName: 'Persaud', phone: '+5926001234', email: null });
    if (url.pathname === '/api/v1/customer/cart' && method === 'GET') {
      return cartFails ? { status: 500, body: { success: false } } : ok({ items: cartLines, subtotalCustomer: 2600 });
    }
    if (url.pathname === '/api/v1/public/storefronts/shanta-kitchen') return ok(storefrontFixture(STORE));
    if (url.pathname === '/api/v1/customer/addresses') return ok([]);
    if (url.pathname === '/api/v1/customer/vendors/v1') return ok(STORE);
    if (url.pathname === '/api/v1/customer/cart/items/l1' && method === 'PUT') {
      cartLines = cartLines.map((line) => (line.id === 'l1' ? { ...line, quantity: line.quantity + 1 } : line));
      return ok({});
    }
    if (url.pathname === '/api/v1/customer/cart/items' && method === 'POST') {
      cartLines = [...cartLines, { id: 'l3', itemId: 'i1', name: 'Pepperpot bowl', quantity: 1, customerPrice: 1800 }];
      return { status: 201, body: { success: true, data: {} } };
    }
    return { status: 404, body: { success: false } };
  });
});

function shell(pathname: string, page: React.ReactNode = <p>Page</p>) {
  state.pathname = pathname;
  return render(<AppLayout>{page}</AppLayout>);
}

const rail = () => screen.getByRole('navigation', { name: 'Swift sections' });
const dock = () => screen.getByRole('navigation', { name: 'Swift tabs' });

describe('[WEB-REDESIGN] one app, two layouts at 760 px', () => {
  it('draws the side rail from 760 px and the bottom dock below it — the same places in both', async () => {
    shell('/');
    await screen.findByText('Page');
    // The rail lives in the header: hidden on phones, a column from `wide:`.
    const header = rail().closest('header')!;
    expect(header.className.split(' ')).toEqual(expect.arrayContaining(['hidden', 'wide:flex']));
    // The dock is fixed to the bottom and leaves at `wide:`.
    expect(dock().className.split(' ')).toEqual(expect.arrayContaining(['fixed', 'bottom-0', 'wide:hidden']));
    // `wide:` is 760 px (47.5rem), declared once for the whole site.
    const css = readFileSync(join(WEB_ROOT, 'src/app/globals.css'), 'utf8');
    expect(css).toMatch(/--breakpoint-wide:\s*47\.5rem/);
    await waitFor(() => expect(within(rail()).getAllByRole('link').map((link) => link.textContent)).toEqual(expect.arrayContaining(['Home', 'Market', 'Profile'])));
    const places = (nav: HTMLElement) => within(nav).getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(places(rail())).toEqual(['/', '/market', '/cart', '/account']);
    expect(places(dock())).toEqual(['/', '/market', '/cart', '/account']);
  });

  it('lights the page’s own place in the rail and the dock, and only that one', async () => {
    shell('/cart');
    await screen.findByText('Page');
    for (const nav of [rail(), dock()]) {
      expect(within(nav).getByRole('link', { name: /^Cart/ }).getAttribute('aria-current')).toBe('page');
      expect(within(nav).getByRole('link', { name: /^Home/ }).getAttribute('aria-current')).toBeNull();
    }
  });

  it('lights Profile for an order being tracked', async () => {
    shell('/orders/o1');
    await screen.findByText('Page');
    expect(within(rail()).getByRole('link', { name: /^Profile/ }).getAttribute('aria-current')).toBe('page');
    expect(within(dock()).getByRole('link', { name: /^Profile/ }).getAttribute('aria-current')).toBe('page');
  });
});

describe('[WEB-REDESIGN] the cart count', () => {
  it('shows how many things are in the account’s cart — the quantities, not the lines — in the rail and the dock', async () => {
    shell('/');
    await waitFor(() => expect(within(rail()).getByLabelText('3 in your cart').textContent).toBe('3'));
    expect(within(dock()).getByLabelText('3 in your cart').textContent).toBe('3');
  });

  it('shows no count for a guest, and never asks for a cart', async () => {
    signedIn = false;
    shell('/');
    await waitFor(() => expect(calls('/api/v1/auth/me')).toHaveLength(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByLabelText(/in your cart/)).toBeNull();
    expect(calls('/api/v1/customer/cart')).toHaveLength(0);
  });

  it('shows no count — never a made-up one — when the cart cannot be read', async () => {
    cartFails = true;
    shell('/');
    await waitFor(() => expect(calls('/api/v1/customer/cart').length).toBeGreaterThan(0));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByLabelText(/in your cart/)).toBeNull();
  });

  it('shows no count for an empty cart', async () => {
    cartLines = [];
    shell('/');
    await waitFor(() => expect(calls('/api/v1/customer/cart').length).toBeGreaterThan(0));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByLabelText(/in your cart/)).toBeNull();
  });

  it('moves when something is added at a store', async () => {
    // [W6] The store's one page; an item with no choice to make is one tap.
    shell('/store/shanta-kitchen', await StorefrontPage({ params: Promise.resolve({ slug: 'shanta-kitchen' }), searchParams: Promise.resolve({}) }));
    await waitFor(() => expect(within(rail()).getByLabelText('3 in your cart')).toBeTruthy());
    const add = await screen.findByRole('button', { name: 'Add another Pepperpot bowl' });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);
    await waitFor(() => expect(within(rail()).getByLabelText('4 in your cart').textContent).toBe('4'));
    expect(within(dock()).getByLabelText('4 in your cart')).toBeTruthy();
  });
});

describe('[WEB-REDESIGN] Switch app and the person signed in', () => {
  it('opens Switch app from the rail: the other Swift apps this account can open on the web', async () => {
    shell('/');
    await screen.findByText('Page');
    fireEvent.click(screen.getByRole('button', { name: /Switch app/ }));
    const sheet = screen.getByRole('dialog', { name: 'Switch app' });
    expect(within(sheet).getByRole('link', { name: /Swift Business/ }).getAttribute('href')).toBe('/dashboard');
    expect(within(sheet).getByRole('link', { name: /Swift Driver/ }).getAttribute('href')).toBe('/portal');
    // Advertising has no web console: it says so, and is not a dead link.
    expect(within(sheet).queryByRole('link', { name: /Swift Ads/ })).toBeNull();
    expect(within(sheet).getByText(/Advertising is managed in the Swift app/)).toBeTruthy();
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Switch app' })).toBeNull();
  });

  it('names the person at the foot of the rail, and offers sign-in to a guest instead', async () => {
    const view = shell('/');
    expect(await screen.findByText('Devi Persaud')).toBeTruthy();
    expect(screen.getByText('+5926001234')).toBeTruthy();
    view.unmount();
    (await import('@/lib/auth')).clearSession();
    signedIn = false;
    shell('/');
    const header = rail().closest('header')!;
    await waitFor(() => expect(within(header).getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login?next=%2F'));
    expect(screen.queryByText('Devi Persaud')).toBeNull();
  });
});

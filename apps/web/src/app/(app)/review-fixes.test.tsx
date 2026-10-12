import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiReply, type ApiRequest } from '@/test/test-utils';
import AppLayout from './layout';
import { StorefrontPage } from '@/components/storefront/storefront-page';
import { storefrontFixture } from '@/test/storefront-fixture';
import CartPage from './cart/page';
import FavouritesPage from './account/favourites/page';

const state = vi.hoisted(() => ({ pathname: '/', params: {} as Record<string, string>, push: vi.fn(), back: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useParams: () => state.params,
  useRouter: () => ({ push: state.push, back: state.back, replace: state.replace }),
  useSearchParams: () => new URLSearchParams(),
}));

// ---------------------------------------------------------------------------
// [WEB-REDESIGN · different-model review] The S2/S3 findings on #1433, each
// pinned against the real shell and the real API contract. [W6] The store is
// its one page now, /store/<slug>, inside the app's frame.
// ---------------------------------------------------------------------------

const STORE = {
  id: 'v1', name: 'Shanta Kitchen', slug: 'shanta-kitchen', vendorType: 'RESTAURANT', cuisineTypes: [], coverImageUrl: null,
  displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false, estimatedPrepTime: 20,
  isCurrentlyOpen: true, acceptingOrders: true,
  categories: [{ id: 'c1', name: 'Mains', items: [{ id: 'i1', name: 'Pepperpot bowl', basePrice: 1800, customerPrice: 1800, isAvailable: true, fulfillment: 'DELIVERY', optionGroups: [] }] }],
};

let favourites: Array<{ id: string; name: string }> = [];
let storeReply: ApiReply | Promise<ApiReply> | null = null;
let cartReply: ApiReply | Promise<ApiReply> | null = null;
let fetchMock: ReturnType<typeof mockApi>;
const ok = (data: unknown) => ({ body: { success: true, data } });
const writes = () => fetchMock.mock.calls
  .map(([url, init]) => [(init?.method ?? 'GET').toUpperCase(), new URL(String(url)).pathname] as const)
  .filter(([method, path]) => method !== 'GET' && method !== 'OPTIONS' && path.startsWith('/api/v1/customer/favorites'));

beforeEach(async () => {
  (await import('@/lib/auth')).clearSession();
  window.history.replaceState({}, '', '/');
  favourites = [{ id: 'v1', name: 'Shanta Kitchen' }];
  storeReply = null;
  cartReply = null;
  fetchMock = mockApi(({ url, method }: ApiRequest) => {
    if (url.pathname === '/api/v1/auth/me') return ok({ user: { id: 'c1' } });
    if (url.pathname === '/api/v1/auth/refresh') return { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/market/depth') return ok({ visible: false, items: 0, vendors: 0 });
    if (url.pathname === '/api/v1/customer/profile') return ok({ id: 'c1', firstName: 'Devi', lastName: 'P', phone: '+5926001234', email: null });
    if (url.pathname === '/api/v1/customer/favorites' && method === 'GET') return ok(favourites);
    if (url.pathname === '/api/v1/customer/favorites/v1' && method === 'POST') { favourites = [...favourites, { id: 'v1', name: 'Shanta Kitchen' }]; return ok({}); }
    if (url.pathname === '/api/v1/customer/favorites/v1' && method === 'DELETE') { favourites = favourites.filter((f) => f.id !== 'v1'); return ok({}); }
    if (url.pathname === '/api/v1/public/storefronts/shanta-kitchen') return ok(storefrontFixture(STORE));
    if (url.pathname === '/api/v1/customer/vendors/v1') return storeReply ?? ok(STORE);
    if (url.pathname === '/api/v1/customer/cart' && method === 'GET') return cartReply ?? ok({ items: [] });
    if (url.pathname === '/api/v1/customer/addresses') return ok([]);
    return { status: 404, body: { success: false } };
  });
});

/** The store's one page, as the server draws it. */
const storePage = () => StorefrontPage({ params: Promise.resolve({ slug: 'shanta-kitchen' }), searchParams: Promise.resolve({}) });

function go(view: ReturnType<typeof render> | null, pathname: string, params: Record<string, string>, page: React.ReactNode) {
  state.pathname = pathname;
  state.params = params;
  if (!view) return render(<AppLayout>{page}</AppLayout>);
  view.rerender(<AppLayout>{page}</AppLayout>);
  return view;
}

describe('[review S2] the store’s heart and Account’s favourites are one source', () => {
  it('a favourite removed in Account is shown — and saved, not removed again — back at the store', async () => {
    let view = go(null, '/store/shanta-kitchen', {}, await storePage());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove from favourites' }).getAttribute('aria-pressed')).toBe('true'));

    view = go(view, '/account/favourites', {}, <FavouritesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Shanta Kitchen from favourites' }));
    await screen.findByText('No favourites yet. Save a store with its heart.');

    go(view, '/store/shanta-kitchen', {}, await storePage());
    const heart = await screen.findByRole('button', { name: 'Save to favourites' });
    await waitFor(() => expect(heart.getAttribute('aria-pressed')).toBe('false'));
    await waitFor(() => expect((heart as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(heart);
    await screen.findByText('Saved to favourites');
    expect(writes()).toEqual([['DELETE', '/api/v1/customer/favorites/v1'], ['POST', '/api/v1/customer/favorites/v1']]);
  });

  it('never sends a write chosen from a stale list: it reads the list again first', async () => {
    go(null, '/store/shanta-kitchen', {}, await storePage());
    const heart = await screen.findByRole('button', { name: 'Remove from favourites' });
    await waitFor(() => expect((heart as HTMLButtonElement).disabled).toBe(false));
    // Removed elsewhere (another tab) after this page read its list.
    favourites = [];
    fireEvent.click(heart);
    await screen.findByText('Removed from favourites');
    // The person wanted it removed, and it already was: nothing is written.
    expect(writes()).toEqual([]);
  });
});

describe('[review S3] Back never disappears while a page is loading, failed or empty', () => {
  it('the store, while it loads and when it fails', async () => {
    // The page arrives with the store drawn by the server; the browser then
    // checks the live menu. While that check is out, and when it fails, Back
    // stays, the store stays readable, and ordering waits.
    let fail: (_reply: ApiReply) => void = () => undefined;
    storeReply = new Promise<ApiReply>((resolve) => { fail = resolve; });
    go(null, '/store/shanta-kitchen', {}, await storePage());
    await screen.findByText('Checking this live menu’s required choices before ordering…');
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    await act(async () => { fail({ status: 503, body: { success: false, error: { message: 'busy' } } }); });
    await screen.findByText(/Swift could not verify its required choices/, {}, { timeout: 4000 });
    expect(screen.getByRole('heading', { level: 1, name: 'Shanta Kitchen' })).toBeTruthy();
    expect((screen.getByRole('button', { name: /Pepperpot bowl unavailable/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
  });

  it('the cart, while it loads and when it is empty', async () => {
    let answer: (_reply: ApiReply) => void = () => undefined;
    cartReply = new Promise<ApiReply>((resolve) => { answer = resolve; });
    go(null, '/cart', {}, <CartPage />);
    await screen.findByLabelText('Loading your cart');
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    await act(async () => { answer(ok({ items: [] })); });
    await screen.findByText('Your cart is empty');
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
  });
});

describe('[review S2] cart line totals are the server’s, never worked out here', () => {
  it('shows the server’s lineTotal, and the em-dash — not price × quantity — when it is missing', async () => {
    cartReply = ok({
      items: [
        { id: 'l1', itemId: 'i1', name: 'Pepperpot bowl', quantity: 2, customerPrice: 1800, lineTotal: 3700, fulfillment: 'DELIVERY', isAvailable: true },
        { id: 'l2', itemId: 'i2', name: 'Mauby', quantity: 3, customerPrice: 400, fulfillment: 'DELIVERY', isAvailable: true },
      ],
      subtotalCustomer: 4900,
    });
    go(null, '/cart', {}, <CartPage />);
    const bowl = (await screen.findByText('Pepperpot bowl')).closest('article')!;
    expect(within(bowl).getByText('$3,700')).toBeTruthy();
    const mauby = screen.getByText('Mauby').closest('article')!;
    expect(within(mauby).queryByText('$1,200')).toBeNull();
    expect(within(mauby).getByText('—')).toBeTruthy();
  });
});

describe('[review S2] Switch app is a real modal', () => {
  it('keeps focus inside, makes the page behind inert, closes on Escape and gives focus back', async () => {
    go(null, '/', {}, <p>Home page</p>);
    await screen.findByText('Home page');
    const trigger = screen.getByRole('button', { name: /Switch app/ });
    trigger.focus();
    fireEvent.click(trigger);
    const sheet = screen.getByRole('dialog', { name: 'Switch app' });
    // Focus starts inside, on Close.
    expect(document.activeElement).toBe(within(sheet).getByRole('button', { name: 'Close' }));
    // Everything behind it is inert and hidden from assistive tech.
    const app = document.querySelector('.swift-app')!;
    expect(app.closest('[inert]')).not.toBeNull();
    expect(app.closest('[aria-hidden="true"]')).not.toBeNull();
    // Tab from the last control wraps to the first, Shift+Tab from the first to the last.
    const controls = Array.from(sheet.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    // Escape closes and focus returns to what opened it.
    fireEvent.keyDown(last, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Switch app' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(app.closest('[inert]')).toBeNull();
  });
});

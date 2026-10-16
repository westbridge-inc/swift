import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_REFRESH_MS, StorefrontExperience, loadItemSheet } from './storefront-experience';
import { StorefrontPage } from './storefront-page';
import * as customer from '@/lib/customer';
import * as auth from '@/lib/auth';
import type { StorefrontDetail } from '@/lib/api';
import { LIVE_MENU_MAX_AGE_MS, type ServerStoreMenu } from '@/lib/browse-keys';
import { storeMenuForPage } from '@/lib/browse-server';
import { readGuestBasket } from '@/lib/basket-storage';
import { CustomerSessionProvider, type CustomerSession, type SessionStatus } from '@/components/customer-session';

// ---------------------------------------------------------------------------
// PERF #2 (15 Oct): the store page (the QR landing page) drew from the
// server's store copy, then read the store AND its menu again in the browser
// before Add worked; its largest paint was the "Checking this live menu's
// required choices" notice (LCP 3.4 s on slow 4G). The server now draws a
// recent live menu (at most 30 s old) into the page, so the page arrives
// ready to order from. Required choices are still judged on that live menu,
// and a kept or older copy is read again first. Synthetic data only.
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), notFound: () => { throw new Error('not found'); } }));

const option = (id: string, name: string, additionalPrice: string) => ({ id, name, additionalPrice, isAvailable: true, isDefault: false });
const SIZE: customer.OptionGroup = { id: 'size', name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1,
  options: [option('regular', 'Regular', '0'), option('large', 'Large', '400')] };
const soup = { id: 'soup', name: 'Pumpkin soup', description: 'Made by this store', basePrice: 800, imageUrl: null, unit: null,
  isPopular: false, fulfillment: 'DELIVERY', isAvailable: true, customerPrice: 800, optionGroups: [] as customer.OptionGroup[] };
const curry = { ...soup, id: 'curry', name: 'Curry & roti', basePrice: 1200, customerPrice: 1200, optionGroups: [SIZE] };

/** The public storefront, as GET /public/storefronts/:slug sends it: no choices on any item. */
const storefront = {
  id: 'menu-store', slug: 'sample-kitchen', name: 'Sample Kitchen', description: null, vendorType: 'RESTAURANT',
  logoUrl: null, coverImageUrl: null, city: 'Georgetown', region: 'Demerara', cuisineTypes: [], tags: [],
  displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false, isCurrentlyOpen: true, acceptingOrders: true,
  estimatedPrepTime: 20, minOrderAmount: 0, isFeatured: false, addressLine1: 'Fixture street', operatingHours: [],
  categories: [{ id: 'mains', name: 'Mains', items: [soup, curry].map(({ optionGroups: _choices, isAvailable: _a, customerPrice: _c, ...item }) => item) }],
} as unknown as StorefrontDetail;
/** The live menu (GET /customer/vendors/:id): the one that carries the required choices. */
const vendor = { ...storefront, description: undefined, categories: [{ id: 'mains', name: 'Mains', items: [soup, curry] }] } as unknown as customer.VendorDetail;

let renders = 0;
/** A menu the server drew into one page render: read `age` ms ago (by both clocks unless told otherwise). */
const serverMenu = (age = 1_000, serverAge = age): ServerStoreMenu => ({ vendor, at: Date.now() - age, ageMs: serverAge, renderId: `render-${++renders}` });

let visibility: DocumentVisibilityState = 'visible';
beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  return loadItemSheet();
});

beforeEach(() => {
  sessionStorage.clear(); localStorage.clear();
  vi.restoreAllMocks();
  visibility = 'visible';
  vi.spyOn(auth, 'sessionProbe').mockResolvedValue({ ok: false } as Awaited<ReturnType<typeof auth.sessionProbe>>);
  vi.spyOn(customer, 'getPublicStorefront').mockResolvedValue(storefront);
  vi.spyOn(customer, 'getPublicVendor').mockResolvedValue(vendor);
  vi.spyOn(customer, 'addToCart');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const addSoup = () => screen.getByRole('button', { name: 'Add Pumpkin soup' }) as HTMLButtonElement;
const waitingSoup = () => screen.getByRole('button', { name: 'Pumpkin soup unavailable until menu choices are verified' }) as HTMLButtonElement;
const browserReads = () => vi.mocked(customer.getPublicVendor).mock.calls.length;

describe('the store page arrives ready to order from (PERF #2)', () => {
  it('arrives with the menu verified (no checking notice); Add works once the session answers, with no menu read from the browser', async () => {
    render(<StorefrontExperience store={storefront} returnPath="/store/sample-kitchen" liveMenu={serverMenu()} />);
    // First render: the live menu is in. (Adds wait only for the session answer, row 109.)
    expect(addSoup()).toBeTruthy();
    expect(screen.queryByText(/Checking this live menu/)).toBeNull();
    await waitFor(() => expect(addSoup().disabled).toBe(false));
    expect(await screen.findByText(/Live menu checked at/)).toBeTruthy();
    expect(customer.getPublicStorefront).not.toHaveBeenCalled();
    expect(customer.getPublicVendor).not.toHaveBeenCalled();
  });

  it('still blocks an item until its required choice is made, judged on the live menu', async () => {
    render(<StorefrontExperience store={storefront} returnPath="/store/sample-kitchen" liveMenu={serverMenu()} />);
    await waitFor(() => expect(addSoup().disabled).toBe(false));
    // The storefront copy has no choices; the live menu does, so this item opens them.
    fireEvent.click(screen.getByRole('button', { name: 'Choose options for Curry & roti' }));
    const sheet = await screen.findByRole('dialog', { name: 'Curry & roti' });
    fireEvent.click(within(sheet).getByRole('button', { name: /^Add to order/ }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Choose an option for Size.');
    expect(customer.addToCart).not.toHaveBeenCalled();
    expect(readGuestBasket().lines).toEqual([]);
    // With the choice made, the guest basket takes it.
    fireEvent.click(within(sheet).getByRole('radio', { name: /Regular/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: /^Add to order/ }));
    await waitFor(() => expect(readGuestBasket().lines.map((line) => [line.itemId, line.selectedOptions])).toEqual([['curry', { size: 'regular' }]]));
  });

  it('opens a linked item (?item=) at once from the live menu', async () => {
    render(<StorefrontExperience store={storefront} returnPath="/store/sample-kitchen" initialItemId="curry" liveMenu={serverMenu()} />);
    expect(await screen.findByRole('dialog', { name: 'Curry & roti' })).toBeTruthy();
    expect(customer.getPublicVendor).not.toHaveBeenCalled();
  });

  it('a linked item opens once the page knows who is visiting, so an Add from it goes to the right cart', async () => {
    const shell = (status: SessionStatus): CustomerSession => ({ status, scope: 'guest', epoch: 0, ensureSignedIn: async () => false, nearPoint: null, setNearPoint: () => undefined });
    const menu = serverMenu();
    const page = (status: SessionStatus) => (
      <CustomerSessionProvider value={shell(status)}>
        <StorefrontExperience store={storefront} returnPath="/store/sample-kitchen" initialItemId="curry" liveMenu={menu} />
      </CustomerSessionProvider>
    );
    const view = render(page('checking'));
    // The live menu is in (no checking notice), but the shell has not answered yet.
    expect(addSoup()).toBeTruthy();
    expect(screen.queryByText(/Checking this live menu/)).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByRole('dialog', { name: 'Curry & roti' })).toBeNull();
    view.rerender(page('guest'));
    const sheet = await screen.findByRole('dialog', { name: 'Curry & roti' });
    expect((within(sheet).getByRole('button', { name: /^Add to order/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(customer.getPublicVendor).not.toHaveBeenCalled();
  });

  it('a second showing of the same render (Back/Forward) reads the live menu again before Add works', async () => {
    const menu = serverMenu();
    const first = render(<StorefrontExperience store={storefront} returnPath="/store/sample-kitchen" liveMenu={menu} />);
    await waitFor(() => expect(addSoup().disabled).toBe(false));
    first.unmount();
    render(<StorefrontExperience store={storefront} returnPath="/store/sample-kitchen" liveMenu={menu} />);
    expect(waitingSoup().disabled).toBe(true);
    expect(screen.getByText(/Checking this live menu/)).toBeTruthy();
    await waitFor(() => expect(addSoup().disabled).toBe(false));
    expect(browserReads()).toBe(1);
  });

  it('a kept copy older than 30 s by the phone’s clock reads the live menu again before Add works', async () => {
    // Fresh when the server drew it, but the page was drawn later from a kept copy.
    render(<StorefrontExperience store={storefront} returnPath="/store/sample-kitchen" liveMenu={serverMenu(LIVE_MENU_MAX_AGE_MS + 1_000, 2_000)} />);
    expect(waitingSoup().disabled).toBe(true);
    await waitFor(() => expect(addSoup().disabled).toBe(false));
    expect(browserReads()).toBe(1);
  });

  it('a menu drawn for another store is never used', async () => {
    const other = { ...serverMenu(), vendor: { ...vendor, id: 'other-store' } };
    render(<StorefrontExperience store={storefront} returnPath="/store/sample-kitchen" liveMenu={other} />);
    expect(waitingSoup().disabled).toBe(true);
    await waitFor(() => expect(addSoup().disabled).toBe(false));
    expect(browserReads()).toBe(1);
  });

  it('without a server menu the page reads it in the browser first, as before', async () => {
    render(<StorefrontExperience store={storefront} returnPath="/store/sample-kitchen" liveMenu={null} />);
    expect(waitingSoup().disabled).toBe(true);
    await waitFor(() => expect(addSoup().disabled).toBe(false));
    expect(browserReads()).toBe(1);
  });

  it('reads again when the server’s menu turns 30 s old, and in the background only while the page is on screen', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    render(<StorefrontExperience store={storefront} returnPath="/store/sample-kitchen" liveMenu={serverMenu(20_000)} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(browserReads()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(browserReads()).toBe(1);
    // A hidden page reads nothing on the regular cadence.
    visibility = 'hidden';
    await act(async () => { await vi.advanceTimersByTimeAsync(CATALOG_REFRESH_MS * 2); });
    expect(browserReads()).toBe(1);
    // Back on screen after longer than the cadence: one read at once.
    visibility = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(browserReads()).toBe(2);
    // Back on screen soon after a read: nothing extra.
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(browserReads()).toBe(2);
    // On screen, the cadence carries on.
    await act(async () => { await vi.advanceTimersByTimeAsync(CATALOG_REFRESH_MS); });
    expect(browserReads()).toBe(3);
  });

  it('the page the server draws for a visit hydrates ready to order, whatever the phone’s clock says', async () => {
    // The phone's clock runs 40 s ahead: by it, the server's fresh menu looks old.
    const menu = serverMenu(LIVE_MENU_MAX_AGE_MS + 10_000, 3_000);
    const page = <StorefrontExperience store={storefront} returnPath="/store/sample-kitchen" liveMenu={menu} />;
    const html = renderToString(page);
    expect(html).not.toContain('Checking this live menu');
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const mismatches: unknown[] = [];
    await act(async () => { hydrateRoot(container, page, { onRecoverableError: (error) => { mismatches.push(error); } }); });
    expect(mismatches).toEqual([]);
    expect((within(container).getByRole('button', { name: 'Add Pumpkin soup' }) as HTMLButtonElement).disabled).toBe(false);
    // It is due by the phone's clock, so it is read again at once, in the background.
    await waitFor(() => expect(browserReads()).toBe(1));
    expect((within(container).getByRole('button', { name: 'Add Pumpkin soup' }) as HTMLButtonElement).disabled).toBe(false);
    container.remove();
  });
});

/** The API as the server reads it: the store copy and the guest menu, stamped `age` ms ago. */
function stubApi(menuAgeMs: number, menuReply: () => Response = () => new Response(JSON.stringify({ success: true, data: vendor }))) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/v1/public/storefronts/sample-kitchen') return new Response(JSON.stringify({ success: true, data: storefront }));
    if (path === '/api/v1/customer/vendors/menu-store') {
      const reply = menuReply();
      const headers = new Headers(reply.headers);
      headers.set('date', new Date(Date.now() - menuAgeMs).toUTCString());
      return new Response(reply.body, { status: reply.status, headers });
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('the server draws a recent live menu into the store page (PERF #2)', () => {
  it('the page arrives with enabled Add buttons, not the checking notice; the menu was read as a guest', async () => {
    const fetchMock = stubApi(2_000);
    const html = renderToString(await StorefrontPage({ params: Promise.resolve({ slug: 'sample-kitchen' }), searchParams: Promise.resolve({}) }));
    expect(html).not.toContain('Checking this live menu');
    expect(html).toMatch(/<button[^>]*aria-label="Add Pumpkin soup"(?![^>]*disabled)[^>]*>/);
    const menuReads = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/customer/vendors/menu-store'));
    expect(menuReads).toHaveLength(1);
    const init = menuReads[0]![1] as unknown as RequestInit & { next?: { revalidate?: number } };
    // The shared 30-second server copy, with no person on the request.
    expect(init.next?.revalidate).toBe(30);
    expect(init.credentials).toBeUndefined();
    expect(new Headers(init.headers).has('cookie') || new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('a server copy older than 30 s is not handed to the page: it checks the live menu first, as before', async () => {
    stubApi(LIVE_MENU_MAX_AGE_MS + 2_000);
    const html = renderToString(await StorefrontPage({ params: Promise.resolve({ slug: 'sample-kitchen' }), searchParams: Promise.resolve({}) }));
    expect(html).toContain('Checking this live menu');
  });

  it('hands over the menu with its age and a render of its own', async () => {
    stubApi(5_000);
    const first = await storeMenuForPage('menu-store');
    const second = await storeMenuForPage('menu-store');
    expect(first?.vendor).toEqual(vendor);
    // The Date header counts whole seconds.
    expect(first!.ageMs).toBeGreaterThanOrEqual(5_000);
    expect(first!.ageMs).toBeLessThan(6_100);
    expect(first!.renderId).not.toBe(second!.renderId);
  });

  it.each([
    ['a server error', () => new Response('{}', { status: 500 })],
    ['a refusal', () => new Response(JSON.stringify({ success: false }), { status: 200 })],
    ['a menu without categories', () => new Response(JSON.stringify({ success: true, data: { id: 'menu-store' } }))],
    ['another store’s menu', () => new Response(JSON.stringify({ success: true, data: { ...vendor, id: 'other-store' } }))],
    ['no such store', () => new Response('{}', { status: 404 })],
  ])('hands over nothing on %s, so the page reads it in the browser as before', async (_label, reply) => {
    stubApi(1_000, reply);
    expect(await storeMenuForPage('menu-store')).toBeNull();
  });

  it('hands over nothing when the API cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await storeMenuForPage('menu-store')).toBeNull();
  });
});

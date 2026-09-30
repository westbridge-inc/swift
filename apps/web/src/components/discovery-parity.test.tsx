import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiReply, type ApiRequest } from '@/test/test-utils';
import { adoptSession, clearSession } from '@/lib/auth';
import { CustomerSessionProvider, type CustomerSession } from './customer-session';
import { CustomerHome } from './customer-home';
import BrowsePage from '@/app/(app)/order/browse/page';
import { FavouriteButton } from './account/favourites';
import { customerRoute } from '@/lib/customer-routes';
import { TabBar } from './customer-shell';

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(nav.search), usePathname: () => '/', useRouter: () => ({ push: vi.fn() }) }));
const guest: CustomerSession = { status: 'guest', scope: 'guest', epoch: 0, ensureSignedIn: async () => false, nearPoint: { lat: 6.8, lng: -58.1 }, setNearPoint: vi.fn() };
const signedIn = { ...guest, status: 'signed-in' as const, scope: 'test-person' };
const vendor = (id: string, open = true) => ({ id, name: id, slug: id, vendorType: 'RESTAURANT', cuisineTypes: [], displayRating: null, ratingBucket: 'New', ratingCount: 0, topRated: false, estimatedPrepTime: 20, isCurrentlyOpen: open, acceptingOrders: true });
const categories = ['Curry', 'Roti', 'Rice', 'Fruit'].map((name, i) => ({ slug: name.toLowerCase(), name, emoji: '🍴', kind: i === 3 ? 'AISLE' : 'CUISINE', vertical: 'FOOD', iconKey: null, availableVendors: 2 }));
const feed = { activeOrder: null, popularItems: [], featured: [vendor('Featured')], nearby: [], orderAgain: [], categories: [{ id: 'old', name: 'Legacy dishes', imageUrl: null }], openVendors: [vendor('Featured'), vendor('Open')], closedVendors: [] };
const ok = (data: unknown): ApiReply => ({ body: { success: true, data } });
let calls: ApiRequest[];
let enabled: boolean;
let chips: typeof categories;
let stores: ReturnType<typeof vendor>[];
function api() { return mockApi((r) => {
  calls.push(r);
  if (r.url.pathname.endsWith('/discovery/categories')) return ok({ enabled, categories: chips });
  if (r.url.pathname.endsWith('/customer/home')) return ok(feed);
  if (r.url.pathname.endsWith('/customer/vendors')) return ok(stores);
  if (r.url.pathname.endsWith('/customer/addresses') || r.url.pathname.endsWith('/customer/favorites')) return ok([]);
  throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
}); }
beforeEach(() => { clearSession(); calls = []; enabled = true; chips = categories; stores = []; nav.search = ''; });
const wrap = (child: React.ReactNode, session = guest) => <CustomerSessionProvider value={session}>{child}</CustomerSessionProvider>;

it('uses the public taxonomy order and featured rail for guests without private reads', async () => {
  api(); renderWithQuery(wrap(<CustomerHome market="Georgetown" />));
  const rail = await screen.findByRole('region', { name: 'Find by category' });
  expect(within(rail).getAllByRole('link').filter((a) => a.getAttribute('href')?.includes('category=')).map((x) => x.textContent)).toEqual(categories.map((c) => `🍴${c.name}`));
  expect(within(rail).getByRole('link', { name: 'Curry' }).getAttribute('href')).toContain('category=curry');
  expect(screen.queryByText('Legacy dishes')).toBeNull();
  const recommended = await screen.findByRole('region', { name: 'Recommended for you' });
  expect(within(recommended).getAllByRole('link').find((a) => a.getAttribute('href') === '/order/vendor/Featured')!.getAttribute('href')).toBe('/order/vendor/Featured');
  const discovery = calls.find((c) => c.url.pathname.endsWith('/discovery/categories'))!;
  expect(Object.fromEntries(discovery.url.searchParams)).toEqual({ lat: '6.8', lng: '-58.1' });
  expect(calls.every((c) => c.method === 'GET' && c.init?.credentials === 'include')).toBe(true);
  expect(calls.some((c) => /favorites|auth\/refresh/.test(c.url.pathname))).toBe(false);
});

it.each(['disabled', 'sparse', 'failed'])('falls back to feed category searches when taxonomy is %s', async (mode) => {
  enabled = mode !== 'disabled'; chips = categories.slice(0, mode === 'sparse' ? 3 : 4);
  const normal = api();
  if (mode === 'failed') mockApi((r) => r.url.pathname.endsWith('/discovery/categories') ? { status: 503, body: {} } : normal(r.url.toString(), r.init).then(async (res) => ({ body: await res.json(), status: res.status })));
  renderWithQuery(wrap(<CustomerHome market="Georgetown" />));
  const link = await screen.findByRole('link', { name: 'Legacy dishes' });
  expect(link.getAttribute('href')).toBe('/order/search?q=Legacy%20dishes');
  expect(screen.queryByRole('link', { name: 'Curry' })).toBeNull();
});

it('groups all categories in server order and keeps the phone empty state', async () => {
  nav.search = 'view=categories'; api();
  const view = renderWithQuery(wrap(<BrowsePage />));
  await screen.findByRole('heading', { name: 'Cuisines' });
  expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['Browse by category', 'Cuisines', 'Grocery aisles']);
  view.unmount(); chips = []; renderWithQuery(wrap(<BrowsePage />));
  await screen.findByText('Nothing to browse right now');
  expect(screen.getByText('Categories appear here as stores open.')).toBeTruthy();
});

it('loads a category with location, open stores first, item counts and closed divider', async () => {
  nav.search = 'category=curry&name=Curry'; stores = [{ ...vendor('Closed', false), itemsInCategory: 2 }, vendor('Open')] as typeof stores; api();
  renderWithQuery(wrap(<BrowsePage />));
  await screen.findByText('Closed now');
  const links = screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/order/vendor/'));
  expect(links.map((a) => a.textContent)).toEqual([expect.stringContaining('Open'), expect.stringContaining('Closed')]);
  expect(screen.getByText('2 curry items')).toBeTruthy();
  const req = calls.find((c) => c.url.pathname.endsWith('/customer/vendors'))!;
  expect(Object.fromEntries(req.url.searchParams)).toEqual({ category: 'curry', lat: '6.8', lng: '-58.1' });
});

it('offers three other categories when availability changed', async () => {
  nav.search = 'category=curry&name=Curry'; api(); renderWithQuery(wrap(<BrowsePage />));
  await screen.findByText('No curry spots are open right now');
  expect(screen.getByText('Check back soon.')).toBeTruthy();
  const siblings = screen.getByRole('navigation', { name: 'Open now instead' });
  expect(within(siblings).getAllByRole('link')).toHaveLength(3);
  expect(within(siblings).queryByRole('link', { name: 'Curry' })).toBeNull();
});

it('recommended see-all combines featured and open stores without duplicates', async () => {
  nav.search = 'view=recommended'; api(); renderWithQuery(wrap(<BrowsePage />));
  await screen.findByRole('heading', { name: 'Recommended' });
  await screen.findByText('Featured');
  expect(screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/order/vendor/')).map((a) => a.getAttribute('href'))).toEqual(['/order/vendor/Featured', '/order/vendor/Open']);
  expect(calls.filter((c) => c.url.pathname.endsWith('/customer/home'))).toHaveLength(1);
});

it('keeps Home, Market, Cart and Profile in phone order with a 44px account target', () => {
  renderWithQuery(<TabBar activeTab="profile" marketVisible />);
  const links = screen.getAllByRole('link');
  expect(links.map((a) => a.textContent)).toEqual(['Home', 'Market', 'Cart', 'Profile']);
  expect(links[3]?.getAttribute('href')).toBe('/account');
  expect(links[3]?.getAttribute('aria-current')).toBe('page');
  expect(links[3]?.className).toContain('h-14');
  expect(customerRoute('/account/favourites')).toMatchObject({ public: false, tab: 'profile', parent: '/account' });
});

it('updates both hearts immediately and rolls back a rejected POST before any refetch', async () => {
  adoptSession('test-person');
  let finish!: (_reply: ApiReply) => void;
  let reads = 0;
  mockApi((r) => { calls.push(r); if (r.method === 'GET') return ++reads === 1 ? ok([]) : new Promise(() => undefined); return new Promise((resolve) => { finish = resolve; }); });
  const { user } = renderWithQuery(wrap(<><FavouriteButton vendorId="store" name="Store" /><FavouriteButton vendorId="store" name="Store" /></>, signedIn));
  const hearts = screen.getAllByRole('button', { name: 'Save Store to favourites' }) as HTMLButtonElement[];
  await waitFor(() => expect(hearts[0]!.disabled).toBe(false));
  await user.click(hearts[0]!);
  await waitFor(() => expect(hearts.map((h) => h.getAttribute('aria-pressed'))).toEqual(['true', 'true']));
  expect(hearts.every((h) => h.disabled)).toBe(true);
  expect(calls.find((c) => c.method === 'POST')).toMatchObject({ init: { body: '{}', credentials: 'include', cache: 'no-store' } });
  await act(async () => { finish({ status: 503, body: {} }); });
  await screen.findByRole('alert');
  expect(hearts.map((h) => h.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
});


it('restores a removed favourite on DELETE failure while the reconciliation read is blocked', async () => {
  adoptSession('test-person'); let reads = 0; let finish!: (_reply: ApiReply) => void;
  mockApi((r) => { calls.push(r); if (r.method === 'GET') return ++reads === 1 ? ok([{ id: 'store', name: 'Store' }]) : new Promise(() => undefined); return new Promise((resolve) => { finish = resolve; }); });
  const { user } = renderWithQuery(wrap(<FavouriteButton vendorId="store" name="Store" />, signedIn));
  const heart = await screen.findByRole('button', { name: 'Remove Store from favourites' });
  await user.click(heart);
  await waitFor(() => expect(heart.getAttribute('aria-pressed')).toBe('false'));
  expect(calls.find((c) => c.method === 'DELETE')?.init?.body).toBeUndefined();
  await act(async () => { finish({ status: 503, body: {} }); });
  await screen.findByRole('alert');
  expect(heart.getAttribute('aria-pressed')).toBe('true');
});

it('rolls back only the failed store when two different favourites are saving', async () => {
  adoptSession('test-person'); let reads = 0;
  const finish: Record<string, (_reply: ApiReply) => void> = {};
  mockApi((r) => r.method === 'GET' ? ++reads === 1 ? ok([]) : new Promise(() => undefined) : new Promise((resolve) => { finish[r.url.pathname.split('/').at(-1)!] = resolve; }));
  const { user } = renderWithQuery(wrap(<><FavouriteButton vendorId="one" name="One" /><FavouriteButton vendorId="two" name="Two" /></>, signedIn));
  const first = screen.getByRole('button', { name: 'Save One to favourites' }) as HTMLButtonElement;
  await waitFor(() => expect(first.disabled).toBe(false));
  await user.click(first); await user.click(screen.getByRole('button', { name: 'Save Two to favourites' }));
  await act(async () => { finish.one!({ status: 503, body: {} }); });
  expect(first.getAttribute('aria-pressed')).toBe('false');
  expect(screen.getByRole('button', { name: 'Remove Two from favourites' }).getAttribute('aria-pressed')).toBe('true');
  await act(async () => { finish.two!(ok({})); });
});


it('deduplicates fallback category names like the phone, preserving the first spelling and order', async () => {
  enabled = false;
  const normal = api();
  mockApi((r) => r.url.pathname.endsWith('/customer/home') ? ok({ ...feed, categories: [{ id: 'a', name: 'Roti', imageUrl: null }, { id: 'b', name: ' roti ', imageUrl: null }, { id: 'c', name: 'Curry', imageUrl: null }] }) : normal(r.url.toString(), r.init).then(async (res) => ({ body: await res.json(), status: res.status })));
  renderWithQuery(wrap(<CustomerHome market="Georgetown" />));
  const rail = await screen.findByRole('region', { name: 'Find by category' });
  expect(within(rail).getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/order/search?q=')).map((a) => a.textContent)).toEqual(['Roti', 'Curry']);
});

it('caps the home recommendation rail at the first ten server-ranked stores and shows its empty state', async () => {
  const normal = api(); let featured = Array.from({ length: 11 }, (_, i) => vendor(`Pick ${i}`));
  mockApi((r) => r.url.pathname.endsWith('/customer/home') ? ok({ ...feed, featured }) : normal(r.url.toString(), r.init).then(async (res) => ({ body: await res.json(), status: res.status })));
  const view = renderWithQuery(wrap(<CustomerHome market="Georgetown" />));
  const rail = await screen.findByRole('region', { name: 'Recommended for you' });
  expect(within(rail).getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/order/vendor/')).map((a) => a.textContent)).toEqual(featured.slice(0, 10).map((v) => expect.stringContaining(v.name)));
  view.unmount(); featured = []; renderWithQuery(wrap(<CustomerHome market="Georgetown" />));
  await screen.findByText("Nothing's open right now — check back soon.");
});

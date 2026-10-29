import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '@/test/test-utils';
import AppLayout from '../layout';
import { MarketScreen as MarketPage } from './market-screen';

const nav = vi.hoisted(() => ({ query: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/market',
  useSearchParams: () => new URLSearchParams(nav.query),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

let visible = true;
let fetchMock: ReturnType<typeof mockApi>;
const requested = (pathname: string) => fetchMock.mock.calls
  .map(([url]) => new URL(String(url)))
  .filter((url) => url.pathname === pathname);

const item = (id: string, name: string) => ({ id, name, basePrice: 2500, imageUrl: null, vendorId: 'v9', vendorName: 'City Hardware', categoryName: 'Tools', isNew: id === 'm1' });

beforeEach(async () => {
  (await import('@/lib/auth')).clearSession();
  visible = true;
  nav.query = '';
  fetchMock = mockApi(({ url }) => {
    if (url.pathname === '/api/v1/auth/me') return { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/market/depth') return { body: { success: true, data: { visible, items: visible ? 400 : 20, vendors: visible ? 6 : 1 } } };
    if (url.pathname === '/api/v1/discovery/categories') {
      return { body: { success: true, data: { enabled: true, categories: [
        { slug: 'tools', name: 'Tools', vertical: 'RETAIL' },
        { slug: 'rice', name: 'Rice', vertical: 'GROCERY' },
      ] } } };
    }
    if (url.pathname === '/api/v1/market/items') {
      return url.searchParams.get('cursor') === 'page-2'
        ? { body: { success: true, data: { items: [item('m3', 'Tape measure')], nextCursor: null } } }
        : { body: { success: true, data: { items: [item('m1', 'Claw hammer'), item('m2', 'Paint brush')], nextCursor: 'page-2' } } };
    }
    return { status: 404, body: { success: false } };
  });
});

// ---------------------------------------------------------------------------
// [Q7b] The phone app's Market tab on the web: goods across stores, opened at
// their own store. It exists only while the server's depth verdict says the
// catalogue is deep enough — the same rule, the same public feed.
// ---------------------------------------------------------------------------

describe('[Q7b] Market', () => {
  it('lists goods across stores, each opening at its own store on that item, a page at a time', async () => {
    render(<AppLayout><MarketPage /></AppLayout>);
    const hammer = await screen.findByRole('link', { name: /Claw hammer/ });
    expect(hammer.getAttribute('href')).toBe('/order/vendor/v9?item=m1');
    expect(hammer.textContent).toMatch(/\$2,500/);
    expect(hammer.textContent).toMatch(/City Hardware/);
    // Only goods categories are offered as chips.
    const chips = await screen.findByRole('navigation', { name: 'Market categories' });
    await waitFor(() => expect(within(chips).getAllByRole('link').map((link) => link.textContent)).toEqual(['All', 'Tools']));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('link', { name: /Tape measure/ })).toBeTruthy();
    expect(requested('/api/v1/market/items').map((url) => url.searchParams.get('cursor'))).toEqual([null, 'page-2']);
  });

  it('is closed while the catalogue is too thin, and asks for no items', async () => {
    visible = false;
    render(<AppLayout><MarketPage /></AppLayout>);
    expect(await screen.findByText(/The market opens once enough stores list their goods/)).toBeTruthy();
    expect(requested('/api/v1/market/items')).toHaveLength(0);
  });
});

// [P35 · board 4a] As the phone's Market: the shelf is newest-first and called "New arrivals"; a category names
// itself and "See all" goes back to everything.
describe('[P35 · board 4a] the shelf', () => {
  it('"New arrivals", read newest-first, with no See all', async () => {
    render(<AppLayout><MarketPage /></AppLayout>);
    expect(await screen.findByRole('heading', { name: 'New arrivals' })).toBeTruthy();
    await screen.findByRole('link', { name: /Claw hammer/ });
    expect(requested('/api/v1/market/items').map((url) => url.searchParams.get('sort'))).toEqual(['new']);
    expect(screen.queryByRole('link', { name: 'See all' })).toBeNull();
  });

  it('a category: its own name, and See all back to the whole market', async () => {
    nav.query = 'category=tools';
    render(<AppLayout><MarketPage /></AppLayout>);
    expect(await screen.findByRole('heading', { name: 'Tools' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See all' }).getAttribute('href')).toBe('/market');
  });
});

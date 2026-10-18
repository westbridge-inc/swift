import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AppLayout from '../../layout';
import SearchPage from './page';

// ---------------------------------------------------------------------------
// [B2 · the phone's SearchScreen] A search with no matches offers "Worth trying
// right now": the most ordered dishes in open stores (GET /search/trending), as
// the phone's Search does under All, Food and Groceries. It is asked once, only
// when nothing matched, and a failed read shows nothing.
// ---------------------------------------------------------------------------

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/order/search', useRouter: () => navigation }));
vi.mock('@/components/swift-logo', () => ({ SwiftLogo: () => <span>Swift</span> }));
vi.mock('@/components/order-ui', () => ({
  VendorGridSkeleton: () => <div aria-label="Loading stores" />,
  VendorCard: ({ v }: any) => <p>{v.name}</p>, EmptyNote: ({ children }: any) => <p>{children}</p>, VENDOR_GRID: 'grid',
  ItemCard: ({ name, meta, href }: any) => <a href={href}>{`${name} · ${meta}`}</a>,
}));

const TRENDING_URL = 'http://vendor-api.test/api/v1/search/trending';
/** Eight made-up trending dishes, most ordered first (the server's order). */
const TRENDING = Array.from({ length: 8 }, (_, i) => ({
  id: `t${i + 1}`, name: `Test dish ${i + 1}`, vendorId: `v${i + 1}`, vendorName: `Test Kitchen ${i + 1}`,
  basePrice: 1000 + i, imageUrl: null, categoryName: null, isNew: false, vendorIsCurrentlyOpen: true,
}));

function backend({ vendors = [] as unknown[], items = [] as unknown[], searchDown = false, trendingDown = false } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/v1/search?')) {
      return searchDown
        ? new Response(JSON.stringify({ success: false, error: { message: 'down' } }), { status: 503 })
        : new Response(JSON.stringify({ success: true, data: { vendors, items } }), { status: 200 });
    }
    if (url.includes('/api/v1/search/suggestions?')) return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
    if (url === TRENDING_URL) {
      return trendingDown
        ? new Response(JSON.stringify({ success: false, error: { message: 'down' } }), { status: 503 })
        : new Response(JSON.stringify({ success: true, data: TRENDING }), { status: 200 });
    }
    if (url.includes('/market/depth')) return new Response(JSON.stringify({ success: true, data: { visible: false, items: 0, vendors: 0 } }), { status: 200 });
    return new Response(JSON.stringify({ success: false, data: null }), { status: 401 });
  });
}

const box = () => screen.getByRole('textbox', { name: 'Search stores and dishes' });
const asked = (fetcher: ReturnType<typeof backend>) => fetcher.mock.calls.filter(([url]) => String(url) === TRENDING_URL).length;

describe('[B2] "Worth trying right now" when a search finds nothing', () => {
  it('offers the six most ordered dishes, each opening its store at the item', async () => {
    const fetcher = backend();
    vi.stubGlobal('fetch', fetcher);
    render(<AppLayout><SearchPage /></AppLayout>);
    fireEvent.change(box(), { target: { value: 'Zzyzx' } });
    expect(await screen.findByText('Nothing matches “Zzyzx” — try a store’s name, a dish or a cuisine.')).toBeTruthy();
    const section = await screen.findByRole('region', { name: 'Worth trying right now' });
    expect(within(section).getByRole('heading', { name: 'Worth trying right now' })).toBeTruthy();
    const links = within(section).getAllByRole('link');
    // The phone's six, in the server's (most ordered first) order.
    expect(links.map((link) => link.textContent)).toEqual(TRENDING.slice(0, 6).map((d) => `${d.name} · ${d.vendorName}`));
    expect(links[0]?.getAttribute('href')).toBe('/order/vendor/v1?item=t1');
    expect(asked(fetcher)).toBe(1);
    expect(fetcher).toHaveBeenCalledWith(TRENDING_URL, expect.objectContaining({ credentials: 'include' }));

    // Another search with no matches shows them again without asking again.
    fireEvent.change(box(), { target: { value: 'Qwxv' } });
    expect(await screen.findByText('Nothing matches “Qwxv” — try a store’s name, a dish or a cuisine.')).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Worth trying right now' })).toBeTruthy();
    expect(asked(fetcher)).toBe(1);
  });

  it('is never asked or shown when the search found something', async () => {
    const fetcher = backend({ vendors: [{ id: 'v9', name: 'Pepper Kitchen', vendorType: 'RESTAURANT' }] });
    vi.stubGlobal('fetch', fetcher);
    render(<AppLayout><SearchPage /></AppLayout>);
    fireEvent.change(box(), { target: { value: 'Pepper' } });
    expect(await screen.findByText('Pepper Kitchen')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Worth trying right now' })).toBeNull();
    expect(asked(fetcher)).toBe(0);
  });

  it('Food and Groceries offer it too; Shops and Services (outside the phone’s engine search) do not', async () => {
    const fetcher = backend({ vendors: [{ id: 'v9', name: 'Test Hardware', vendorType: 'STORE' }] });
    vi.stubGlobal('fetch', fetcher);
    render(<AppLayout><SearchPage /></AppLayout>);
    fireEvent.change(box(), { target: { value: 'Hammer' } });
    expect(await screen.findByText('Test Hardware')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Services' }));
    expect(await screen.findByText('No services stores match “Hammer”.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Worth trying right now' })).toBeNull();
    expect(asked(fetcher)).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Food' }));
    expect(await screen.findByText('No food stores match “Hammer”.')).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Worth trying right now' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Groceries' }));
    expect(await screen.findByText('No groceries stores match “Hammer”.')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Worth trying right now' })).toBeTruthy();
    expect(asked(fetcher)).toBe(1);
  });

  it('Shops with no match does not offer it either', async () => {
    const fetcher = backend({ vendors: [{ id: 'v8', name: 'Test Kitchen', vendorType: 'RESTAURANT' }] });
    vi.stubGlobal('fetch', fetcher);
    render(<AppLayout><SearchPage /></AppLayout>);
    fireEvent.change(box(), { target: { value: 'Rice' } });
    expect(await screen.findByText('Test Kitchen')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Shops' }));
    expect(await screen.findByText('No shops stores match “Rice”.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Worth trying right now' })).toBeNull();
    expect(asked(fetcher)).toBe(0);
  });

  it('a search that could not be asked is not "nothing matches": no invitation', async () => {
    const fetcher = backend({ searchDown: true });
    vi.stubGlobal('fetch', fetcher);
    render(<AppLayout><SearchPage /></AppLayout>);
    fireEvent.change(box(), { target: { value: 'Pepper' } });
    expect(await screen.findByText('Search isn’t answering right now. Please try again in a moment.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Worth trying right now' })).toBeNull();
    expect(asked(fetcher)).toBe(0);
  });

  it('a failed trending read shows nothing, never an error', async () => {
    const fetcher = backend({ trendingDown: true });
    vi.stubGlobal('fetch', fetcher);
    render(<AppLayout><SearchPage /></AppLayout>);
    fireEvent.change(box(), { target: { value: 'Zzyzx' } });
    expect(await screen.findByText('Nothing matches “Zzyzx” — try a store’s name, a dish or a cuisine.')).toBeTruthy();
    await waitFor(() => expect(asked(fetcher)).toBe(1));
    expect(screen.queryByRole('region', { name: 'Worth trying right now' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

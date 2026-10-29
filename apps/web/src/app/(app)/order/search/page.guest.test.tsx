import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AppLayout from '../../layout';
import SearchPage from './page';

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/order/search', useRouter: () => navigation }));
vi.mock('@/components/swift-logo', () => ({ SwiftLogo: () => <span>Swift</span> }));
vi.mock('@/components/order-ui', () => ({
  VendorGridSkeleton: () => <div aria-label="Loading stores" />,
  VendorCard: ({ v }: any) => <p>{v.name}</p>, EmptyNote: ({ children }: any) => <p>{children}</p>, VENDOR_GRID: 'grid',
  ItemCard: ({ name, meta, href }: any) => <a href={href}>{`${name} · ${meta}`}</a>,
}));

const SEARCH_URL = 'http://vendor-api.test/api/v1/search?q=Pepper&limit=30';

function engine(vendors: unknown[], items: unknown[] = []) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    // [row 110] The page also asks the engine's suggestions while you type
    // (the phone's [B2] chips); a guest gets them from the same public engine.
    const data = url.includes('/api/v1/search?') ? { vendors, items } : url.includes('/api/v1/search/suggestions?') ? []
      : url.includes('/market/depth') ? { visible: false, items: 0, vendors: 0 } : null;
    return new Response(JSON.stringify({ success: data !== null, data }), { status: data === null ? 401 : 200 });
  });
}

describe('web guest catalogue search', () => {
  it('mounts the public page and asks the one search engine, once, as a guest', async () => {
    const fetcher = engine([{ id: 'public', name: 'Public pepper shop', vendorType: 'RESTAURANT' }]);
    vi.stubGlobal('fetch', fetcher);
    render(<AppLayout><SearchPage /></AppLayout>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search stores and dishes' }), { target: { value: 'Pepper' } });
    await waitFor(() => expect(screen.queryByText('Public pepper shop')).not.toBeNull());
    // [Q7b] The shell asks once who is browsing and once whether Market is
    // open; the search itself is ONE call to the search engine (stores and
    // dishes together). Nothing else — in particular, no refresh is spent on a guest.
    // [row 110] Plus ONE call for the engine's suggestions (the phone's chips).
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      'http://vendor-api.test/api/v1/auth/me',
      'http://vendor-api.test/api/v1/market/depth',
      'http://vendor-api.test/api/v1/search/suggestions?q=Pepper',
      SEARCH_URL,
    ]);
    expect(fetcher).toHaveBeenCalledWith(SEARCH_URL, expect.objectContaining({ credentials: 'include' }));
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('[SEARCH 13 Oct] shows the dishes and products that match, each opening its own store at the item', async () => {
    vi.stubGlobal('fetch', engine(
      [{ id: 'v1', name: 'Pepper Kitchen', vendorType: 'RESTAURANT' }],
      [{ id: 'i1', name: 'Pepperpot', vendorId: 'v2', vendorName: 'Granny Fakeplace', basePrice: 1500, imageUrl: null, categoryName: null, isNew: false }],
    ));
    render(<AppLayout><SearchPage /></AppLayout>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search stores and dishes' }), { target: { value: 'Pepper' } });
    const dish = await screen.findByText('Pepperpot · Granny Fakeplace');
    expect(dish.getAttribute('href')).toBe('/order/vendor/v2?item=i1');
    expect(screen.getByText('Pepper Kitchen')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Dishes and products' })).toBeTruthy();
  });

  it('[owner 13 Oct] a dish of a closed store says so under its store\'s name; an open store\'s dish does not', async () => {
    vi.stubGlobal('fetch', engine(
      [{ id: 'v1', name: 'Pepper Kitchen', vendorType: 'RESTAURANT', isCurrentlyOpen: false }],
      [
        { id: 'i1', name: 'Pepperpot', vendorId: 'v2', vendorName: 'Granny Fakeplace', basePrice: 1500, imageUrl: null, categoryName: null, isNew: false, vendorIsCurrentlyOpen: true },
        { id: 'i2', name: 'Pepper Roti', vendorId: 'v1', vendorName: 'Pepper Kitchen', basePrice: 900, imageUrl: null, categoryName: null, isNew: false, vendorIsCurrentlyOpen: false },
      ],
    ));
    render(<AppLayout><SearchPage /></AppLayout>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search stores and dishes' }), { target: { value: 'Pepper' } });
    expect(await screen.findByText('Pepper Roti · Pepper Kitchen · Closed right now')).toBeTruthy();
    expect(screen.getByText('Pepperpot · Granny Fakeplace')).toBeTruthy();
  });

  it('a kind chip narrows the stores; dishes, which carry no kind, show under All only', async () => {
    vi.stubGlobal('fetch', engine(
      [{ id: 'v1', name: 'Pepper Kitchen', vendorType: 'RESTAURANT' }, { id: 'v3', name: 'Pepper Hardware', vendorType: 'STORE' }],
      [{ id: 'i1', name: 'Pepperpot', vendorId: 'v2', vendorName: 'Granny Fakeplace', basePrice: 1500, imageUrl: null, categoryName: null, isNew: false }],
    ));
    render(<AppLayout><SearchPage /></AppLayout>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search stores and dishes' }), { target: { value: 'Pepper' } });
    await screen.findByText('Pepperpot · Granny Fakeplace');
    fireEvent.click(screen.getByRole('button', { name: 'Shops' }));
    expect(screen.getByText('Pepper Hardware')).toBeTruthy();
    expect(screen.queryByText('Pepper Kitchen')).toBeNull();
    expect(screen.queryByText('Pepperpot · Granny Fakeplace')).toBeNull();
  });

  it('[DS1081 S4] a search that could not be asked says so — never "nothing matches"', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/search?')) return new Response(JSON.stringify({ success: false, error: { message: 'down' } }), { status: 503 });
      return new Response(JSON.stringify({ success: false, data: null }), { status: 401 });
    }));
    render(<AppLayout><SearchPage /></AppLayout>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search stores and dishes' }), { target: { value: 'Pepper' } });
    expect(await screen.findByText('Search isn’t answering right now. Please try again in a moment.')).toBeTruthy();
    expect(screen.queryByText(/Nothing matches/)).toBeNull();
  });

  it('an empty answer says so, and offers dishes as something to try', async () => {
    vi.stubGlobal('fetch', engine([], []));
    render(<AppLayout><SearchPage /></AppLayout>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search stores and dishes' }), { target: { value: 'Pepper' } });
    expect(await screen.findByText('Nothing matches “Pepper” — try a store’s name, a dish or a cuisine.')).toBeTruthy();
  });
});

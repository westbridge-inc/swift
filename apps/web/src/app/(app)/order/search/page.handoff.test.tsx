import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SearchPage from './page';

// [row 110] The browse pages' search bar hands its words and category to this
// page in the address (/order/search?q=…&type=…), as the phone's category
// screens open Search with { q, type }. The page starts with them, and offers
// the engine's suggestions as tappable words while you type (the phone's [B2]).
vi.mock('next/navigation', () => ({ usePathname: () => '/order/search', useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }) }));
vi.mock('@/components/customer-shell', () => ({ BackButton: () => null, useOwnBackButton: () => undefined }));
vi.mock('@/components/order-ui', () => ({
  VendorGridSkeleton: () => <div aria-label="Loading stores" />,
  VendorCard: ({ v }: any) => <p>{v.name}</p>, EmptyNote: ({ children }: any) => <p>{children}</p>, VENDOR_GRID: 'grid',
  ItemCard: ({ name, meta, href }: any) => <a href={href}>{`${name} · ${meta}`}</a>,
}));

const kitchen = { id: 'v1', name: 'Pepper Kitchen', vendorType: 'RESTAURANT' };
const grocer = { id: 'v2', name: 'Pepper Grocer', vendorType: 'SUPERMARKET' };
const pepperpot = { id: 'i1', name: 'Pepperpot', vendorId: 'v1', vendorName: 'Pepper Kitchen', basePrice: 1500, imageUrl: null, categoryName: null, isNew: false };

function engine({ suggestions = [] as unknown[] | 'fail' } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/search/suggestions') {
      return suggestions === 'fail'
        ? new Response(JSON.stringify({ success: false }), { status: 500 })
        : new Response(JSON.stringify({ success: true, data: suggestions }), { status: 200 });
    }
    if (url.pathname === '/api/v1/search') {
      return new Response(JSON.stringify({ success: true, data: { vendors: [kitchen, grocer], items: [pepperpot] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  });
}
const searched = (fetcher: ReturnType<typeof engine>) => fetcher.mock.calls
  .map(([input]) => new URL(String(input))).filter((u) => u.pathname === '/api/v1/search').map((u) => u.searchParams.get('q'));
const box = () => screen.getByRole('textbox', { name: 'Search stores and dishes' }) as HTMLInputElement;
const pressed = () => screen.getAllByRole('button', { pressed: true }).map((b) => b.textContent);

afterEach(() => { window.history.replaceState(null, '', '/'); vi.unstubAllGlobals(); });

describe('the search page takes what a search bar handed over', () => {
  it('starts with the words and the category, and asks the one search engine for them', async () => {
    window.history.replaceState(null, '', '/order/search?q=pepper&type=RESTAURANT');
    const fetcher = engine();
    vi.stubGlobal('fetch', fetcher);
    render(<SearchPage />);
    expect(box().value).toBe('pepper');
    expect(pressed()).toEqual(['Food']);
    await screen.findByText('Pepper Kitchen');
    expect(searched(fetcher)).toEqual(['pepper']);
    // Narrowed to food stores, exactly as tapping the Food chip does.
    expect(screen.queryByText('Pepper Grocer')).toBeNull();
    expect(screen.queryByText('Pepperpot · Pepper Kitchen')).toBeNull();
  });

  it('with words and no known category, searches everything: stores AND dishes', async () => {
    window.history.replaceState(null, '', '/order/search?q=pepper&type=BOGUS');
    const fetcher = engine();
    vi.stubGlobal('fetch', fetcher);
    render(<SearchPage />);
    expect(pressed()).toEqual(['All']);
    await screen.findByText('Pepperpot · Pepper Kitchen');
    expect(screen.getByText('Pepper Grocer')).toBeTruthy();
    expect(searched(fetcher)).toEqual(['pepper']);
  });

  it('with no words, waits for the customer to type (a category alone just narrows)', async () => {
    window.history.replaceState(null, '', '/order/search?type=SUPERMARKET');
    const fetcher = engine();
    vi.stubGlobal('fetch', fetcher);
    render(<SearchPage />);
    expect(box().value).toBe('');
    expect(pressed()).toEqual(['Groceries']);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('the engine suggests words while you type', () => {
  it('shows them as chips (never the words already typed); a tap searches that word', async () => {
    const fetcher = engine({ suggestions: [
      { text: 'Pepperpot', type: 'item' }, { text: 'pepp', type: 'vendor' }, { text: 'Pepper Kitchen', type: 'vendor' },
    ] });
    vi.stubGlobal('fetch', fetcher);
    render(<SearchPage />);
    fireEvent.change(box(), { target: { value: 'pepp' } });
    const chips = await screen.findByRole('group', { name: 'Suggestions' });
    expect([...chips.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Pepperpot', 'Pepper Kitchen']);

    fireEvent.click(screen.getByRole('button', { name: 'Pepperpot' }));
    expect(box().value).toBe('Pepperpot');
    await waitFor(() => expect(searched(fetcher)).toEqual(['pepp', 'Pepperpot']));
  });

  it('a suggestions read that fails shows no chips and never an error; the results still come', async () => {
    vi.stubGlobal('fetch', engine({ suggestions: 'fail' }));
    render(<SearchPage />);
    fireEvent.change(box(), { target: { value: 'pepper' } });
    await screen.findByText('Pepper Kitchen');
    expect(screen.queryByRole('group', { name: 'Suggestions' })).toBeNull();
    expect(screen.queryByText(/isn’t answering/)).toBeNull();
  });

  it('clearing the words clears the chips', async () => {
    vi.stubGlobal('fetch', engine({ suggestions: [{ text: 'Pepperpot', type: 'item' }] }));
    render(<SearchPage />);
    fireEvent.change(box(), { target: { value: 'pepp' } });
    await screen.findByRole('group', { name: 'Suggestions' });
    fireEvent.change(box(), { target: { value: '' } });
    expect(screen.queryByRole('group', { name: 'Suggestions' })).toBeNull();
  });
});

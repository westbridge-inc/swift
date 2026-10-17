import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CatalogueSearchBar } from './catalogue-search-bar';

// [row 110] A visible search bar on the store directory (/stores) and on each
// category (/order/browse?type=…). It hands the words, and the category the
// page is showing, to the one search page: GET /order/search?q=…&type=….
const params = vi.hoisted(() => ({ type: 'STORE' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(params.type ? { type: params.type } : {}),
  usePathname: () => '/order/browse',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/lib/api', () => ({ fetchStorefronts: vi.fn(async () => []) }));
vi.mock('@/lib/customer', () => ({ getVendors: vi.fn(async () => []) }));
vi.mock('@/components/order-ui', () => ({
  VendorGridSkeleton: () => <div aria-label="Loading stores" />, VendorCard: () => null,
  EmptyNote: ({ children }: any) => <p>{children}</p>, VENDOR_GRID: 'grid',
}));

function handOver(form: HTMLElement) {
  const f = form as HTMLFormElement;
  return {
    action: new URL(f.action).pathname,
    method: f.method,
    fields: [...f.elements].filter((e): e is HTMLInputElement => e instanceof HTMLInputElement)
      .map((e) => [e.name, e.type, e.type === 'hidden' ? e.value : null]),
  };
}

describe('the catalogue search bar', () => {
  it('is a search form that hands its words to the search page, with no script needed', () => {
    render(<CatalogueSearchBar />);
    const form = screen.getByRole('search', { name: 'Search stores and dishes' });
    expect(handOver(form)).toEqual({ action: '/order/search', method: 'get', fields: [['q', 'search', null]] });
    const words = within(form).getByRole('searchbox', { name: 'Search stores and dishes' }) as HTMLInputElement;
    expect(words.required).toBe(true);
    expect(words.minLength).toBe(2); // the engine answers from two letters
    expect(within(form).getByRole('button', { name: 'Search' }).getAttribute('type')).toBe('submit');
  });

  it.each(['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE'])('on a %s page, also hands over that category', (type) => {
    render(<CatalogueSearchBar type={type} />);
    expect(handOver(screen.getByRole('search')).fields).toEqual([['q', 'search', null], ['type', 'hidden', type]]);
  });

  it.each([undefined, null, '', 'BOGUS', 'restaurant'])('with no known category (%s) it searches everything', (type) => {
    render(<CatalogueSearchBar type={type} />);
    expect(handOver(screen.getByRole('search')).fields).toEqual([['q', 'search', null]]);
  });
});

describe('where the search bar shows', () => {
  it('the store directory /stores shows it, carrying the kind of store being shown', async () => {
    const { default: StoresPage } = await import('@/app/(marketing)/stores/page');
    render(await StoresPage({ searchParams: Promise.resolve({ type: 'SUPERMARKET' }) }));
    expect(handOver(screen.getByRole('search', { name: 'Search stores and dishes' })).fields)
      .toEqual([['q', 'search', null], ['type', 'hidden', 'SUPERMARKET']]);
  });

  it('the store directory with no filter searches everything', async () => {
    const { default: StoresPage } = await import('@/app/(marketing)/stores/page');
    render(await StoresPage({ searchParams: Promise.resolve({}) }));
    expect(handOver(screen.getByRole('search')).fields).toEqual([['q', 'search', null]]);
  });

  it('each category page /order/browse?type=… shows it, carrying that category', async () => {
    params.type = 'STORE';
    const { BrowseScreen } = await import('@/app/(app)/order/browse/browse-screen');
    render(<QueryClientProvider client={new QueryClient()}><BrowseScreen /></QueryClientProvider>);
    expect(handOver(await screen.findByRole('search', { name: 'Search stores and dishes' })).fields)
      .toEqual([['q', 'search', null], ['type', 'hidden', 'STORE']]);
  });
});

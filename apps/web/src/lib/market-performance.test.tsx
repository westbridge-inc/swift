import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HydrationBoundary } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { loadMarket } from './market-server';
import { MarketPrefetch } from '@/components/market-prefetch';
import { mayPrefetch } from './market-queries';
import { mockApi, renderWithQuery, type ApiReply } from '@/test/test-utils';
import MarketPage from '@/app/(app)/market/page';
import MarketClient from '@/app/(app)/market/page';
import MarketLayout from '@/app/(app)/market/layout';
import { Providers } from '@/components/providers';
import AppLayout from '@/app/(app)/layout';
import { clearSession } from './auth';

const navigation = vi.hoisted(() => ({ category: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/market', useSearchParams: () => new URLSearchParams({ category: navigation.category }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
const ok = (data: unknown): ApiReply => ({ body: { success: true, data } });
const item = { id: 'tool', name: 'Test hammer', basePrice: 2500, vendorId: 'store', vendorName: 'Test store', imageUrl: null };
const items = { items: [item], nextCursor: null };
const rail = { categories: [{ slug: 'tools', name: 'Tools', vertical: 'RETAIL' }] };
const deferred = <T,>() => {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
beforeEach(() => { clearSession(); navigation.category = ''; });

describe('Market request phases and server rendering', () => {
  it('starts categories and depth together; items require depth but never wait for categories', async () => {
    const depth = deferred<ApiReply>();
    const categories = deferred<ApiReply>();
    const requests: string[] = [];
    mockApi(({ url, init }) => {
      requests.push(url.pathname);
      expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store' });
      expect(init?.headers).toBeUndefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.pathname.endsWith('/depth')) return depth.promise;
      if (url.pathname.endsWith('/categories')) return categories.promise;
      expect(url.searchParams.get('category')).toBe('tools');
      return ok(items);
    });
    const pending = loadMarket('tools');
    expect(requests.sort()).toEqual(['/api/v1/discovery/categories', '/api/v1/market/depth']);
    depth.resolve(ok({ visible: true, items: 400, vendors: 6 }));
    await waitFor(() => expect(requests).toContain('/api/v1/market/items'));
    categories.resolve(ok(rail));
    expect((await pending).queries).toHaveLength(3);
  });

  it.each([false, 'failure'])('does not read items with depth verdict %s', async (visible) => {
    const fetcher = mockApi(({ url }) => url.pathname.endsWith('/depth')
      ? visible === 'failure' ? { status: 503, body: {} } : ok({ visible }) : ok(rail));
    await loadMarket('');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/market/items'))).toBe(false);
  });

  it('renders a populated public catalogue in the server HTML without a browser fetch waterfall', async () => {
    mockApi(({ url }) => ok(url.pathname.endsWith('/depth') ? { visible: true, items: 400, vendors: 6 } : url.pathname.endsWith('/categories') ? rail : items));
    const page = await MarketLayout({ children: <MarketPage /> });
    // The app shell supplies the real QueryClient on both server and browser.
    const html = renderToString(<AppLayout>{page}</AppLayout>);
    expect(html).toContain('Test hammer');
    expect(html).toContain('GY$2,500');
    expect(html).not.toContain('Loading market items');
  });

  it('hydrates page and parent shell without duplicate market reads', async () => {
    const fetcher = mockApi(({ url }) => {
      if (url.pathname.endsWith('/me')) return { status: 401, body: { success: false } };
      return ok(url.pathname.endsWith('/depth') ? { visible: true, items: 400, vendors: 6 } : url.pathname.endsWith('/categories') ? rail : items);
    });
    const page = await MarketLayout({ children: <MarketPage /> });
    fetcher.mockClear();
    renderWithQuery(<AppLayout>{page}</AppLayout>);
    await screen.findByText('Test hammer');
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/auth/me'))).toBe(true));
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['http://vendor-api.test/api/v1/auth/me']);
  });

  it('prefetches the focused category, deduplicates hover, and reuses it on navigation', async () => {
    const fetcher = mockApi(({ url }) => ok(url.pathname.endsWith('/depth') ? { visible: true, items: 400, vendors: 6 } : url.pathname.endsWith('/categories') ? rail : items));
    const state = await loadMarket('');
    fetcher.mockClear();
    const view = renderWithQuery(<Providers><HydrationBoundary state={state}><MarketPrefetch><MarketClient /></MarketPrefetch></HydrationBoundary></Providers>);
    const tools = await screen.findByRole('link', { name: 'Tools' });
    fireEvent.focus(tools); fireEvent.mouseEnter(tools);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    const history = vi.spyOn(window.history, 'replaceState');
    fireEvent.click(tools);
    expect(history).toHaveBeenCalledWith(null, '', '/market?category=tools');
    navigation.category = 'tools';
    view.rerender(<Providers><HydrationBoundary state={state}><MarketPrefetch><MarketClient /></MarketPrefetch></HydrationBoundary></Providers>);
    expect(await screen.findByText('Test hammer')).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain('category=tools');
  });

  it('does not prefetch on offline, save-data or 2G connections', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(mayPrefetch()).toBe(false);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    for (const connection of [{ saveData: true }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }]) {
      Object.defineProperty(navigator, 'connection', { value: connection, configurable: true });
      expect(mayPrefetch()).toBe(false);
    }
    Object.defineProperty(navigator, 'connection', { value: { effectiveType: '4g' }, configurable: true });
    expect(mayPrefetch()).toBe(true);
  });
});

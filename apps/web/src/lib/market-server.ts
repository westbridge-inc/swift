import { dehydrate, QueryClient } from '@tanstack/react-query';
import { BROWSER_API_ORIGIN } from './browser-api-origin';
import { marketTabVisible } from './app-rules';
import type { MarketCategory, MarketDepth, MarketItem } from './customer';

const API = process.env['API_URL'] ?? BROWSER_API_ORIGIN;

async function read<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error('Market unavailable');
  const body = await response.json();
  if (body?.success === false || !body?.data) throw new Error('Market unavailable');
  return body.data as T;
}

/** A new cache for every render; failures fall back to the client retry UI. */
export async function loadMarket(category: string) {
  const client = new QueryClient();
  const categories = client.prefetchQuery({
    queryKey: ['market', 'categories'], retry: false,
    queryFn: async () => {
      const rail = await read<{ categories?: MarketCategory[] }>('/api/v1/discovery/categories?vertical=RETAIL');
      return (rail.categories ?? []).filter((entry) => entry.vertical === 'RETAIL');
    },
  });
  await client.prefetchQuery({
    queryKey: ['market', 'depth'], retry: false,
    queryFn: () => read<MarketDepth>('/api/v1/market/depth'),
  });
  if (marketTabVisible(client.getQueryData(['market', 'depth']))) {
    const params = new URLSearchParams({ sort: 'popular' });
    if (category) params.set('category', category);
    await client.prefetchInfiniteQuery({
      queryKey: ['market', 'items', category], retry: false,
      queryFn: () => read<{ items: MarketItem[]; nextCursor: string | null }>(`/api/v1/market/items?${params}`),
      initialPageParam: undefined as string | undefined,
    });
  }
  await categories;
  const state = dehydrate(client);
  client.clear();
  return state;
}

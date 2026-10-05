import { infiniteQueryOptions } from '@tanstack/react-query';
import { getMarketItems } from './customer';

export const marketItemsQuery = (category: string) => infiniteQueryOptions({
  queryKey: ['market', 'items', category],
  queryFn: ({ pageParam }) => getMarketItems({ category: category || undefined, cursor: pageParam }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  // Same short catalogue window as before. Store/cart reads remain live.
  staleTime: 5_000,
});

export function mayPrefetch(): boolean {
  if (typeof navigator === 'undefined' || navigator.onLine === false) return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !connection?.saveData && !['slow-2g', '2g'].includes(connection?.effectiveType ?? '');
}

import { HydrationBoundary } from '@tanstack/react-query';
import { loadMarket } from '@/lib/market-server';
import { MarketPrefetch } from '@/components/market-prefetch';

/** Public default catalogue in the first HTML. Layouts persist on category
 * navigation; the browser query cache supplies filtered views. */
export default async function MarketLayout({ children }: { children: React.ReactNode }) {
  return <HydrationBoundary state={await loadMarket('')}><MarketPrefetch>{children}</MarketPrefetch></HydrationBoundary>;
}

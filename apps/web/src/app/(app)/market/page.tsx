import { marketSeed } from '@/lib/browse-server';
import { MarketScreen } from './market-screen';

/**
 * [W2] The Market's first screen arrives in the page: the server reads it as a
 * GUEST (lib/browse-server.ts; shared for a minute) and hands the verdict, the
 * chips and the first goods to the Market as their first answers. "Show more"
 * still loads in the browser.
 */
export default async function MarketPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const requested = (await searchParams)['category'];
  const category = typeof requested === 'string' ? requested : '';
  return <MarketScreen seed={{ category, ...(await marketSeed(category)) }} />;
}

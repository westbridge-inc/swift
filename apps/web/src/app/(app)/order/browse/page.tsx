import { vendorListSeed } from '@/lib/browse-server';
import { CatalogueSearchBar } from '@/components/catalogue-search-bar';
import { BrowseScreen } from './browse-screen';

/**
 * [W2] A category's stores arrive in the page. The server reads the list as a
 * GUEST (lib/browse-server.ts; the answer is shared for a minute, and only for
 * the kinds of store this page offers) and hands it to the list as its first
 * answer.
 *
 * [row 110] The category's search bar is drawn here, on the server, and handed
 * to the list: a plain form, so the page's script does not grow (perf budget).
 */
export default async function BrowsePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const requested = (await searchParams)['type'];
  const type = typeof requested === 'string' ? requested : '';
  const seed = await vendorListSeed(type);
  return <BrowseScreen seed={seed ? { type, read: seed } : null} searchBar={<CatalogueSearchBar type={type} />} />;
}

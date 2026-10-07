import { vendorListSeed } from '@/lib/browse-server';
import { BrowseScreen } from './browse-screen';

/**
 * [W2] A category's stores arrive in the page. The server reads the list as a
 * GUEST (lib/browse-server.ts; the answer is shared for a minute, and only for
 * the kinds of store this page offers) and hands it to the list as its first
 * answer.
 */
export default async function BrowsePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const requested = (await searchParams)['type'];
  const type = typeof requested === 'string' ? requested : '';
  const seed = await vendorListSeed(type);
  return <BrowseScreen seed={seed ? { type, read: seed } : null} />;
}

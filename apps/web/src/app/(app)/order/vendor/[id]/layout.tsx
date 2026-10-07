import { vendorSeed } from '@/lib/browse-server';
import { StoreSeedProvider } from '@/components/browse-seed';

/**
 * [W2] A store's page arrives with its menu in it. The server reads the store
 * as a GUEST (no cookie, no person — lib/browse-server.ts); that answer is
 * shared for up to 30 seconds. The page re-reads the live menu once the copy
 * it was handed is a few seconds old, and the server re-checks every price and
 * every item when something is added and at checkout — the copy in the page is
 * never what an order is priced from.
 *
 * The page itself is drawn per request, not kept per store id: a made-up id
 * must never become a page the server stores.
 */
export default async function VendorLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  // vendorSeed reads only an id that can be a store id.
  return <StoreSeedProvider seed={await vendorSeed(id)}>{children}</StoreSeedProvider>;
}

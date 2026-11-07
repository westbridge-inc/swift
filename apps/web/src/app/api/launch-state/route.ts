import { appStoresState, webOrderingState } from '@/lib/launch-switch';

/**
 * [Item 7 · S1] The public site's switches as the server holds them right now,
 * for the few browser-side sentences that depend on them (the welcome page's
 * "Order on the web", the customer sign-up card, and [G11] the App Store and
 * Google Play links). Never cached: a flip shows on the next page load.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json(
    { webOrdering: webOrderingState(), appStores: appStoresState() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

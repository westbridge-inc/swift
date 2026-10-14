import { webOrderingState } from '@/lib/launch-switch';

/**
 * [Item 7 · S1] The public site's switch as the server holds it right now, for
 * the few browser-side sentences that depend on it (the welcome page's
 * "Order on the web", the customer sign-up card). Never cached: a flip shows
 * on the next page load.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ webOrdering: webOrderingState() }, { headers: { 'Cache-Control': 'no-store' } });
}

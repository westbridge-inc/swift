import { vendorSeed } from '@/lib/browse-server';
import { canonicalStorePath } from '@/components/storefront/store-path';

/**
 * [W6] One store page. A store used to have two: this address (by id) and
 * its storefront (by name, `/store/<slug>`). Every link, bookmark, shared
 * link and Home's "popular" card that still points here is sent, with a real
 * 301, to the store's one page — keeping only the item it opened at and a
 * scanned code's attribution, never anything else from the old query. (A page
 * could not answer 301: the app's loading screen starts the reply first.)
 *
 * The store is read as a GUEST (lib/browse-server.ts: no cookie, no person),
 * only for an id that can be a store id. A store the server does not show is
 * "not found" here, never a made-up address.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const seed = await vendorSeed(id);
  const slug = seed?.data.slug;
  if (typeof slug !== 'string' || slug.length === 0) {
    return new Response(NOT_FOUND, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  // Read the query the way a page receives it: a repeated name is a list
  // (so `src=qr&src=share` is not a scan).
  const query: Record<string, string | string[]> = {};
  for (const [name, value] of new URL(request.url).searchParams) {
    const seen = query[name];
    query[name] = seen === undefined ? value : [...[seen].flat(), value];
  }
  return new Response(null, {
    status: 301,
    // Relative, so the redirect never names an internal host behind the proxy.
    headers: { Location: canonicalStorePath(slug, query), 'Cache-Control': 'public, max-age=3600' },
  });
}

const NOT_FOUND = '<!doctype html><html lang="en-GY"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Store not found — Swift</title></head>'
  + '<body><main><h1>This store page is not available</h1><p>The link may be old, or this store may no longer be listed on Swift. Nothing has been ordered or charged.</p><p><a href="/">Browse stores on Swift</a></p></main></body></html>';

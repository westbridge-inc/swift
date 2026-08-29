import type { FastifyInstance } from 'fastify';
import { tenantCacheKey } from '../../utils/tenant-cache';

/**
 * The Home feed cache — ONE writer key, ONE invalidation pattern, built by the
 * same two lines so they can never drift apart again.
 *
 * History that earns this file its own module: the feed was written at
 * `t:<tenant>:home:<userId>:<lat>:<lng>` and three call sites invalidated with
 * a hand-written `home:${userId}:*`. The day the tenant prefix was added to the
 * writer and not to them, nothing was invalidated for months and nobody
 * noticed — a favourited store and the feed behind a just-placed order stayed
 * stale for the full TTL.
 *
 * The same class of bug reached the founder's phone on 2026-08-29 from the
 * other direction: cancelling an order did not touch this cache at all, so the
 * live-order card kept counting down the free-cancel window of an order that
 * no longer existed. Cancel paths live in THREE route files (store orders,
 * rides, courier), and the invalidator was private to one of them — which is
 * why it was never called from the other two. Exporting it here is the fix.
 */

/** Sixty seconds. The feed carries `holdExpiresAt` as an ABSOLUTE instant so
 *  a cached copy stays exactly true for its whole life; what it cannot stay
 *  true about is whether the order still exists — hence the invalidators. */
export const HOME_CACHE_TTL = 60;

/**
 * A signed-in customer's feed is keyed by the customer, NOT by the ambient
 * tenant context — and that is a deliberate departure from `tenantCacheKey`.
 *
 * The tenant prefix exists [SWIFT-SEC-CACHE] to stop two operators' users at
 * the same map cell reading each other's GEOGRAPHY-keyed caches. A per-user
 * key cannot leak that way: the id is globally unique and a user belongs to
 * exactly one tenant, so `home:<userId>` is already tenant-unique. What the
 * prefix DID do was make the key depend on the request that built it: the
 * feed is written by an optionally-authenticated GET and invalidated by a
 * required-auth POST, and they agree only because server.ts installs a
 * per-request tenant store before either runs. In a harness without that
 * hook (measured 2026-08-29) the feed landed at `t:_notenant:home:<id>` and
 * the invalidator searched `t:swift-default:home:<id>:*` — an agreement that
 * lives in a hook is one refactor away from not living anywhere. Keying the
 * user's feed by the user alone removes the dependency instead of guarding it.
 *
 * Guests have no id, so their geography-keyed feed keeps the tenant prefix.
 */
export function homeCacheKey(userId: string | undefined, lat: number | undefined, lng: number | undefined): string {
  const geo = `${lat ?? 'x'}:${lng ?? 'x'}`;
  return userId ? `home:${userId}:${geo}` : tenantCacheKey(`home:guest:${geo}`);
}

/**
 * Drop every cached Home feed belonging to one customer.
 *
 * The coordinates are part of the key, so the exact key cannot be rebuilt from
 * a userId alone and a pattern is unavoidable. SCAN rather than KEYS: this runs
 * on every favourite toggle, checkout and cancellation, and KEYS blocks the
 * whole Redis instance for the length of the scan.
 *
 * Call sites wrap this in `.catch(() => {})`: a cache that fails to clear must
 * degrade to "stale for up to a minute", never to a failed order action.
 */
export async function invalidateHomeCache(app: FastifyInstance, userId: string): Promise<void> {
  // Built from the same shape as homeCacheKey, and from the userId ALONE —
  // never from request context, for the reason above.
  const pattern = `home:${userId}:*`;
  const doomed: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await app.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    doomed.push(...batch);
  } while (cursor !== '0');
  if (doomed.length > 0) await app.redis.del(...doomed);
}

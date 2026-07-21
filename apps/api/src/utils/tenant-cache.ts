import { getTenantId } from '../plugins/tenant-context';

// ---------------------------------------------------------------------------
// Tenant-scoped Redis cache keys [SWIFT-SEC-CACHE].
//
// Several caches key a tenant-SPECIFIC value (a home feed, a supply/demand
// read that the dispatch query already tenant-filters) by geography alone —
// e.g. `avail:DRIVER:6.80:-58.16`. With one live tenant that's harmless, but
// at operator #2 a second tenant's user at the same ~1km cell would read the
// first tenant's cached value within the TTL: a cross-tenant leak whose ONLY
// vector is the key (the DB read underneath is correctly scoped).
//
// Prefixing the caller's tenant closes it by construction. On a single-tenant
// deploy every key gains the same `swift-default:` segment (a one-time cache
// miss on rollout, then identical behavior). Unauthenticated callers have no
// tenant → `_notenant` (a white-label guest surface maps to its tenant via
// client/app config, a separate architecture decision — see SEC register).
// ---------------------------------------------------------------------------

/** Prefix a cache key with the current request's tenant. */
export function tenantCacheKey(base: string): string {
  return `t:${getTenantId() ?? '_notenant'}:${base}`;
}

import { describe, it, expect } from 'vitest';
import { tenantCacheKey } from '../utils/tenant-cache';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';

// ---------------------------------------------------------------------------
// SWIFT-SEC-CACHE — geo-cell caches (avail / demand / home) key a
// tenant-SPECIFIC value by geography alone. The underlying DB reads are
// tenant-scoped; the cache key was the sole cross-tenant leak vector at
// operator #2. tenantCacheKey prefixes the caller's tenant so two operators'
// users at the same cell can never collide on each other's cached value.
// ---------------------------------------------------------------------------

describe('tenant-scoped cache keys [SWIFT-SEC-CACHE]', () => {
  it('the same geo key resolves to DIFFERENT redis keys per tenant', async () => {
    const base = 'avail:DRIVER:6.80:-58.16';
    const a = await runWithTenant('tenant-a', async () => tenantCacheKey(base));
    const b = await runWithTenant('tenant-b', async () => tenantCacheKey(base));
    expect(a).not.toBe(b);
    expect(a).toBe('t:tenant-a:avail:DRIVER:6.80:-58.16');
    expect(b).toBe('t:tenant-b:avail:DRIVER:6.80:-58.16');
  });

  it('the same tenant + same cell is a stable cache hit (no accidental miss)', async () => {
    const k1 = await runWithTenant('tenant-a', async () => tenantCacheKey('demand:RIDER:7.10:-58.40'));
    const k2 = await runWithTenant('tenant-a', async () => tenantCacheKey('demand:RIDER:7.10:-58.40'));
    expect(k1).toBe(k2);
  });

  it('an unauthenticated caller (no tenant) gets a distinct, non-colliding namespace', async () => {
    const guest = await runWithoutTenant(async () => tenantCacheKey('home:guest:6.80:-58.16'));
    const tenantA = await runWithTenant('tenant-a', async () => tenantCacheKey('home:guest:6.80:-58.16'));
    expect(guest).toBe('t:_notenant:home:guest:6.80:-58.16');
    expect(guest).not.toBe(tenantA); // a guest can never read a bound tenant's cached feed
  });
});

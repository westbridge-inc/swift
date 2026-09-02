import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { apiFamilyOf, apiPathOf, isVendorScopedUrl, VENDOR_SCOPED_FAMILY, VENDOR_STORE_HEADER } from './vendorScope';

// ---------------------------------------------------------------------------
// [MOB-010 / TST-010] Exactly one endpoint family carries the store header.
//
// The decision is by path, so the proof is over paths: every family the app
// calls, relative and absolute, with queries and fragments, and — as a census
// over the real api.ts — every literal endpoint path the client knows, scoped
// vendor if and only if its family is `vendor`.
// ---------------------------------------------------------------------------

describe('the vendor family, and only the vendor family, is store-scoped', () => {
  it('names the header and the family', () => {
    expect(VENDOR_STORE_HEADER).toBe('x-vendor-id');
    expect(VENDOR_SCOPED_FAMILY).toBe('vendor');
  });

  it('resolves the API-relative path for relative and absolute URLs, dropping query and fragment', () => {
    expect(apiPathOf('/vendor/items')).toBe('/vendor/items');
    expect(apiPathOf('vendor/items?x=1')).toBe('/vendor/items');
    expect(apiPathOf('https://api.swift.gy/api/v1/vendor/items?x=1#f')).toBe('/vendor/items');
    expect(apiPathOf('http://10.0.2.2:3000/api/v1/customer/home')).toBe('/customer/home');
    expect(apiPathOf('/api/v1/vendor')).toBe('/vendor');
    expect(apiPathOf('/api/v1')).toBe('/');
    expect(apiPathOf('')).toBe('/');
    expect(apiPathOf(undefined)).toBe('/');
    expect(apiPathOf('not a url://').startsWith('/')).toBe(true); // nonsense stays nonsense — and is never the vendor family
    expect(isVendorScopedUrl('not a url://')).toBe(false);
  });

  it('scopes the vendor family and nothing that merely looks like it', () => {
    for (const url of ['/vendor', '/vendor/', '/vendor/items', '/vendor/orders/1/accept', 'vendor/items', '/api/v1/vendor/items', 'https://api.swift.gy/api/v1/vendor/items?a=1']) {
      expect(isVendorScopedUrl(url), url).toBe(true);
      expect(apiFamilyOf(url), url).toBe('vendor');
    }
    for (const url of [
      '/auth/me', '/customer/home', '/rider/online', '/driver/trips', '/ads/serve', '/services/bookings', '/rides/quote', '/safety/sos', '/courier/quote',
      '/verification/documents', '/search', '/chat/threads', '/blocks', '/places/autocomplete', '/reports', '/partner/apply', '/market/items', '/discovery/home',
      '/vendor-discovery/nearby', '/vendors/abc', '/vendorx/items', '/public/storefronts/x', '/', '', '/api/v1', 'https://api.swift.gy/api/v1/customer/home?vendor=1',
      '/customer/vendor/items', // vendor as a LATER segment is not the family
    ]) {
      expect(isVendorScopedUrl(url), url).toBe(false);
    }
    expect(apiFamilyOf('/customer/vendor/items')).toBe('customer');
    expect(apiFamilyOf('/')).toBeNull();
  });

  it('census: every literal endpoint path in services/api.ts is store-scoped exactly when its family is vendor', () => {
    const src = readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8');
    const urls = [...src.matchAll(/api\.(?:get|post|put|patch|delete)\(\s*(['`])([^'`]*)\1/g)].map((m) => m[2]!);
    expect(urls.length).toBeGreaterThan(150);
    const families = new Set<string>();
    for (const url of urls) {
      const family = url.replace(/^\//, '').split('/')[0]!.split('?')[0]!.replace(/\$\{.*$/, '');
      families.add(family);
      expect(isVendorScopedUrl(url), url).toBe(family === 'vendor');
    }
    // the client knows more than one family — the scope must not be "everything"
    expect(families.has('vendor')).toBe(true);
    expect(families.size).toBeGreaterThan(10);
  });
});

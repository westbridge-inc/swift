// VENDOR STORE SCOPE [MOB-010 / TST-010] — pure, no RN imports.
//
// The multi-store switch selects a store, and the API's VENDOR routes read it
// from the `x-vendor-id` header (apps/api vendor.routes.ts — nothing else on
// the server reads it). The Axios interceptor used to attach that header to
// EVERY request whenever a store was selected: auth, customer, mover,
// advertiser, safety and public calls all carried a vendor tenant id that
// their contracts never accept — tenancy metadata crossing API domains, and a
// header any future handler could accidentally trust.
//
// The header is vendor-scoped now: exactly the `/vendor` endpoint family
// carries it, decided by the request path, and a caller cannot smuggle it onto
// another family.

export const VENDOR_STORE_HEADER = 'x-vendor-id';
/** The one endpoint family whose contract accepts store context. */
export const VENDOR_SCOPED_FAMILY = 'vendor';

const API_PREFIX = /^\/api\/v1(?=\/|$)/;

/** The path of a request relative to the API root, for a relative (`/vendor/items`, `vendor/items`) or an absolute URL. */
export function apiPathOf(url: string | undefined | null): string {
  if (!url) return '/';
  let path = url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try { path = new URL(url).pathname; } catch { return '/'; }
  }
  path = path.split('?')[0]!.split('#')[0]!;
  if (!path.startsWith('/')) path = `/${path}`;
  return path.replace(API_PREFIX, '') || '/';
}

/** The endpoint family: the first path segment under the API root (`vendor`, `customer`, `auth`, …), or null at the root. */
export function apiFamilyOf(url: string | undefined | null): string | null {
  const first = apiPathOf(url).split('/').filter(Boolean)[0];
  return first ?? null;
}

/** True exactly for the vendor endpoint family — the only family that carries the store header. */
export function isVendorScopedUrl(url: string | undefined | null): boolean {
  return apiFamilyOf(url) === VENDOR_SCOPED_FAMILY;
}

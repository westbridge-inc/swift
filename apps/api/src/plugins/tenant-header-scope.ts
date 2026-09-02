import type { FastifyInstance } from 'fastify';
import { AppError } from '../utils/errors';
import { unexpectedTenantHeaderCounter } from './observability';

/**
 * [MOB-010] The vendor store header belongs to the vendor endpoint family.
 *
 * `x-vendor-id` is the multi-store switch: a manager with several stores says
 * which one a VENDOR request is about, and `vendor.routes.ts` is the only code
 * on this server that reads it. The mobile client used to attach it to EVERY
 * request whenever a store was selected — auth, customer, mover, advertiser,
 * safety, public — so tenancy metadata crossed API domains, and any handler
 * outside the vendor family that ever started trusting the header would have
 * trusted an irrelevant tenant.
 *
 * The client is fixed to send it only to `/api/v1/vendor/*` (apps/mobile
 * lib/vendorScope.ts). This hook is the server's own half, and the rollback
 * for the client fix: outside the vendor family the header is IGNORED (stripped
 * before any handler sees it, default — old installs in the field still send
 * it) or REJECTED with 400 UNEXPECTED_TENANT_HEADER
 * (TENANT_HEADER_OUTSIDE_VENDOR=reject, once every client is on the scoped
 * header), and every occurrence is counted per endpoint family.
 */
export const VENDOR_STORE_HEADER = 'x-vendor-id';
export const VENDOR_SCOPED_PREFIX = '/api/v1/vendor';

export type TenantHeaderMode = 'ignore' | 'reject';

export function tenantHeaderMode(env: Record<string, string | undefined> = process.env): TenantHeaderMode {
  return env['TENANT_HEADER_OUTSIDE_VENDOR'] === 'reject' ? 'reject' : 'ignore';
}

/** The request path without query or fragment. */
function pathOf(url: string): string {
  return url.split('?')[0]!.split('#')[0]!;
}

/** True exactly for the vendor endpoint family — the only family whose contract accepts store context. */
export function isVendorScopedPath(url: string): boolean {
  const path = pathOf(url);
  return path === VENDOR_SCOPED_PREFIX || path.startsWith(`${VENDOR_SCOPED_PREFIX}/`);
}

/** The endpoint family a path belongs to, for the metric: the first segment under /api/v1, else the first segment, else root. */
export function apiFamilyOf(url: string): string {
  const path = pathOf(url);
  const versioned = /^\/api\/v1\/([^/]+)/.exec(path);
  if (versioned) return versioned[1]!;
  return path.split('/').filter(Boolean)[0] ?? 'root';
}

export function registerTenantHeaderScope(app: FastifyInstance, mode: TenantHeaderMode = tenantHeaderMode()): void {
  app.addHook('onRequest', async (request) => {
    if (request.headers[VENDOR_STORE_HEADER] === undefined) return;
    if (isVendorScopedPath(request.url)) return;
    const family = apiFamilyOf(request.url);
    unexpectedTenantHeaderCounter.labels(mode === 'reject' ? 'rejected' : 'ignored', family).inc();
    if (mode === 'reject') {
      throw new AppError(400, 'UNEXPECTED_TENANT_HEADER', `${VENDOR_STORE_HEADER} is accepted only by the vendor endpoint family`);
    }
    // Ignored: no handler outside the vendor family ever sees it.
    delete request.headers[VENDOR_STORE_HEADER];
  });
}

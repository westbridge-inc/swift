// Client-side mirror of the server's vendor role guards (apps/api
// vendor.routes.ts requireVendor(..., 'MANAGER')). The API is the authority —
// it 403s a STAFF token on manager-only routes regardless of the UI. This just
// keeps STAFF from being shown a control that would fail or a money figure the
// analytics endpoint refuses them (a 403 arrives as empty data → a misleading
// GYD 0). Keep this matrix in lockstep with the route guards.

export type VendorAccessRole = 'OWNER' | 'MANAGER' | 'STAFF';

export interface VendorSurface {
  /** GET /analytics/* (revenue, queue value, today's sales) — MANAGER+. */
  canSeeMoney: boolean;
  /** PUT /vendor/toggle-open (open/close the store) — MANAGER+. */
  canToggleOpen: boolean;
  /** The self-delivery setting (routes deliveries to the vendor) — MANAGER+. */
  canSetSelfDelivery: boolean;
  /** PUT /vendor/toggle-orders + GET /orders — any member, incl. floor STAFF. */
  canToggleOrders: boolean;
}

/** Resolve what a vendor member's role may see/do on the ops board. Absent or
 *  unrecognised roles fall back to least privilege (STAFF). */
export function vendorSurfaceForRole(role: VendorAccessRole | null | undefined): VendorSurface {
  const manager = role === 'OWNER' || role === 'MANAGER';
  return {
    canSeeMoney: manager,
    canToggleOpen: manager,
    canSetSelfDelivery: manager,
    canToggleOrders: true,
  };
}

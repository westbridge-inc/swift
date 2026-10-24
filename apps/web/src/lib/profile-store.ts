/** The store record inside GET /vendor/profile, as the app reads it. */
export interface HubStore {
  id?: string; name?: string; vendorType?: string; status?: string; isVerified?: boolean;
  isCurrentlyOpen?: boolean; acceptingOrders?: boolean; selfDeliveryEnabled?: boolean;
  /** [O-2] "Ask for the pickup code" (absent on an older server). */
  requirePickupCode?: boolean;
  operatingHours?: unknown; _count?: { orders?: number; items?: number };
}

/** GET /vendor/profile answers `{ id, userId, vendors: [...], myRole }`; the store
 *  a page works is the selected one, else the first — exactly as the app picks
 *  it (apps/mobile/src/hooks/vendorops.ts useVendorProfile). */
export function pickProfileStore(profile: unknown, storeId: string | null): HubStore | undefined {
  const vendors = (profile as { vendors?: unknown } | null | undefined)?.vendors;
  const list = Array.isArray(vendors) ? (vendors as HubStore[]) : [];
  return list.find((v) => v.id === storeId) ?? list[0];
}

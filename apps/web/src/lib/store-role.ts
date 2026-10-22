'use client';

import { useQuery } from '@tanstack/react-query';
import { vendorSurfaceForRole } from '../../../mobile/src/lib/vendorRbac';
import { storeKey, useStoreId } from './store-scope';
import { safeVendorRole, type VendorMemberRole } from './vendor-hub';
import { getStores } from './vendor-api';

/**
 * This login's role at the SELECTED store, and what that role may see and do —
 * the app's own matrix (apps/mobile/src/lib/vendorRbac.ts, imported as is).
 * The server answers `myRole` for the store named by the request, so the read
 * is keyed by store: switching to a store where this login is staff re-reads
 * it instead of keeping the last store's role (Opus delta review of #1601,
 * S3-A). Unknown or loading reads as least privilege, as in the app.
 * `failed`: the read failed and there is no answer at all (not a failed
 * re-read behind a good one), so a page can say it could not check.
 */
export function useStoreRole(): { role: VendorMemberRole | undefined; manager: boolean; surface: ReturnType<typeof vendorSurfaceForRole>; known: boolean; failed: boolean } {
  const storeId = useStoreId();
  const q = useQuery({ queryKey: storeKey(storeId, 'my-role'), queryFn: getStores });
  const role = safeVendorRole(q.data?.myRole);
  return { role, manager: role === 'OWNER' || role === 'MANAGER', surface: vendorSurfaceForRole(role), known: q.isSuccess, failed: q.isError && q.data === undefined };
}

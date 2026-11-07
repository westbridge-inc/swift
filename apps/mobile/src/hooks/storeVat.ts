import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { vendorApi } from '../services/api';
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { getAuthSessionSnapshot, requireAuthSessionSnapshot, useAuthStore } from '../stores/authStore';
import { useVendorPreview } from '../stores/vendorPreview';
import { previewMutation } from '../lib/vendorPreviewData';
import { guardVendorOperation } from './useVendorMutation';
import type { StoreVatMode } from '../lib/storeVat';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5] The store's VAT on the phone (OWNER only; the API refuses anyone else). The owner says
// whether the business is VAT-registered with the GRA, gives the VAT number on its certificate and sends the
// certificate (hooks/storeVatCertificate.ts); a PERSON at Swift checks it. Nothing a customer sees changes until then. Every read and write is
// bound to the account and the store it started on (a switch mid-flight is refused, as for billing).
// ---------------------------------------------------------------------------

export type StoreVatStatus = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';
export interface StoreVatView {
  available: boolean;
  status: StoreVatStatus;
  mode: 'PRICES_INCLUDE_VAT' | 'ADD_VAT_AT_CHECKOUT' | null;
  /** [owner ruling 31 Oct 2026] An approved store's change of choice, waiting for a person (an older server sends none). */
  modeRequested?: 'PRICES_INCLUDE_VAT' | 'ADD_VAT_AT_CHECKOUT' | null;
  vatRegistrationNumber: string | null;
  effective: boolean;
  /** [VAT-DOCS] True while Swift adds VAT to the prices this store types (an older server sends none). */
  addsVatToPrices?: boolean;
  approved: { number: string | null; registeredName: string | null; effectiveFrom: string | null; reviewedAt: string | null } | null;
  reviewNote: string | null;
  certificate: { id: string; status: string; state: string; reviewNote: string | null; createdAt: string; reviewedAt: string | null } | null;
  ratePercent: number;
  modesOffered: string[];
}

export async function unwrap<T>(p: Promise<{ data?: { data?: unknown } }>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}

export function bound<T>(storeId: string | null, run: (session: ReturnType<typeof requireAuthSessionSnapshot>) => Promise<T>): Promise<T> {
  const session = requireAuthSessionSnapshot();
  return run(session).then((answer) => {
    const current = getAuthSessionSnapshot();
    if (current?.userId !== session.userId || current?.generation !== session.generation || useStoreSwitcher.getState().selectedStoreId !== storeId) {
      throw new Error('The store changed. Open the current store and try again.');
    }
    return answer;
  });
}

/** [REVIEW-G #2103 S4-2] A VAT write sends nothing in a sample preview, checked at the send (as guardVendorOperation checks
 *  the store). The screens hide VAT in a preview too; this is the hook-layer guard. It says preview is read-only, as every
 *  preview write does. */
export function previewReadOnly<A extends unknown[], R>(send: (...args: A) => Promise<R>): (...args: A) => Promise<R | undefined> {
  return async (...args) => {
    if (useVendorPreview.getState().previewType != null) {
      await previewMutation().mutateAsync();
      return undefined;
    }
    return send(...args);
  };
}

export function useStoreVat(enabled: boolean) {
  const storeId = useStoreSwitcher((s) => s.selectedStoreId);
  const principal = useAuthStore((s) => s.user?.id);
  const generation = useAuthStore((s) => s.sessionGeneration);
  return useQuery({
    queryKey: ['vendor', 'vat', storeId, principal, generation],
    queryFn: () => bound(storeId, (session) => unwrap<StoreVatView>(vendorApi.vat(session, storeId))),
    enabled,
  });
}

export function useUpdateStoreVat() {
  const qc = useQueryClient();
  const storeId = useStoreSwitcher((s) => s.selectedStoreId);
  return useMutation({
    mutationFn: guardVendorOperation(previewReadOnly((answer: { registered: boolean; vatRegistrationNumber?: string; mode?: StoreVatMode }) =>
      bound(storeId, (session) => unwrap<StoreVatView>(vendorApi.updateVat(
        // [REVIEW-M #2256 N1] The choice only when the store made one: never a built-in default that could ask to switch it.
        answer.registered ? { registered: true, vatRegistrationNumber: answer.vatRegistrationNumber, ...(answer.mode ? { mode: answer.mode } : {}) } : { registered: false },
        session, storeId,
      ))))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'vat'] }),
  });
}

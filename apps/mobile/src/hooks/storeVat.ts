import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { vendorApi } from '../services/api';
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { getAuthSessionSnapshot, requireAuthSessionForPrincipal, requireAuthSessionSnapshot, useAuthStore } from '../stores/authStore';
import { guardVendorOperation } from './useVendorMutation';
import { useUploadFile } from './verification';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5] The store's VAT on the phone (OWNER only; the API refuses anyone else). The owner says
// whether the business is VAT-registered with the GRA, gives the VAT number on its certificate and sends the
// certificate; a PERSON at Swift checks it. Nothing a customer sees changes until then. Every read and write is
// bound to the account and the store it started on (a switch mid-flight is refused, as for billing).
// ---------------------------------------------------------------------------

export type StoreVatStatus = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';
export interface StoreVatView {
  available: boolean;
  status: StoreVatStatus;
  mode: 'PRICES_INCLUDE_VAT' | 'ADD_VAT_AT_CHECKOUT' | null;
  vatRegistrationNumber: string | null;
  effective: boolean;
  approved: { number: string | null; registeredName: string | null; effectiveFrom: string | null; reviewedAt: string | null } | null;
  reviewNote: string | null;
  certificate: { id: string; status: string; state: string; reviewNote: string | null; createdAt: string; reviewedAt: string | null } | null;
  ratePercent: number;
  modesOffered: string[];
}

/** The privacy-notice version the document consent tick is recorded against (hooks/verification uses the same). */
const PRIVACY_NOTICE_VERSION = 'v1';

async function unwrap<T>(p: Promise<{ data?: { data?: unknown } }>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}

function bound<T>(storeId: string | null, run: (session: ReturnType<typeof requireAuthSessionSnapshot>) => Promise<T>): Promise<T> {
  const session = requireAuthSessionSnapshot();
  return run(session).then((answer) => {
    const current = getAuthSessionSnapshot();
    if (current?.userId !== session.userId || current?.generation !== session.generation || useStoreSwitcher.getState().selectedStoreId !== storeId) {
      throw new Error('The store changed. Open the current store and try again.');
    }
    return answer;
  });
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
    mutationFn: guardVendorOperation((answer: { registered: boolean; vatRegistrationNumber?: string }) =>
      bound(storeId, (session) => unwrap<StoreVatView>(vendorApi.updateVat(
        answer.registered ? { registered: true, vatRegistrationNumber: answer.vatRegistrationNumber, mode: 'PRICES_INCLUDE_VAT' } : { registered: false },
        session, storeId,
      )))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'vat'] }),
  });
}

/** Upload the picked certificate photo (scanned, cleaned, encrypted by the server), then file it for a person's check. */
export function useSendVatCertificate() {
  const qc = useQueryClient();
  const upload = useUploadFile();
  const storeId = useStoreSwitcher((s) => s.selectedStoreId);
  return useMutation({
    mutationFn: guardVendorOperation(async (file: { uri: string; name: string; type: string }) => {
      const owner = requireAuthSessionSnapshot();
      const fileUrl = await upload.mutateAsync({ ...file, authSession: owner });
      const current = requireAuthSessionForPrincipal(owner);
      return bound(storeId, () => unwrap<StoreVatView>(vendorApi.sendVatCertificate(
        { fileUrl, consent: true, privacyNoticeVersion: PRIVACY_NOTICE_VERSION, consentTick: 'document_v1' }, current, storeId,
      )));
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'vat'] }),
  });
}

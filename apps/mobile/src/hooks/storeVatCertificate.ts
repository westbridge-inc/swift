import { useMutation, useQueryClient } from '@tanstack/react-query';
import { vendorApi } from '../services/api';
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { requireAuthSessionForPrincipal, requireAuthSessionSnapshot } from '../stores/authStore';
import { guardVendorOperation } from './useVendorMutation';
import { useUploadFile } from './verification';
import { bound, previewReadOnly, unwrap, type StoreVatView } from './storeVat';
import type { StoreVatMode } from '../lib/storeVat';

// [STORE-VAT · owner O-5] The store's GRA VAT certificate, sent from the phone (OWNER only). Kept apart from
// hooks/storeVat.ts so the screens that only READ the store's VAT never load the document upload.

/** The privacy-notice version the document consent tick is recorded against (hooks/verification uses the same). */
const PRIVACY_NOTICE_VERSION = 'v1';

/** Upload the picked certificate photo (scanned, cleaned, encrypted by the server), then file it for a person's check.
 *  [VAT-DOCS · owner 30 Oct 2026] `claim`: the VAT number and how the prices relate to VAT, sent WITH the certificate in
 *  one submission (a store that never said yes before must send both). */
export function useSendVatCertificate() {
  const qc = useQueryClient();
  const upload = useUploadFile();
  const storeId = useStoreSwitcher((s) => s.selectedStoreId);
  return useMutation({
    mutationFn: guardVendorOperation(previewReadOnly(async (file: { uri: string; name: string; type: string; claim?: { vatRegistrationNumber: string; mode: StoreVatMode } }) => {
      const owner = requireAuthSessionSnapshot();
      const { claim, ...picked } = file;
      const fileUrl = await upload.mutateAsync({ ...picked, authSession: owner });
      const current = requireAuthSessionForPrincipal(owner);
      return bound(storeId, () => unwrap<StoreVatView>(vendorApi.sendVatCertificate(
        { fileUrl, consent: true, privacyNoticeVersion: PRIVACY_NOTICE_VERSION, consentTick: 'document_v1', ...(claim ?? {}) }, current, storeId,
      )));
    })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'vat'] }),
  });
}

import { apiFetch } from './auth';

// [STORE-VAT · perf-budget] The store's VAT calls live here, not in vendor-api.ts: next build copies vendor-api into the
// dashboard layout AND each page, so every dashboard page carried these calls twice. Only the pages that use them load them.
const V = '/api/v1/vendor';

// ── [STORE-VAT · owner O-5] The store's VAT ─────────────────────────────────
// The owner says whether the business is VAT-registered with the GRA, gives the number on its certificate and sends
// the certificate; a PERSON at Swift checks it. Nothing a customer sees changes until then (the API decides).
export type StoreVatStatus = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';
export interface StoreVatView {
  /** False while Swift's STORE_VAT switch is off: nobody can start VAT. */
  available: boolean;
  status: StoreVatStatus;
  mode: 'PRICES_INCLUDE_VAT' | 'ADD_VAT_AT_CHECKOUT' | null;
  vatRegistrationNumber: string | null;
  /** True while this store's new orders carry VAT. */
  effective: boolean;
  approved: { number: string | null; registeredName: string | null; effectiveFrom: string | null; reviewedAt: string | null } | null;
  reviewNote: string | null;
  certificate: { id: string; status: string; state: string; reviewNote: string | null; createdAt: string; reviewedAt: string | null } | null;
  ratePercent: number;
  modesOffered: string[];
  sources: string[];
}
export const getStoreVat = () => apiFetch(`${V}/vat`).then((r) => r.data as StoreVatView);
export const updateStoreVat = (body: { registered: boolean; vatRegistrationNumber?: string | null; mode?: 'PRICES_INCLUDE_VAT' }) =>
  apiFetch(`${V}/vat`, { method: 'PUT', body: JSON.stringify(body) }).then((r) => r.data as StoreVatView);
/** The certificate file goes through the ordinary document upload (scanned, cleaned, encrypted), then to the store's
 *  VAT route, which files it for a person's check. The owner ticked the document consent box first. */
export const sendVatCertificate = async (file: File) => {
  const form = new FormData();
  form.append('file', file);
  const { url } = await apiFetch('/api/v1/verification/upload', { method: 'POST', body: form }).then((r) => r.data as { url: string });
  return apiFetch(`${V}/vat/certificate`, {
    method: 'POST',
    body: JSON.stringify({ fileUrl: url, consent: true, privacyNoticeVersion: 'web-v1', consentTick: 'document_v1' }),
  }).then((r) => r.data as StoreVatView);
};

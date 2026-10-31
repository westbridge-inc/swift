// [OPEN-EARLY PR-2 · owner 31 Oct 2026] A store's documents on the website: the phone's calls
// (apps/mobile services/api.ts verificationApi + vendorApi own-name, hooks/verification useUploadDocument), kept apart
// from vendor-api.ts so only the Documents page loads them. Every request carries the selected store (x-vendor-id,
// lib/auth apiFetch): the own-name declaration is the selected store's; the checklist is the owner's for that type.
import { apiFetch } from './auth';
import {
  DOCUMENT_CONSENT_TICK, OWN_NAME_DECLARATION_VERSION, POLICE_CLEARANCE_DOC, POLICE_CLEARANCE_TICK, type StoreDocumentStatus,
} from './store-documents';

/** [DOC-CONSENT S4] How the person gave the document tick for this upload: ticked on this visit, or their grant on record. */
export type StoreUploadConsentVia = 'checkbox' | 'record';

/** Why the list's tick cannot file a police clearance (a programming error: no page offers it). */
export const POLICE_NEEDS_OWN_CONSENT = 'A police clearance is sent only with its own consent.';

/** GET /verification/status?role=<store type>: the checklist, the optional list, the documents and the tick on record. */
export const getStoreDocumentStatus = (role: string) =>
  apiFetch(`/api/v1/verification/status?role=${encodeURIComponent(role)}`).then((r) => r.data as StoreDocumentStatus);

/** POST /verification/upload: the file (JPEG, PNG, WebP or PDF), scanned and stored encrypted; answers its reference. */
export const uploadStoreDocumentFile = (file: File) => {
  const form = new FormData();
  form.append('file', file);
  return apiFetch('/api/v1/verification/upload', { method: 'POST', body: form }).then((r) => r.data as { url: string });
};

/**
 * POST /verification/documents: the same body as the phone (hooks/verification useUploadDocument): the store type, the
 * document, the stored file, the consent (DPA §3.5) with the website's privacy-notice version (as the rider page and
 * the VAT card), the checklist's tick (`document_v1`, recorded in the consent ledger against its exact words) and how
 * it was given.
 */
export const submitStoreDocument = async (v: { role: string; docType: string; fileUrl: string; consentVia: StoreUploadConsentVia }) => {
  // [POLICE-CLEARANCE CONSENT] A police clearance is never filed under the list's tick: only submitPoliceClearance
  // (its own consent) sends one. Refused before anything leaves the browser.
  if (v.docType === POLICE_CLEARANCE_DOC) throw new Error(POLICE_NEEDS_OWN_CONSENT);
  return apiFetch('/api/v1/verification/documents', {
    method: 'POST',
    body: JSON.stringify({
      role: v.role,
      docType: v.docType,
      fileUrl: v.fileUrl,
      consent: true,
      privacyNoticeVersion: 'web-v1',
      consentTick: DOCUMENT_CONSENT_TICK,
      consentVia: v.consentVia,
    }),
  }).then((r) => r.data);
};

/** [POLICE-CLEARANCE CONSENT] The clearance's own tick and the version of the words shown beside it. */
export type PoliceClearanceConsentGiven = { tick: typeof POLICE_CLEARANCE_TICK; version: string };

/**
 * [POLICE-CLEARANCE CONSENT] POST /verification/documents for a police clearance: the phone's body with its own consent
 * (hooks/verification useUploadDocument with `consent`) — the clearance's tick and the words' version in place of the
 * list's document tick, given by the card's own box on this visit (`checkbox`). The checklist is a Services business's
 * (SERVICE) or a mover's (MOVER, a taxi driver's); nothing is sent without the tick and a version.
 */
export const submitPoliceClearance = async (v: { role: 'SERVICE' | 'MOVER'; fileUrl: string; consent: PoliceClearanceConsentGiven }) => {
  if (v.consent?.tick !== POLICE_CLEARANCE_TICK || typeof v.consent.version !== 'string' || v.consent.version.length === 0) {
    throw new Error(POLICE_NEEDS_OWN_CONSENT);
  }
  return apiFetch('/api/v1/verification/documents', {
    method: 'POST',
    body: JSON.stringify({
      role: v.role,
      docType: POLICE_CLEARANCE_DOC,
      fileUrl: v.fileUrl,
      consent: true,
      privacyNoticeVersion: 'web-v1',
      consentTick: v.consent.tick,
      consentVersion: v.consent.version,
      consentVia: 'checkbox',
    }),
  }).then((r) => r.data);
};

/**
 * [POLICE-CLEARANCE CONSENT] POST /verification/police-clearance/withdraw { role }: the person withdraws their clearance
 * at any time (the phone's useWithdrawPoliceClearance). The API stops using it, erases it (a legal hold keeps the bytes,
 * never the use) and answers what happened, which the card says in the phone's words (policeWithdrawOutcome).
 */
export const withdrawPoliceClearance = (role: 'SERVICE' | 'MOVER') =>
  apiFetch('/api/v1/verification/police-clearance/withdraw', { method: 'POST', body: JSON.stringify({ role }) }).then((r) => r.data as unknown);

/** [ROLE-DOCS] Sign "I trade under my own name" for the selected store (the same call as sign-up and the phone). */
export const signStoreOwnName = () =>
  apiFetch('/api/v1/vendor/onboarding/own-name', { method: 'POST', body: JSON.stringify({ accept: true, attestationVersion: OWN_NAME_DECLARATION_VERSION }) }).then((r) => r.data);

/** [ROLE-DOCS] The selected store uses a registered business name after all: it needs its business registration again. */
export const dropStoreOwnName = () =>
  apiFetch('/api/v1/vendor/onboarding/own-name', { method: 'DELETE' }).then((r) => r.data);

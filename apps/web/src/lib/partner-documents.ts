'use client';

// [DOCS-1 · owner case] A partner's verification documents on the web — the
// same API the phone app uses (GET /verification/status, POST /verification/
// upload, POST /verification/documents). A store owner and a mover both see
// each required document's state, the reviewer's reason when one was turned
// down, and an upload for THAT document alone: a rejected document never means
// starting the application again.
import { apiFetch } from './auth';

/** The checklist roles the API knows: a mover, or a store by its kind. */
export type ChecklistRole = 'MOVER' | 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';

export interface PartnerDocument {
  id: string;
  docType: string;
  status: string;
  expiresAt: string | null;
  reviewNote: string | null;
  createdAt: string;
}

export interface DocumentStatus {
  checklist: string[];
  documents: PartnerDocument[];
  missing: string[];
  vehicleType?: string | null;
  roleVerified: boolean;
}

export function getDocumentStatus(role: ChecklistRole, vehicleType?: string): Promise<DocumentStatus> {
  const query = new URLSearchParams({ role });
  if (vehicleType) query.set('vehicleType', vehicleType);
  return apiFetch(`/api/v1/verification/status?${query}`).then((response) => response.data as DocumentStatus);
}

export function uploadDocumentFile(file: File): Promise<{ url: string }> {
  const form = new FormData();
  form.append('file', file);
  return apiFetch('/api/v1/verification/upload', { method: 'POST', body: form }).then((response) => response.data as { url: string });
}

/** Files one document of the checklist. `consent: true` is sent only after the
 *  uploader ticked the privacy-notice box (DPA §3.5). */
export function submitDocument(role: ChecklistRole, docType: string, fileUrl: string) {
  return apiFetch('/api/v1/verification/documents', {
    method: 'POST',
    body: JSON.stringify({ role, docType, fileUrl, consent: true, privacyNoticeVersion: 'web-v1' }),
  });
}

// ── What each document's row says and allows ────────────────────────────────

/** The server accepts a renewal of an approved document from 30 days before it
 *  expires (verification.service REMINDER_WINDOW_DAYS). */
export const RENEWAL_WINDOW_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

export type DocumentState = 'MISSING' | 'IN_REVIEW' | 'APPROVED' | 'EXPIRING' | 'EXPIRED' | 'REJECTED';

const isLive = (doc: PartnerDocument, now: number) => doc.status === 'APPROVED' && (!doc.expiresAt || new Date(doc.expiresAt).getTime() > now);

/**
 * The submission that speaks for a document — the phone app's precedence
 * (DocumentChecklist.latestDoc): one in review, else the current approval,
 * else the newest (a rejection or an expiry, which re-opens the upload).
 */
export function currentDocument(documents: PartnerDocument[], docType: string, now = Date.now()): PartnerDocument | undefined {
  const mine = documents
    .filter((doc) => doc.docType === docType)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return mine.find((doc) => doc.status === 'PENDING') ?? mine.find((doc) => isLive(doc, now)) ?? mine[0];
}

export function documentState(doc: PartnerDocument | undefined, now = Date.now()): DocumentState {
  if (!doc) return 'MISSING';
  if (doc.status === 'PENDING') return 'IN_REVIEW';
  if (doc.status === 'REJECTED') return 'REJECTED';
  if (doc.status === 'APPROVED') {
    if (!doc.expiresAt) return 'APPROVED';
    const left = new Date(doc.expiresAt).getTime() - now;
    if (left <= 0) return 'EXPIRED';
    return left <= RENEWAL_WINDOW_DAYS * DAY ? 'EXPIRING' : 'APPROVED';
  }
  // EXPIRED, or any state the server adds later that is not live: the upload re-opens.
  return 'EXPIRED';
}

export const STATE_LABEL: Record<DocumentState, string> = {
  MISSING: 'Not sent yet',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  EXPIRING: 'Expiring soon',
  EXPIRED: 'Expired',
  REJECTED: 'Turned down',
};

/**
 * The upload this document allows right now — exactly the ones the server
 * accepts. Nothing while it is in review or approved and not yet due for
 * renewal (the server refuses those).
 */
export function uploadLabel(state: DocumentState): string | null {
  switch (state) {
    case 'MISSING': return 'Upload';
    case 'REJECTED': return 'Upload a new copy';
    case 'EXPIRED':
    case 'EXPIRING': return 'Upload a renewal';
    default: return null;
  }
}

// ── Names ───────────────────────────────────────────────────────────────────

/** The phone app's names for the checklist documents (DocumentUploadCard
 *  DOC_LABELS); a test keeps the two lists identical. Unknown types read as
 *  their words. */
export const DOC_LABELS: Record<string, string> = {
  national_id: 'National ID',
  drivers_licence: "Driver's Licence",
  vehicle_registration: 'Vehicle Registration',
  vehicle_insurance: 'Vehicle Insurance',
  hire_car_permit: 'Hire-Car Permit',
  road_service_licence: 'Road Service Licence',
  vehicle_plate_photo: 'Vehicle Plate Photo',
  police_clearance: 'Police Clearance Certificate',
  fitness_cert: 'Fitness Certificate',
  vehicle_exterior_photo: 'Car exterior photo (H plate visible)',
  owner_national_id: 'Owner National ID',
  business_registration: 'Business Registration',
  tin_certificate: 'TIN Certificate',
  gra_restaurant_licence: 'GRA Restaurant Licence',
  food_handler_cert: "Food Handler's Certificate",
  storefront_photo: 'Storefront Photo',
  selfie: 'Selfie',
};

export function documentLabel(docType: string): string {
  return DOC_LABELS[docType] ?? docType.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Where to ask about a review. Where the customer app is open (staging, and
 * the public site once web ordering launches), that is the account's Help
 * page: the topic set, the document named, the request tracked there. Before
 * launch the public site serves "Launching soon" in place of every account
 * page, so there it is an email to support with the document named instead.
 * Either way the reviewer's words stay on this page, never in a link.
 */
export function helpHref(topic: 'VENDOR' | 'MOVER', docType: string, accountPagesOpen: boolean, supportEmail: string): string {
  if (accountPagesOpen) return `/account/help?${new URLSearchParams({ topic, document: docType })}`;
  return `mailto:${supportEmail}?subject=${encodeURIComponent(`About my ${documentLabel(docType)} review`)}`;
}

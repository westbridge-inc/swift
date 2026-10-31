// [OPEN-EARLY PR-2 · owner 31 Oct 2026] A store's Documents page on the website: the phone's store checklist
// (apps/mobile VendorAccountScreen VendorDocumentsSection → components/onboarding/DocumentChecklist +
// DocumentUploadCard), so a partner who signs up on swiftgy.com before the apps are out can send every onboarding
// document. The names, the words and the list rules are the PHONE's own modules, imported as they are (none of them
// loads React Native); what lives here is the card's reading of one document, which the phone keeps inside its
// component. store-documents.parity.test.ts holds each word to the phone's source.
import { documentExpiryDay } from './documentExpiry';
import { pendingDocumentLabel } from '../../../mobile/src/components/onboarding/documentChecklistPresentation';

export { docLabel } from '../../../mobile/src/components/onboarding/docLabels';
export {
  DOCUMENT_REVIEW_PROMISE, emptyChecklistCopy, optionalDocHint, optionalDocTypes, pendingDocumentLabel,
} from '../../../mobile/src/components/onboarding/documentChecklistPresentation';
export {
  DOCUMENT_CONSENT_TICK, documentConsentGivenLine, documentConsentOnRecord,
} from '../../../mobile/src/components/onboarding/documentConsentRecord';
export { FOOD_HANDLERS_DOC } from '../../../mobile/src/components/onboarding/foodHandlers';
export { DOCUMENT_CONSENT_TEXT } from '../../../mobile/src/lib/uploadConsentCopy';
export {
  OWN_NAME_DECLARATION_V1, OWN_NAME_DECLARATION_VERSION, OWN_NAME_HINT, OWN_NAME_TICK, ownNameApplies, ownNameSigningFor,
} from '../../../mobile/src/lib/ownNameCopy';

/** The roles whose checklist is a store's (a Services business included): the API's store roles on /verification. */
export const STORE_DOCUMENT_ROLES: ReadonlySet<string> = new Set(['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE']);

/** [ROLE-DOCS] The signed "I trade under my own name" declaration (the server's OWN_NAME_DOC_TYPE): signed, never uploaded. */
export const OWN_NAME_DOC = 'own_name_declaration';

/**
 * [POLICE-CLEARANCE CONSENT] A police clearance has its OWN consent words and version (DPA s.9(1)(a)); the website
 * does not take one yet (as the rider page). A Services business that offers home visits sees it on its list: only
 * those visits wait for it, never the store's going live (verification.service getStatus `gate`).
 */
export const POLICE_CLEARANCE_DOC = 'police_clearance';
export const POLICE_CLEARANCE_ON_THE_APP = 'Added in the Swift app, where it has its own consent. Your store can go live without it: only home-visit bookings wait for it.';

/** The files the API takes (POST /verification/upload), as the rider page. */
export const DOCUMENT_FILE_TYPES = 'image/jpeg,image/png,image/webp,application/pdf';

/** What the phone asks for when the photo choice opens (DocumentUploadCard choosePhoto). */
export const DOCUMENT_PHOTO_HINT = 'Add a clear, well-lit photo. All corners visible, no glare.';

/** The phone's confirm before a copy waiting for review is replaced (DocumentUploadCard confirmReplace). */
export const REPLACE_TITLE = 'Replace this document?';
export const REPLACE_BODY = 'Your new upload replaces the one waiting for review. We keep the old one on record, and the reviewer sees only the new one.';

/** The phone's line while a file is on its way. */
export const STILL_UPLOADING = 'Still uploading — keep this screen open. Slow connections can take a minute.';

/** Under the list (DocumentChecklist's last note). */
export const DOCUMENTS_FOOTNOTE = "We confirm your documents are genuine and that they're yours, and re‑check expiry every day — we'll remind you before anything lapses so you stay verified.";

/** The checklist's first lines (DocumentChecklist). */
export const REQUIRED_HEADING = 'Required steps';
export const REQUIRED_INTRO = 'Upload these to activate your account. We review them Monday to Saturday, 8:00–16:00 Guyana time.';
export const OPTIONAL_HEADING = 'Optional';
export const OPTIONAL_INTRO = 'You can add these any time. You do not need them to go live.';

/** One document as GET /verification/status lists it (the applicant's own view of the row). */
export interface StoreDocumentRow {
  id: string;
  docType: string;
  status: string;
  expiresAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  replaced?: boolean;
}

/** GET /verification/status?role=<store type>: the fields the page reads (others are passed through untouched). */
export interface StoreDocumentStatus {
  checklist?: string[];
  optional?: string[];
  documents?: StoreDocumentRow[];
  missing?: string[];
  roleVerified?: boolean;
  nameBasis?: string;
  documentConsent?: unknown;
  categoryUnavailable?: boolean;
}

/**
 * The document a checklist row shows (DocumentChecklist latestDoc): a renewal in flight shows as waiting; else the
 * current approved one (with its expiry); else the newest row (expired or rejected), which opens the upload again.
 */
export function latestDocument(documents: readonly StoreDocumentRow[] | undefined, docType: string, now = new Date()): StoreDocumentRow | undefined {
  const docs = (documents ?? [])
    .filter((d) => d.docType === docType)
    .sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? 1 : -1));
  return docs.find((d) => d.status === 'PENDING')
    ?? docs.find((d) => d.status === 'APPROVED' && (!d.expiresAt || new Date(d.expiresAt) > now))
    ?? docs[0];
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Mirrors the API's renewal window: re-submission opens 30 days before expiry (as the phone). */
export const RENEWAL_WINDOW_DAYS = 30;

export type DocumentBadge = { label: string; tone: 'success' | 'error' | 'brand' | 'warning' } | null;

export interface DocumentCardInput {
  status?: string;
  /** Only an APPROVED document's expiry is read (as the phone passes it). */
  expiresAt?: string | null;
  submittedAt?: string | null;
  reviewNote?: string | null;
  replaced?: boolean;
  isNext?: boolean;
  optional?: boolean;
  /** The consent tick is given (the person's own, on this visit or on record). */
  consented: boolean;
  /** The server's words for a refused upload (shown as they are), or null. */
  uploadError?: string | null;
}

export interface DocumentCardView {
  caption: string;
  /** The caption reads as a problem (red) or a warning (amber). */
  captionTone: 'muted' | 'error' | 'warning';
  badge: DocumentBadge;
  /** An approved, current document (outside its renewal window) cannot be sent again. */
  locked: boolean;
  /** A copy waiting for review: sending another replaces it (asked first). */
  pending: boolean;
}

/**
 * How one checklist document reads and acts: the phone's DocumentUploadCard, word for word (caption, badge, lock).
 * The phone's badge is only Approved / Expired / Rejected / In review (a replaced copy says so in its caption); an
 * approved document inside its renewal window also says "Expiring soon" here, as the rider page does.
 */
export function documentCardView(input: DocumentCardInput, now = new Date()): DocumentCardView {
  const { status, expiresAt, submittedAt, reviewNote, replaced = false, isNext = false, optional = false, consented, uploadError = null } = input;
  const expired = status === 'EXPIRED';
  const pending = status === 'PENDING';
  const rejected = status === 'REJECTED';
  const shownExpiry = status === 'APPROVED' ? expiresAt ?? null : null;
  const daysLeft = shownExpiry ? Math.ceil((new Date(shownExpiry).getTime() - now.getTime()) / DAY_MS) : null;
  const expiringSoon = status === 'APPROVED' && daysLeft != null && daysLeft <= RENEWAL_WINDOW_DAYS;
  const approved = status === 'APPROVED' && !expiringSoon;

  const caption = !consented && !approved && !pending && !uploadError
    ? 'Tick the box above to upload'
    : uploadError
      ? uploadError
      : approved
        ? daysLeft != null
          ? `Approved — valid until ${documentExpiryDay(shownExpiry)}`
          : 'Approved'
        : expiringSoon
          ? `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — tap to upload the renewal`
          : expired
            ? optional
              ? 'Expired — optional, upload a new one any time'
              : 'Expired — upload the renewal to keep operating'
            : pending
              ? pendingDocumentLabel(replaced, submittedAt)
              : rejected
                ? reviewNote
                  ? `Rejected: ${reviewNote} — tap to re-upload`
                  : 'Rejected — tap to re-upload'
                : optional
                  ? 'Optional'
                  : isNext
                    ? 'Recommended next step'
                    : 'Get started';

  const badge: DocumentBadge = approved
    ? { label: 'Approved', tone: 'success' }
    : expiringSoon
      ? { label: 'Expiring soon', tone: 'warning' }
      : expired
        ? { label: 'Expired', tone: 'error' }
        : rejected
          ? { label: 'Rejected', tone: 'error' }
          : pending
            ? { label: 'In review', tone: 'brand' }
            : null;

  return {
    caption,
    captionTone: uploadError || rejected ? 'error' : expiringSoon || expired ? 'warning' : 'muted',
    badge,
    locked: approved,
    pending,
  };
}

/** The server's reason for a refused upload is the fix instruction: shown as it is, else the phone's retry line. */
export function uploadErrorWords(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return message || 'Upload failed — tap to try again';
}

/**
 * [VAT-DOCS · owner 30 Oct 2026] The optional VAT certificate row's status word, from the store's VAT (GET /vendor/vat):
 * the phone's modules/vendor/VatDocumentRow vatDocumentStatusWord. Never "approved" before a person approved it.
 */
export function vatDocumentStatusWord(status: string, certificateStatus: string | null | undefined): string {
  switch (status) {
    case 'APPROVED': return 'Approved';
    case 'PENDING': return certificateStatus === 'PENDING' ? 'In review' : 'Not submitted';
    case 'REJECTED': return 'Not approved';
    case 'REVOKED': return 'Withdrawn';
    default: return 'Not submitted';
  }
}

import type { PrismaClient } from '@prisma/client';
import { publishLegalDocumentOnce, recordConsent, type ConsentDocumentType, type ConsentSubjectType, type ConsentSurface } from '../legal/consent.service';

/**
 * [Legal research D1, D2, B1, G4 · R17 · in-app wording ¶15] A tick before an upload, recorded in the consent ledger.
 *
 * The words beside each tick are their own versioned document (a version is a promise about specific words), and a
 * tick is recorded only when a client says it showed it (`consentTick`): the website's document upload and phone
 * build 12. Builds 9-11 send `consent: true` with no tick; for them the document row keeps its consent stamp as
 * today and no ledger row is fabricated.
 *
 * Not here yet: the research's police-clearance tick (D1) promises "delete the image within 30 days" — the image
 * purge is not built (PRIVACY lane, R24), so that tick ships with it.
 */
export const UPLOAD_CONSENT = {
  document_v1: {
    documentType: 'document_processing_consent',
    version: 'v1',
    text: 'I consent to Swift processing this document for verification, per the privacy notice. It is stored encrypted and shared only as the Privacy Policy explains.',
  },
  customer_id_v1: {
    documentType: 'customer_id_consent',
    version: 'v1',
    text: 'I agree Swift may keep this ID photo to unlock taxi rides and larger orders, as the Privacy Policy explains.',
  },
} as const satisfies Record<string, { documentType: ConsentDocumentType; version: string; text: string }>;

export type UploadConsentTick = keyof typeof UPLOAD_CONSENT;
export const UPLOAD_CONSENT_TICKS = Object.keys(UPLOAD_CONSENT) as [UploadConsentTick, ...UploadConsentTick[]];

/** The ledger subject for a checklist role: a mover is a driver; a business or a service provider a vendor user. */
export function consentSubjectForRole(role: string | null): ConsentSubjectType {
  if (role === 'MOVER') return 'driver';
  if (role === null) return 'customer';
  return ['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE', 'SERVICE_PROVIDER'].includes(role) ? 'vendor_user' : 'customer';
}

export async function recordUploadConsent(
  prisma: PrismaClient,
  input: { userId: string; tick: UploadConsentTick; subjectType: ConsentSubjectType; surface: ConsentSurface; ip?: string | null; docType: string },
): Promise<void> {
  const c = UPLOAD_CONSENT[input.tick];
  await publishLegalDocumentOnce(prisma, { documentType: c.documentType, version: c.version, renderedText: c.text });
  await prisma.$transaction((tx) => recordConsent(tx, {
    subjectType: input.subjectType,
    subjectId: input.userId,
    documentType: c.documentType,
    version: c.version,
    action: 'granted',
    surface: input.surface,
    ip: input.ip ?? null,
    evidence: { control: 'upload_consent_checkbox', path: 'verification', docType: input.docType },
  }));
}

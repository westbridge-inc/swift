/**
 * [R24 · research C4 · owner rulings 6 Oct (ruling 6) and 15 Oct (implement the research)]
 * How long Swift keeps a PARTNER's verification images.
 *
 *  - A partner's PERSONAL document (ID, licence, police clearance, selfie): the image goes
 *    30 days after the decision on it. The small "verified" record stays, so the partner stays
 *    verified (DPA s.4(1)(c) and (e): minimisation, storage limitation).
 *  - A partner's REJECTED document: a PERSONAL one is deleted 30 days after the rejection; a
 *    vehicle or business one after its registry window (90 days), like every other document
 *    that stops being needed ("while active + 90 days").
 *  - A CUSTOMER's ID is not touched here: it is kept while the account is open and goes when
 *    the account closes (owner ruling 8 Oct; account deletion purges it).
 *
 * Continues the VERIFY-DOCS PR-V2 work (fix/verify-docs-retention): the windows are settings,
 * read from PlatformConfig each sweep and 30 days when unset, so the lawyer's numbers are a
 * settings change. A value outside 1..3650 is ignored — a typo never deletes everything at once.
 */
import type { Prisma, PrismaClient, UserRole } from '@prisma/client';
import { BUCKET_OF } from './doc-registry';

type Db = Prisma.TransactionClient | PrismaClient;

export const PERSONAL_IMAGE_DAYS_KEY = 'documents.personal_image_days';
export const REJECTED_DOCUMENT_DAYS_KEY = 'documents.rejected_document_days';
export const DEFAULT_PERSONAL_IMAGE_DAYS = 30;
export const DEFAULT_REJECTED_DOCUMENT_DAYS = 30;
export const DAY_MS = 86_400_000;

/** The roles whose documents are partner documents. A customer's ID is kept while the account is open. */
export const PARTNER_DOCUMENT_ROLES: readonly UserRole[] = ['RIDER', 'DRIVER', 'MOVER', 'VENDOR_OWNER'];

/** The customer's own ID (verification.service IDENTITY_DOC_TYPE; a test holds the two equal). */
export const CUSTOMER_ID_DOC_TYPE = 'identity_l2';

/**
 * Which documents are a partner's. An individual SERVICE PROVIDER's documents (national ID,
 * police clearance for home visits, trade licence) are stored with role CUSTOMER: the provider
 * lives inside the customer account (verification.service roleKeyToUserRole). So a CUSTOMER row
 * is a partner document too, unless it is the customer's own ID, which is kept while the account
 * is open. Every partner selector uses this one predicate.
 */
export const PARTNER_DOCUMENT_WHERE: Prisma.VerificationDocumentWhereInput = {
  OR: [
    { role: { in: [...PARTNER_DOCUMENT_ROLES] } },
    { role: 'CUSTOMER', docType: { not: CUSTOMER_ID_DOC_TYPE } },
  ],
};

export async function configuredDays(db: Db, key: string, fallback: number): Promise<number> {
  const row = await db.platformConfig.findUnique({ where: { key }, select: { value: true } });
  const value = row?.value;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3650 ? value : fallback;
}

/**
 * The document types whose images are NOT personal: the business and vehicle buckets. Every other
 * type — including one the registry does not know — is PERSONAL, the most restrictive reading
 * (doc-registry BUCKET_OF), so its image goes after review.
 */
export const NON_PERSONAL_DOC_TYPES: readonly string[] = Object.entries(BUCKET_OF)
  .filter(([, bucket]) => bucket !== 'PERSONAL')
  .map(([docType]) => docType);

export const isPersonalDocType = (docType: string): boolean => !NON_PERSONAL_DOC_TYPES.includes(docType);

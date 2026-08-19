import { createHash, createHmac } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * [DCR-1 NR-1] The consent ledger.
 *
 * Guyana's Data Protection Act is enacted but NOT in force. Consent for the
 * accounts created before commencement cannot be manufactured on commencement
 * day — either a timestamped, hash-anchored record exists for each subject or
 * it never will. So it is captured now, as if the Act were already in force.
 *
 * Two rules make the ledger evidence rather than bookkeeping:
 *  - every record is anchored to the sha256 of the EXACT text the user saw
 *    (INV-NR1b), so "which words did they agree to" is answerable years later;
 *  - the table is append-only at the database (INV-NR1c) — a withdrawal is a
 *    new row, never an edit, so consent history cannot be rewritten.
 */

export type ConsentSubjectType = 'customer' | 'driver' | 'vendor_user' | 'admin';
export type ConsentDocumentType =
  | 'privacy_policy'
  | 'terms_of_service'
  | 'driver_agreement'
  | 'vendor_agreement'
  | 'marketing_consent'
  | 'location_bg_consent';
export type ConsentAction = 'granted' | 'withdrawn' | 're_granted';
/** 'mobile' = the RN app when the platform isn't client-attested (signup). */
export type ConsentSurface = 'ios' | 'android' | 'mobile' | 'web' | 'vendor_web' | 'admin' | 'support_ticket';

/** The document set each subject type must grant at account creation (INV-NR1a). */
export const REQUIRED_CONSENTS: Record<ConsentSubjectType, ConsentDocumentType[]> = {
  customer: ['privacy_policy', 'terms_of_service'],
  driver: ['privacy_policy', 'driver_agreement'],
  vendor_user: ['privacy_policy', 'vendor_agreement'],
  // Staff accounts are created under a separate employment basis, not app consent.
  admin: [],
};

export function hashDocument(renderedText: string): string {
  return createHash('sha256').update(renderedText, 'utf8').digest('hex');
}

/** Raw IPs are never stored in the ledger — only a peppered HMAC (NR-1.1). */
export function hashIp(ip: string | null | undefined): string | null {
  const pepper = process.env['CONSENT_IP_PEPPER'];
  if (!ip || !pepper || pepper.length < 32) return null;
  return createHmac('sha256', pepper).update(ip).digest('hex');
}

/**
 * Publish (or re-publish) a legal document version. Idempotent per
 * (type, version, locale): re-running with identical text is a no-op, and
 * changed text under an existing version is refused — a version is a promise
 * about specific words, so new words need a new version.
 */
export async function publishLegalDocument(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: { documentType: ConsentDocumentType; version: string; locale?: string; renderedText: string },
): Promise<{ contentHash: string }> {
  const locale = input.locale ?? 'en-GY';
  const contentHash = hashDocument(input.renderedText);
  const existing = await prisma.legalDocument.findUnique({
    where: {
      documentType_version_locale: { documentType: input.documentType, version: input.version, locale },
    },
  });
  if (existing) {
    if (existing.contentHash !== contentHash) {
      throw new Error(
        `[DCR-1 NR-1] ${input.documentType}@${input.version} (${locale}) already published with different text. `
        + 'Publish a NEW version — a version is a promise about specific words.',
      );
    }
    if (!existing.publishedAt) {
      await prisma.legalDocument.update({ where: { id: existing.id }, data: { publishedAt: new Date() } });
    }
    return { contentHash };
  }
  await prisma.legalDocument.create({
    data: {
      documentType: input.documentType,
      version: input.version,
      locale,
      contentHash,
      publishedAt: new Date(),
    },
  });
  return { contentHash };
}

/**
 * Record consent. MUST be called with the same transaction client that creates
 * the account row (INV-NR1a) — an account without its consent rows is exactly
 * the un-fixable gap this gate exists to prevent.
 *
 * Refuses to write against a draft or unknown document version (INV-NR1b):
 * consent anchored to nothing is not consent.
 */
export async function recordConsent(
  tx: Prisma.TransactionClient,
  input: {
    subjectType: ConsentSubjectType;
    subjectId: string;
    documentType: ConsentDocumentType;
    version: string;
    locale?: string;
    action: ConsentAction;
    surface: ConsentSurface;
    ip?: string | null;
    appVersion?: string | null;
    evidence?: Record<string, unknown>;
  },
): Promise<void> {
  const locale = input.locale ?? 'en-GY';
  const doc = await tx.legalDocument.findUnique({
    where: {
      documentType_version_locale: { documentType: input.documentType, version: input.version, locale },
    },
  });
  if (!doc || !doc.publishedAt) {
    throw new Error(
      `[DCR-1 NR-1] no PUBLISHED ${input.documentType}@${input.version} (${locale}) — `
      + 'consent cannot be anchored to a draft or missing document.',
    );
  }
  await tx.consentRecord.create({
    data: {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      documentType: input.documentType,
      documentVersion: input.version,
      documentContentHash: doc.contentHash,
      action: input.action,
      surface: input.surface,
      locale,
      ipHmac: hashIp(input.ip),
      appVersion: input.appVersion ?? null,
      evidence: (input.evidence ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/** The current state of one consent — the latest row wins (view-equivalent). */
export async function currentConsent(
  prisma: PrismaClient | Prisma.TransactionClient,
  subjectType: ConsentSubjectType,
  subjectId: string,
  documentType: ConsentDocumentType,
): Promise<ConsentAction | null> {
  const row = await prisma.consentRecord.findFirst({
    where: { subjectType, subjectId, documentType },
    orderBy: { capturedAt: 'desc' },
    select: { action: true },
  });
  return (row?.action as ConsentAction | undefined) ?? null;
}

/** INV-NR1d: withdrawn marketing consent means zero marketing sends. */
export async function mayReceiveMarketing(
  prisma: PrismaClient,
  subjectType: ConsentSubjectType,
  subjectId: string,
): Promise<boolean> {
  const state = await currentConsent(prisma, subjectType, subjectId, 'marketing_consent');
  return state === 'granted' || state === 're_granted';
}

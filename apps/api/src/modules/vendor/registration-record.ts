/**
 * THE definition of "a business registration is on file": a VALID, unexpired registration record for the owner.
 * The own-name route refuses a store whose owner already holds one (vendor.routes POST /onboarding/own-name).
 *
 * [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (a)] Moved here from vendor/vendor-tier.ts when the self-declared
 * (unregistered) tier was removed with its caps, nudge and automatic promotion: only a registered business or a
 * trader under their own name joins Swift.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { validExpiryOr } from '../verification/document-validity';
import { REGISTRATION_DOC_TYPES } from '../verification/doc-registry';

type Db = PrismaClient | Prisma.TransactionClient;

export async function validRegistrationRecord(db: Db, ownerUserId: string, now = new Date()): Promise<{ id: string; docType: string } | null> {
  return db.documentRecord.findFirst({
    where: { accountId: ownerUserId, docType: { in: [...REGISTRATION_DOC_TYPES] }, status: 'VALID', OR: validExpiryOr('expiresOn', now) },
    select: { id: true, docType: true },
  });
}

/** [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (a)] What a client that still asks for the removed self-declared tier is
 *  told (POST /vendor/onboarding/declaration answers 410): polite, and it names the two ways in. */
export const UNREGISTERED_TIER_REMOVED_WORDS =
  'Swift takes registered businesses, and traders who sell under their own name. To sell on Swift, register your business name with the Deeds and Commercial Registries Authority (DCRA) and upload the certificate under Documents. If your store’s name is your own name (your surname, with only your first names or initials), choose “I trade under my own name” there instead.';

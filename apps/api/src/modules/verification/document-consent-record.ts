import type { Prisma, PrismaClient } from '@prisma/client';
import { hashDocument } from '../legal/consent.service';
import { UPLOAD_CONSENT, consentSubjectForRole } from './upload-consent';

/**
 * [DOC-CONSENT · owner 25 Oct 2026] The document-upload tick the person has on record, read back for the checklist.
 *
 * Phone build 12 asks for the tick above the document checklist and records it in the consent ledger with every
 * upload (upload-consent.ts). It never read it back: the tick lived only on the screen, so every new visit (leave and
 * come back, a role switch, another account, the app restarting, Account → Documents) showed it unticked again, and
 * the person had to tick again before the next upload although the ledger already held their consent.
 *
 * `given` is true only when this person's LATEST ledger row for these exact words is a grant: the tick's own
 * version AND the hash of its words (a version is a promise about specific words), under the subject the uploads
 * record (a mover is a driver; a business a vendor user). A withdrawal, other words, or no row: false — the screen
 * then asks for a fresh tick, exactly as before. Nothing is written here and nothing is ever ticked for anyone.
 */
export type DocumentConsentOnRecord = {
  /** The tick these words belong to — a client shows the record only beside the same words. */
  tick: 'document_v1';
  given: boolean;
  /** When the latest grant was recorded (ISO), or null. */
  givenAt: string | null;
};

const TICK = 'document_v1' as const;

export async function documentConsentOnRecord(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
  role: string,
): Promise<DocumentConsentOnRecord> {
  const words = UPLOAD_CONSENT[TICK];
  const row = await db.consentRecord.findFirst({
    where: { subjectType: consentSubjectForRole(role), subjectId: userId, documentType: words.documentType },
    orderBy: { capturedAt: 'desc' },
    select: { action: true, documentVersion: true, documentContentHash: true, capturedAt: true },
  });
  const given = !!row
    && (row.action === 'granted' || row.action === 're_granted')
    && row.documentVersion === words.version
    && row.documentContentHash === hashDocument(words.text);
  return { tick: TICK, given, givenAt: given ? row!.capturedAt.toISOString() : null };
}

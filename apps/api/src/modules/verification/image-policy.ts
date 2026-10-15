/**
 * [DOC-1 §1.3 · P1-3] WHEN an image goes: the daily image-policy sweep.
 *
 * [R24 · research C4] First, for PARTNERS: every committed PERSONAL document's image, once
 * the decision on it is older than the window (30 days; retention-rules). A customer's ID is
 * never touched here (kept while the account is open). Then the registry law, for types whose
 * legal facts were verified:
 *
 * A committed submission whose document type is ACTIVE in the registry (the registry
 * law: a type's rules engage when its legal facts are verified) with image policy
 * PURGE_AFTER_REVIEW, whose extraction succeeded (outcome OK — "verify → extract →
 * hash → destroy", never destroy before extract), that is not under a legal hold and
 * still holds bytes, has its image purged through `purgeImageAfterReview` (shred,
 * probe, receipt) — the document RECORD stays and the actor stays verified (E2E-DOC-5).
 * PERSIST and PERSIST_REDACTED types are never touched here (redaction is P6 L1 work).
 * Idempotent: a purged image is not purged twice; a probe failure is counted and retried
 * on the next sweep.
 */
import type { PrismaClient } from '@prisma/client';
import type { VerificationService } from './verification.service';
import {
  configuredDays, DAY_MS, DEFAULT_PERSONAL_IMAGE_DAYS, NON_PERSONAL_DOC_TYPES, PARTNER_DOCUMENT_ROLES, PERSONAL_IMAGE_DAYS_KEY,
} from './retention-rules';

export interface ImagePolicyRun { candidates: number; purged: number; probeFailed: number; skipped: number }

export async function applyImagePolicy(
  prisma: PrismaClient,
  service: Pick<VerificationService, 'purgeImageAfterReview'>,
  opts: { now?: Date; batch?: number } = {},
): Promise<ImagePolicyRun> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? 200;
  const run: ImagePolicyRun = { candidates: 0, purged: 0, probeFailed: 0, skipped: 0 };
  const tally = (outcome: 'PURGED' | 'PROBE_FAILED' | 'NOT_PURGED') => {
    if (outcome === 'PURGED') run.purged += 1;
    else if (outcome === 'PROBE_FAILED') run.probeFailed += 1;
    else run.skipped += 1;
  };

  // [R24] A partner's PERSONAL image goes once the decision on it is older than the window. No
  // registry type has to be switched on and nothing has to have been extracted: the reviewer has
  // already recorded what the kept record needs. The record stays VALID and the partner stays
  // verified. purgeImageAfterReview is the one path (shred, probe, receipt) and refuses a held
  // document at its final step.
  const personalDays = await configuredDays(prisma, PERSONAL_IMAGE_DAYS_KEY, DEFAULT_PERSONAL_IMAGE_DAYS);
  const decidedBefore = new Date(now.getTime() - personalDays * DAY_MS);
  const personal = await prisma.verificationDocument.findMany({
    where: {
      state: 'COMMITTED', role: { in: [...PARTNER_DOCUMENT_ROLES] }, docType: { notIn: [...NON_PERSONAL_DOC_TYPES] },
      reviewedAt: { lte: decidedBefore }, imagePurgedAt: null, purgedAt: null, legalHoldId: null, fileUrl: { not: '' },
    },
    select: { id: true }, orderBy: { reviewedAt: 'asc' }, take: batch,
  });
  run.candidates += personal.length;
  for (const d of personal) tally(await service.purgeImageAfterReview(d.id, 'partner-image-retention', now));

  const purgeTypes = await prisma.docType.findMany({
    where: { isActive: true, imagePolicy: 'PURGE_AFTER_REVIEW' },
    select: { countryCode: true, legacyCode: true },
  });
  if (purgeTypes.length === 0) return run;
  const byCountry = new Map<string, string[]>();
  for (const t of purgeTypes) byCountry.set(t.countryCode, [...(byCountry.get(t.countryCode) ?? []), t.legacyCode]);
  for (const [countryCode, legacyCodes] of byCountry) {
    const docs = await prisma.verificationDocument.findMany({
      where: {
        state: 'COMMITTED', docType: { in: legacyCodes }, imagePurgedAt: null, purgedAt: null, legalHoldId: null, fileUrl: { not: '' },
        user: { countryCode },
        extractionRuns: { some: { outcome: 'OK' } },
      },
      select: { id: true }, orderBy: { createdAt: 'asc' }, take: batch,
    });
    run.candidates += docs.length;
    for (const d of docs) tally(await service.purgeImageAfterReview(d.id, 'image-policy', now));
  }
  return run;
}

/**
 * [DOC-1 §1.3 · P1-3] WHEN an image goes: the daily image-policy sweep.
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

export interface ImagePolicyRun { candidates: number; purged: number; probeFailed: number; skipped: number }

export async function applyImagePolicy(
  prisma: PrismaClient,
  service: Pick<VerificationService, 'purgeImageAfterReview'>,
  opts: { now?: Date; batch?: number } = {},
): Promise<ImagePolicyRun> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? 200;
  const purgeTypes = await prisma.docType.findMany({
    where: { isActive: true, imagePolicy: 'PURGE_AFTER_REVIEW' },
    select: { countryCode: true, legacyCode: true },
  });
  const run: ImagePolicyRun = { candidates: 0, purged: 0, probeFailed: 0, skipped: 0 };
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
    for (const d of docs) {
      const outcome = await service.purgeImageAfterReview(d.id, 'image-policy', now);
      if (outcome === 'PURGED') run.purged += 1;
      else if (outcome === 'PROBE_FAILED') run.probeFailed += 1;
      else run.skipped += 1;
    }
  }
  return run;
}

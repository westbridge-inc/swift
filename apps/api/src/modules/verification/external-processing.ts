/**
 * [DGP-1 · CONFLICT-DOC-2] Recording the decision that lets a PERSONAL document type be processed
 * externally. DOC-1's residency rule keeps PERSONAL images on Swift infrastructure; the founder may
 * decide otherwise for named types (FD-DOC-3b option a). That decision is a REFERENCE on the registry
 * row, written from the admin console, audited, and required by the database CHECK
 * `personal_external_needs_decision` — so the rule cannot be flipped by a stray update, and the
 * runtime gate (`assertExternalProcessingPermitted`) reads the same row.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';

export interface ExternalProcessingDecisionInput {
  code: string;
  allowed: boolean;
  /** The founder's decision reference (e.g. "FD-DOC-3b 2026-09-07"); required to ALLOW a PERSONAL type. */
  decisionRef?: string | null;
  reason: string;
}

export const DECISION_REF_REQUIRED = 'DECISION_REF_REQUIRED';

export type DecisionAudit = (tx: Prisma.TransactionClient, facts: Record<string, string | number | boolean | null>) => Promise<unknown>;

export async function recordExternalProcessingDecision(db: PrismaClient, input: ExternalProcessingDecisionInput, audit: DecisionAudit, now = new Date()) {
  const row = await db.docType.findUnique({ where: { code: input.code }, select: { code: true, bucket: true, externalProcessingAllowed: true, externalProcessingDecisionRef: true } });
  if (!row) throw new AppError(404, 'DOC_TYPE_NOT_FOUND', `No document type ${input.code}`);
  const ref = input.decisionRef?.trim() || null;
  if (input.allowed && row.bucket === 'PERSONAL' && !ref) {
    throw new AppError(400, DECISION_REF_REQUIRED, 'A PERSONAL document type can be sent externally only under a recorded decision — give its reference.');
  }
  const before = { externalProcessingAllowed: row.externalProcessingAllowed, externalProcessingDecisionRef: row.externalProcessingDecisionRef };
  // [ADM-002] the row and its audit line commit together or not at all.
  return db.$transaction(async (tx) => {
    const after = await tx.docType.update({
      where: { code: input.code },
      data: { externalProcessingAllowed: input.allowed, externalProcessingDecisionRef: input.allowed ? ref : null, externalProcessingDecidedAt: now },
      select: { code: true, bucket: true, externalProcessingAllowed: true, externalProcessingDecisionRef: true, externalProcessingDecidedAt: true },
    });
    await audit(tx, { docType: input.code, bucket: row.bucket, allowedBefore: before.externalProcessingAllowed, allowedAfter: after.externalProcessingAllowed, decisionRef: after.externalProcessingDecisionRef, reason: input.reason });
    return { before, after };
  });
}

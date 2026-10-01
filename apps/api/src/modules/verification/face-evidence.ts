/**
 * [DS625 · DOC-1 §9.4] Face evidence under a legal hold.
 *
 * The signup selfie (the avatar object), the shift liveness checks and the
 * biometric face template are a person's face evidence: the reference face that
 * their identity documents and liveness checks were matched against. A hold
 * names a person, so while ANY active hold names them (whole-person, or naming
 * documents — the rule the fence already applies to their unattached uploads)
 * none of it is destroyed: not by a selfie replacement, the orphan sweep or
 * account erasure. Each preservation is recorded against the hold in the fence's
 * own ledger, once per item and hold. Nothing is dropped: an avatar obligation
 * stays open for the sweep to retry after release, and an erased person's
 * liveness checks and face template go when the last hold on them is released.
 *
 * Every caller holds the person's row lock, the authority row every hold
 * placement and release takes, so a hold and a destruction cannot interleave.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { purgeEvent } from './purge-fence';

type Tx = Prisma.TransactionClient;
export type FaceEvidence = 'AVATAR_OBJECT' | 'LIVENESS_CHECKS' | 'FACE_TEMPLATE';

/** The active holds naming the person, oldest first; none means nothing to keep. */
export async function activeFaceEvidenceHolds(tx: Tx, userId: string, tenantId: string): Promise<string[]> {
  const where = { subjectUserId: userId, tenantId, releasedAt: null };
  if (!await tx.docLegalHold.count({ where })) return [];
  const holds = await tx.docLegalHold.findMany({ where, orderBy: [{ placedAt: 'asc' }, { id: 'asc' }], select: { id: true } });
  return holds.map((h) => h.id);
}

/** Record one kept item against the oldest active hold (naming every active hold), once per item and hold. */
export async function recordFaceEvidenceHeld(tx: Tx, input: {
  tenantId: string; userId: string; holdIds: string[]; evidence: FaceEvidence; item: string; actorId: string;
  details?: Record<string, string | number>;
}): Promise<void> {
  const holdId = input.holdIds[0];
  if (!holdId) return;
  const recorded = await tx.documentPurgeEvent.count({ where: {
    userId: input.userId, holdId, kind: 'FACE_EVIDENCE_HELD', details: { path: ['item'], equals: input.item },
  } });
  if (recorded) return;
  await purgeEvent(tx, {
    tenantId: input.tenantId, userId: input.userId, holdId, kind: 'FACE_EVIDENCE_HELD', actorId: input.actorId,
    details: { ...input.details, evidence: input.evidence, item: input.item, holdIds: input.holdIds },
  });
}

export type FaceRecordsOutcome =
  | { held: false }
  | { held: true; holdIds: string[]; faceTemplates: number; livenessChecks: number };

/** Account erasure's face records — the biometric template and the liveness checks — under the person's
 *  row lock: either a hold committed first and they are kept and recorded, or they go now. */
export async function eraseFaceRecordsUnlessHeld(prisma: PrismaClient, userId: string): Promise<FaceRecordsOutcome> {
  return prisma.$transaction(async (tx): Promise<FaceRecordsOutcome> => {
    const owner = await tx.$queryRaw<Array<{ tenantId: string }>>`
      SELECT "tenantId" FROM users WHERE id = ${userId} FOR UPDATE /* face-evidence-erasure-authority */
    `;
    const tenantId = owner[0]?.tenantId;
    const holdIds = tenantId ? await activeFaceEvidenceHolds(tx, userId, tenantId) : [];
    if (!tenantId || !holdIds.length) {
      await tx.faceTemplate.deleteMany({ where: { accountId: userId } });
      await tx.livenessCheck.deleteMany({ where: { userId } });
      return { held: false };
    }
    const faceTemplates = await tx.faceTemplate.count({ where: { accountId: userId } });
    const livenessChecks = await tx.livenessCheck.count({ where: { userId } });
    const held = { tenantId, userId, holdIds, actorId: 'account-erasure' };
    if (faceTemplates) await recordFaceEvidenceHeld(tx, { ...held, evidence: 'FACE_TEMPLATE', item: `face-template:${userId}` });
    if (livenessChecks) {
      await recordFaceEvidenceHeld(tx, { ...held, evidence: 'LIVENESS_CHECKS', item: `liveness-checks:${userId}`, details: { count: livenessChecks } });
    }
    return { held: true, holdIds, faceTemplates, livenessChecks };
  });
}

/** Inside a hold's release, under the person's row lock: an erased person's face records were kept only
 *  for their holds, so once the last one is released they go, and that is recorded against it. */
export async function eraseFaceRecordsOnRelease(
  tx: Tx, hold: { id: string; subjectUserId: string; tenantId: string }, actorId: string,
): Promise<{ faceTemplates: number; livenessChecks: number } | null> {
  const subject = await tx.user.findUnique({ where: { id: hold.subjectUserId }, select: { phone: true } });
  if (subject?.phone !== `deleted:${hold.subjectUserId}`) return null;
  if ((await activeFaceEvidenceHolds(tx, hold.subjectUserId, hold.tenantId)).length) return null;
  const faceTemplates = (await tx.faceTemplate.deleteMany({ where: { accountId: hold.subjectUserId } })).count;
  const livenessChecks = (await tx.livenessCheck.deleteMany({ where: { userId: hold.subjectUserId } })).count;
  if (faceTemplates || livenessChecks) {
    await purgeEvent(tx, {
      tenantId: hold.tenantId, userId: hold.subjectUserId, holdId: hold.id, kind: 'FACE_EVIDENCE_ERASED', actorId,
      details: { faceTemplates, livenessChecks },
    });
  }
  return { faceTemplates, livenessChecks };
}

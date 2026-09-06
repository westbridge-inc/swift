/**
 * [DOC-1 Part XXV · P25] Data-subject rights against documents — the three
 * requests that will actually arrive.
 *
 * "Send me everything you have about me": the person's own documents, the
 * extracted field set (decrypted through the key provider — their data),
 * validator verdicts, decisions as CATEGORIES only (never a reviewer's
 * internal note or the precise reason), and the deletion receipts. Never
 * another person's data. The read is audited with a reason code (DOC-INV-21).
 *
 * "Delete my documents", answered honestly per document: already destroyed →
 * the receipt is the answer; under a legal hold, an AML record class, or an
 * approved licence backing a live relationship → refused with the specific
 * ground; otherwise destroyed now — bytes, key, probe, receipt — and the
 * extracted VALUES crypto-shredded with it (rows stay as the custody record).
 *
 * "Correct my details": re-opens a review case with the request recorded as
 * provenance; nothing here edits a record — the correction is a reviewer
 * action or it is not a correction (DOC-INV-34).
 */
import type { PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { getKeyProvider } from '../../providers/storage/envelope';
import { unpackAndDecrypt } from './extraction-ledger';
import { registryCode } from './doc-registry';
import { notifyAdmins, tenantOfUser, type NotificationService } from '../notification/notification.service';
import { REVIEW_SLA_HOURS, type VerificationService } from './verification.service';

export const DSAR_EXPORT_REASON = 'SUBJECT_ACCESS';
export const RECTIFICATION_PRIORITY = 50;

export type RefusalGround = 'LEGAL_HOLD' | 'AML_RECORD' | 'ACTIVE_LICENCE';

/** The obligation that refuses an erasure, if any — the ground is stated, never a vague no. */
export function refusalGround(doc: { held: boolean; amlRecord: boolean; approved: boolean; relationshipLive: boolean }): RefusalGround | null {
  if (doc.held) return 'LEGAL_HOLD';
  if (doc.amlRecord) return 'AML_RECORD';
  if (doc.approved && doc.relationshipLive) return 'ACTIVE_LICENCE';
  return null;
}

export async function exportDocumentsFor(prisma: PrismaClient, userId: string) {
  const docs = await prisma.verificationDocument.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    include: {
      extractionRuns: { orderBy: { startedAt: 'desc' }, include: { fields: { orderBy: { fieldCode: 'asc' } } } },
      validationResults: { orderBy: { validatorCode: 'asc' } },
    },
  });
  const ids = docs.map((d) => d.id);
  const cases = await prisma.reviewCase.findMany({ where: { submissionId: { in: ids } }, include: { decisions: { orderBy: { decidedAt: 'asc' } } } });
  const receipts = await prisma.deletionReceipt.findMany({ where: { subjectId: userId }, orderBy: { deletedAt: 'asc' } });
  const kp = getKeyProvider();
  let fieldCount = 0;
  const documents = [];
  for (const d of docs) {
    const fields = [];
    for (const run of d.extractionRuns) {
      const dek = run.wrappedDek && kp ? await kp.unwrapDek(Buffer.from(run.wrappedDek)) : null;
      for (const f of run.fields) {
        fieldCount += 1;
        const value = f.valueCt ? (dek ? unpackAndDecrypt(Buffer.from(f.valueCt), dek).toString('utf8') : null) : null;
        fields.push({ fieldCode: f.fieldCode, value, valueUnavailable: Boolean(f.valueCt) && !dek, isIllegible: f.isIllegible, source: f.source, readAt: run.startedAt });
      }
    }
    documents.push({
      id: d.id, docType: d.docType, role: d.role, status: d.status,
      submittedAt: d.createdAt, reviewedAt: d.reviewedAt, expiresAt: d.expiresAt, purgedAt: d.purgedAt,
      underLegalHold: d.legalHoldId !== null,
      fields,
      verdicts: d.validationResults.map((v) => ({ validatorCode: v.validatorCode, status: v.status, evaluatedAt: v.evaluatedAt })),
      // Categories only — never the reviewer's note, never the precise reason (§8.5).
      decisions: cases.filter((c) => c.submissionId === d.id).flatMap((c) => c.decisions.map((x) => ({ outcome: x.outcome, category: x.actorFacingCategory, decidedAt: x.decidedAt }))),
      receipts: receipts.filter((r) => r.submissionId === d.id).map((r) => ({ deletedAt: r.deletedAt, probe: r.verificationProbeResult, stores: r.storeLocations, bytesDeleted: Number(r.bytesDeleted) })),
    });
  }
  // [DOC-INV-21] A read of PERSONAL fields is audited with a reason code — the subject's own read included.
  await prisma.auditLog.create({ data: { userId, action: 'DSAR_DOCUMENT_EXPORT', entity: 'User', entityId: userId, changes: { documents: documents.length, fields: fieldCount, reasonCode: DSAR_EXPORT_REASON } } });
  return { generatedAt: new Date(), documents };
}

export interface EraseOutcome {
  documentId: string;
  docType: string;
  outcome: 'ALREADY_DESTROYED' | 'DESTROYED' | 'DESTRUCTION_PENDING' | 'REFUSED';
  ground?: RefusalGround;
  receipt?: { deletedAt: Date; probe: string; stores: string[] };
}

async function relationshipIsLive(prisma: PrismaClient, userId: string): Promise<boolean> {
  const [vendors, rider, driver] = await Promise.all([
    prisma.vendor.count({ where: { owner: { userId }, status: 'ACTIVE' } }),
    prisma.rider.findUnique({ where: { userId }, select: { documentsVerified: true } }),
    prisma.driver.findUnique({ where: { userId }, select: { documentsVerified: true } }),
  ]);
  return vendors > 0 || Boolean(rider?.documentsVerified) || Boolean(driver?.documentsVerified);
}

export async function eraseDocumentsFor(prisma: PrismaClient, service: VerificationService, userId: string, documentIds?: string[]): Promise<EraseOutcome[]> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { countryCode: true, tenantId: true } });
  if (!user) throw new NotFoundError('User', userId);
  const docs = await prisma.verificationDocument.findMany({
    where: { userId, ...(documentIds && documentIds.length > 0 ? { id: { in: documentIds } } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  const live = await relationshipIsLive(prisma, userId);
  const receiptOf = async (id: string) => {
    const r = await prisma.deletionReceipt.findFirst({ where: { submissionId: id }, orderBy: { deletedAt: 'desc' } });
    return r ? { deletedAt: r.deletedAt, probe: r.verificationProbeResult, stores: r.storeLocations } : undefined;
  };
  const outcomes: EraseOutcome[] = [];
  for (const d of docs) {
    if (d.purgedAt) { outcomes.push({ documentId: d.id, docType: d.docType, outcome: 'ALREADY_DESTROYED', receipt: await receiptOf(d.id) }); continue; }
    const type = await prisma.docType.findUnique({ where: { code: registryCode(user.countryCode, d.docType) }, select: { amlRecordClass: true } });
    const ground = refusalGround({
      held: d.legalHoldId !== null,
      amlRecord: Boolean(type && type.amlRecordClass !== 'NOT_APPLICABLE'),
      approved: d.status === 'APPROVED',
      relationshipLive: live,
    });
    if (ground) { outcomes.push({ documentId: d.id, docType: d.docType, outcome: 'REFUSED', ground }); continue; }
    const result = await service.purgeDocumentNow({ id: d.id, userId, fileUrl: d.fileUrl, docType: d.docType, user: { tenantId: user.tenantId } }, userId, { requireRetentionElapsed: false, shredFields: true });
    if (result === 'PURGED') outcomes.push({ documentId: d.id, docType: d.docType, outcome: 'DESTROYED', receipt: await receiptOf(d.id) });
    else if (result === 'PROBE_FAILED') outcomes.push({ documentId: d.id, docType: d.docType, outcome: 'DESTRUCTION_PENDING', receipt: await receiptOf(d.id) });
    else outcomes.push({ documentId: d.id, docType: d.docType, outcome: 'REFUSED', ground: 'LEGAL_HOLD' }); // a hold landed under the lock
  }
  await prisma.auditLog.create({ data: {
    userId, action: 'DSAR_DOCUMENT_ERASURE', entity: 'User', entityId: userId,
    changes: { outcomes: outcomes.map((o) => ({ documentId: o.documentId, outcome: o.outcome, ground: o.ground ?? null })) },
  } });
  return outcomes;
}

export async function requestRectification(
  prisma: PrismaClient,
  notifications: NotificationService,
  userId: string,
  input: { documentId: string; fieldCode: string; note: string },
) {
  const doc = await prisma.verificationDocument.findFirst({ where: { id: input.documentId, userId }, select: { id: true, docType: true, user: { select: { tenantId: true, countryCode: true } } } });
  if (!doc) throw new NotFoundError('VerificationDocument', input.documentId);
  const known = (await prisma.extractedField.count({ where: { submissionId: doc.id, fieldCode: input.fieldCode } })) > 0
    || (await prisma.docField.count({ where: { docTypeCode: registryCode(doc.user.countryCode, doc.docType), fieldCode: input.fieldCode } })) > 0;
  if (!known) throw new AppError(400, 'UNKNOWN_FIELD', `${input.fieldCode} is not a field of this document`);
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const open = await tx.reviewCase.findFirst({ where: { submissionId: doc.id, closedAt: null }, orderBy: { createdAt: 'desc' } })
      ?? await tx.reviewCase.create({ data: {
        submissionId: doc.id, tenantId: doc.user.tenantId, queue: 'STANDARD', priority: RECTIFICATION_PRIORITY,
        createdAt: now, slaDueAt: new Date(now.getTime() + REVIEW_SLA_HOURS * 3_600_000),
      } });
    const request = await tx.rectificationRequest.create({ data: {
      userId, submissionId: doc.id, caseId: open.id, fieldCode: input.fieldCode, note: input.note, tenantId: doc.user.tenantId,
    } });
    // The provenance: who asked for what, and the case it re-opened. Nothing here touches the record.
    await tx.auditLog.create({ data: { userId, action: 'DSAR_RECTIFICATION_REQUESTED', entity: 'VerificationDocument', entityId: doc.id, changes: { fieldCode: input.fieldCode, caseId: open.id, requestId: request.id } } });
    return { requestId: request.id, caseId: open.id };
  });
  await notifyAdmins(prisma, notifications, {
    tenantId: await tenantOfUser(prisma, userId),
    title: 'Correction requested on a verified document',
    body: `A person asks to correct ${input.fieldCode} on their ${doc.docType.replace(/_/g, ' ')}. Review the case — corrections are reviewer actions.`,
    data: { kind: 'verification_pending', docId: doc.id },
  }).catch(() => {});
  return result;
}

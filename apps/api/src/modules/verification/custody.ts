/**
 * [DOC-1 §20.2 · §20.3 · P20-2] The per-document chain of custody — one read model.
 *
 * For any future dispute a submission must answer: who captured it and when; what the
 * deterministic layer read and whether checks passed; what engine read it (version,
 * model hash); what a human changed and who; what the decision was, by whom, under
 * which reason code; when the bytes were destroyed, from which stores, with what probe
 * result. All of it is derivable from the submission, the extraction ledger, the review
 * decisions, the deletion receipts, the durable record and the audit chain — this file
 * derives it and says nothing more than §20.3 allows: field CODES and verdicts, never a
 * value; the reviewer's reason code, never their private note.
 */
import PDFDocument from 'pdfkit';
import type { Prisma, PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../utils/errors';

type Db = PrismaClient | Prisma.TransactionClient;

export interface CustodyEvent { at: string; actor: string | null; what: string; detail?: Record<string, unknown> }

export interface CustodyNarrative {
  submission: {
    id: string; docType: string; role: string; accountId: string; subjectId: string | null; state: string; status: string;
    capturedAt: string; consentAt: string | null; privacyNoticeVersion: string | null; expiresAt: string | null;
    purgedAt: string | null; imagePurgedAt: string | null; retentionExpiresAt: string | null; legalHoldId: string | null;
  };
  capture: { sha256: string | null; sizeBytes: number | null; mimeType: string | null; uploadedBy: string | null; encrypted: boolean; shreddedAt: string | null; deviceAndLocation: 'NOT_RECORDED' };
  extraction: Array<{
    runId: string; engine: string; engineVersion: string; modelSha256: string | null; profile: string; startedAt: string; finishedAt: string | null; durationMs: number | null;
    outcome: string; errorClass: string | null; ranExternally: boolean; processorRef: string | null;
    fields: Array<{ code: string; present: boolean; illegible: boolean; correctedBy: string | null; correctedAt: string | null }>;
  }>;
  validations: Array<{ code: string; status: string; detailCode: string | null; blocking: boolean; at: string }>;
  review: Array<{ caseId: string; queue: string; openedAt: string; assignedTo: string | null; closedAt: string | null;
    decisions: Array<{ reviewerId: string; outcome: string; reasonCode: string | null; actorFacingCategory: string | null; decidedAt: string; timeOnCaseMs: number | null }>;
    legalHolds: Array<{ id: string; placedBy: string; reason: string; placedAt: string; vaultStatus: string }> }>;
  record: { status: string; approvedBy: string; approvedAt: string; expiresOn: string | null; contentSha256: string | null } | null;
  destruction: Array<{ at: string; by: string; stores: string[]; bytesDeleted: number; probe: string; contentSha256: string | null }>;
  audit: { entries: CustodyEvent[]; chain: { anchoredAt: string | null; anchoredHeadSeq: string | null; anchorVerified: boolean | null } };
  timeline: CustodyEvent[];
  provable: string[];
  notProvable: string[];
  generatedAt: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function custodyNarrative(db: Db, submissionId: string): Promise<CustodyNarrative> {
  const doc = await db.verificationDocument.findUnique({
    where: { id: submissionId },
    select: {
      id: true, userId: true, role: true, docType: true, fileUrl: true, status: true, state: true, expiresAt: true, reviewedBy: true, reviewedAt: true,
      consentAt: true, privacyNoticeVersion: true, retentionExpiresAt: true, purgedAt: true, createdAt: true, legalHoldId: true, subjectId: true, imagePurgedAt: true,
      extractionRuns: { orderBy: { startedAt: 'asc' }, include: { fields: { orderBy: { fieldCode: 'asc' } } } },
      validationResults: { orderBy: { evaluatedAt: 'asc' } },
      record: true,
    },
  });
  if (!doc) throw new NotFoundError('VerificationDocument', submissionId);
  const [object, cases, receipts, auditRows, anchor] = await Promise.all([
    doc.fileUrl ? db.encryptedObject.findUnique({ where: { fileKey: doc.fileUrl }, select: { sha256: true, sizeBytes: true, mimeType: true, createdBy: true, shreddedAt: true, wrappedDek: true, createdAt: true } }) : Promise.resolve(null),
    db.reviewCase.findMany({ where: { submissionId }, orderBy: { createdAt: 'asc' }, include: { decisions: { orderBy: { decidedAt: 'asc' } }, holds: { orderBy: { placedAt: 'asc' } } } }).catch(async () =>
      db.reviewCase.findMany({ where: { submissionId }, orderBy: { createdAt: 'asc' }, include: { decisions: { orderBy: { decidedAt: 'asc' } } } }) as never),
    db.deletionReceipt.findMany({ where: { submissionId }, orderBy: { deletedAt: 'asc' } }),
    db.auditLog.findMany({ where: { entityId: submissionId }, orderBy: { createdAt: 'asc' }, select: { userId: true, action: true, entity: true, changes: true, createdAt: true } }),
    db.auditChainAnchor.findFirst({ orderBy: { anchoredAt: 'desc' }, select: { anchoredAt: true, headSeq: true, verified: true } }),
  ]);

  const extraction = doc.extractionRuns.map((r) => ({
    runId: r.id, engine: r.engineName, engineVersion: r.engineVersion, modelSha256: r.modelSha256 ?? null, profile: r.profileCode, startedAt: r.startedAt.toISOString(), finishedAt: iso(r.finishedAt),
    durationMs: r.durationMs ?? null, outcome: r.outcome, errorClass: r.errorClass ?? null, ranExternally: r.ranExternally, processorRef: r.processorRef ?? null,
    fields: r.fields.map((f) => ({ code: f.fieldCode, present: f.valueCt !== null, illegible: f.isIllegible, correctedBy: f.correctedBy ?? null, correctedAt: iso(f.correctedAt) })),
  }));
  const validations = doc.validationResults.map((v) => ({ code: v.validatorCode, status: v.status, detailCode: v.detailCode ?? null, blocking: v.isBlocking, at: v.evaluatedAt.toISOString() }));
  const review = (cases as Array<Prisma.ReviewCaseGetPayload<{ include: { decisions: true } }> & { holds?: Array<{ id: string; placedBy: string; reason: string; placedAt: Date; vaultStatus: string }> }>).map((c) => ({
    caseId: c.id, queue: c.queue, openedAt: c.createdAt.toISOString(), assignedTo: c.assignedTo ?? null, closedAt: iso(c.closedAt),
    decisions: c.decisions.map((d) => ({ reviewerId: d.reviewerId, outcome: d.outcome, reasonCode: d.reasonCode ?? null, actorFacingCategory: d.actorFacingCategory ?? null, decidedAt: d.decidedAt.toISOString(), timeOnCaseMs: d.timeOnCaseMs ?? null })),
    legalHolds: (c.holds ?? []).map((h) => ({ id: h.id, placedBy: h.placedBy, reason: h.reason, placedAt: h.placedAt.toISOString(), vaultStatus: h.vaultStatus })),
  }));
  const destruction = receipts.map((r) => ({ at: r.deletedAt.toISOString(), by: r.deletedBy, stores: r.storeLocations, bytesDeleted: Number(r.bytesDeleted), probe: r.verificationProbeResult, contentSha256: r.contentSha256 ? Buffer.from(r.contentSha256).toString('hex') : null }));
  const audit = auditRows.map((a) => ({ at: a.createdAt.toISOString(), actor: a.userId ?? null, what: a.action, detail: (a.changes as Record<string, unknown> | null) ?? undefined }));

  const timeline: CustodyEvent[] = [
    // Captured = the upload when the object is known (it precedes extraction, which precedes the row); else the row.
    { at: (object?.createdAt ?? doc.createdAt).toISOString(), actor: doc.userId, what: `SUBMITTED ${doc.docType} as ${doc.role}`, detail: { sha256: object?.sha256 ?? doc.record?.contentSha256 ?? null, consentAt: iso(doc.consentAt), privacyNoticeVersion: doc.privacyNoticeVersion } },
    ...extraction.map((r) => ({ at: r.startedAt, actor: `engine:${r.engine}@${r.engineVersion}`, what: `EXTRACTED ${r.outcome}${r.errorClass ? ` (${r.errorClass})` : ''}`, detail: { profile: r.profile, modelSha256: r.modelSha256, ranExternally: r.ranExternally, fields: r.fields.map((f) => `${f.code}:${f.illegible ? 'illegible' : f.present ? 'read' : 'absent'}`) } })),
    ...validations.map((v) => ({ at: v.at, actor: 'validator', what: `${v.code} ${v.status}${v.detailCode ? ` ${v.detailCode}` : ''}${v.blocking ? ' [blocking]' : ''}` })),
    ...review.flatMap((c) => [
      { at: c.openedAt, actor: null, what: `CASE OPENED (${c.queue})`, detail: { caseId: c.caseId } },
      ...c.decisions.map((d) => ({ at: d.decidedAt, actor: d.reviewerId, what: `DECIDED ${d.outcome}${d.reasonCode ? ` under ${d.reasonCode}` : ''}`, detail: { actorFacingCategory: d.actorFacingCategory, timeOnCaseMs: d.timeOnCaseMs } })),
      ...c.legalHolds.map((h) => ({ at: h.placedAt, actor: h.placedBy, what: `LEGAL HOLD (${h.vaultStatus})`, detail: { holdId: h.id } })),
    ]),
    ...(doc.reviewedAt && doc.reviewedBy ? [{ at: doc.reviewedAt.toISOString(), actor: doc.reviewedBy as string, what: `STATUS ${doc.status}`, detail: { expiresAt: iso(doc.expiresAt) } }] : []),
    ...(doc.record ? [{ at: doc.record.approvedAt.toISOString(), actor: doc.record.approvedBy, what: `RECORD ${doc.record.status}`, detail: { expiresOn: iso(doc.record.expiresOn), contentSha256: doc.record.contentSha256 } }] : []),
    ...destruction.map((d) => ({ at: d.at, actor: d.by, what: `DESTROYED from ${d.stores.join(', ')} — probe ${d.probe}`, detail: { bytesDeleted: d.bytesDeleted } })),
    ...(doc.imagePurgedAt ? [{ at: doc.imagePurgedAt.toISOString(), actor: null, what: 'IMAGE PURGED (record kept)' }] : []),
    ...(doc.purgedAt ? [{ at: doc.purgedAt.toISOString(), actor: null, what: 'SUBMISSION PURGED' }] : []),
    ...audit.map((a) => ({ ...a, what: `AUDIT ${a.what}` })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const sha = object?.sha256 ?? doc.record?.contentSha256 ?? destruction[0]?.contentSha256 ?? null;
  const passed = validations.filter((v) => v.status === 'PASS').map((v) => v.code);
  const lastDecision = review.flatMap((c) => c.decisions).at(-1);
  const provable = [
    `A document of type ${doc.docType}${sha ? `, hash ${sha}` : ' (hash not recorded)'}, was submitted at ${doc.createdAt.toISOString()} by account ${doc.userId}${doc.subjectId ? ` for subject ${doc.subjectId}` : ''}.`,
    passed.length ? `It passed validators ${passed.join(', ')}.` : 'No validator recorded a PASS for it.',
    lastDecision ? `Reviewer ${lastDecision.reviewerId} decided ${lastDecision.outcome} at ${lastDecision.decidedAt}${lastDecision.reasonCode ? ` under reason code ${lastDecision.reasonCode}` : ''}.` : doc.reviewedBy ? `${doc.reviewedBy} set ${doc.status} at ${iso(doc.reviewedAt)}.` : 'No decision has been recorded.',
    sha ? `Whether hash ${sha} appeared on another account is answerable from the extraction ledger (V_SHA_COLLISION verdict: ${validations.find((v) => v.code === 'V_SHA_COLLISION')?.status ?? 'not evaluated'}).` : 'No hash was recorded, so cross-account reuse of these exact bytes cannot be answered.',
    ...destruction.map((d) => `The bytes were destroyed at ${d.at} from ${d.stores.join(', ')}, probe ${d.probe}.`),
  ];
  const notProvable = [
    'What the document looked like (once purged; and never from this record).',
    'Anything not in the declared, extracted field set.',
    "The reviewer's private impression of it — the internal note is not part of this record.",
    'Whether a different photograph of the same physical document was submitted elsewhere.',
  ];
  return {
    submission: {
      id: doc.id, docType: doc.docType, role: doc.role, accountId: doc.userId, subjectId: doc.subjectId ?? null, state: (doc.state ?? 'UNSET') as string, status: doc.status,
      capturedAt: doc.createdAt.toISOString(), consentAt: iso(doc.consentAt), privacyNoticeVersion: doc.privacyNoticeVersion ?? null, expiresAt: iso(doc.expiresAt),
      purgedAt: iso(doc.purgedAt), imagePurgedAt: iso(doc.imagePurgedAt), retentionExpiresAt: iso(doc.retentionExpiresAt), legalHoldId: doc.legalHoldId ?? null,
    },
    capture: { sha256: object?.sha256 ?? null, sizeBytes: object?.sizeBytes ?? null, mimeType: object?.mimeType ?? null, uploadedBy: object?.createdBy ?? null, encrypted: Boolean(object?.wrappedDek), shreddedAt: iso(object?.shreddedAt), deviceAndLocation: 'NOT_RECORDED' },
    extraction, validations, review,
    record: doc.record ? { status: doc.record.status, approvedBy: doc.record.approvedBy, approvedAt: doc.record.approvedAt.toISOString(), expiresOn: iso(doc.record.expiresOn), contentSha256: doc.record.contentSha256 ?? null } : null,
    destruction,
    audit: { entries: audit, chain: { anchoredAt: iso(anchor?.anchoredAt), anchoredHeadSeq: anchor ? String(anchor.headSeq) : null, anchorVerified: anchor?.verified ?? null } },
    timeline, provable, notProvable, generatedAt: new Date().toISOString(),
  };
}

/** The exportable PDF — the narrative as an attorney, insurer or regulator would read it. */
export function renderCustodyPdf(n: CustodyNarrative): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(15).text('Swift — Document chain of custody', { underline: true });
    doc.moveDown(0.5).fontSize(9).text(`Submission ${n.submission.id} · ${n.submission.docType} · account ${n.submission.accountId} · generated ${n.generatedAt}`);
    doc.moveDown().fontSize(11).text('Timeline', { underline: true });
    doc.fontSize(9);
    for (const e of n.timeline) doc.text(`${e.at}  ${e.actor ?? '—'}  ${e.what}`);
    doc.moveDown().fontSize(11).text('What this record proves', { underline: true });
    doc.fontSize(9); for (const p of n.provable) doc.text(`• ${p}`);
    doc.moveDown().fontSize(11).text('What it does not prove', { underline: true });
    doc.fontSize(9); for (const p of n.notProvable) doc.text(`• ${p}`);
    doc.moveDown().fontSize(8).text(`Audit chain: ${n.audit.entries.length} entries for this submission; latest anchor ${n.audit.chain.anchoredAt ?? 'none'} (head ${n.audit.chain.anchoredHeadSeq ?? '—'}, verified: ${String(n.audit.chain.anchorVerified)}).`);
    doc.end();
  });
}

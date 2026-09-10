/**
 * The reviewer-facing read model for one verification submission.
 *
 * This is deliberately separate from the queue. The queue is a bounded index;
 * opening one row is the C1 event that may decrypt the declared fields needed
 * for a human comparison. Storage keys, provider references, blind indexes and
 * encryption material never cross the response boundary.
 */
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { getKeyProvider } from '../../providers/storage/envelope';
import { NotFoundError } from '../../utils/errors';
import { registryCode } from './doc-registry';
import { unpackAndDecrypt } from './extraction-ledger';

type ReviewDetailStore = PrismaClient | Prisma.TransactionClient;

export async function documentReviewDetailSnapshot(prisma: ReviewDetailStore, documentId: string) {
  const document = await prisma.verificationDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      userId: true,
      role: true,
      docType: true,
      status: true,
      state: true,
      expiresAt: true,
      consentAt: true,
      privacyNoticeVersion: true,
      retentionExpiresAt: true,
      purgedAt: true,
      imagePurgedAt: true,
      legalHoldId: true,
      storageProvenance: true,
      storageAnomalyCode: true,
      createdAt: true,
      reviewedAt: true,
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
          countryCode: true,
          driver: {
            select: {
              licensePlate: true,
              vehicleMake: true,
              vehicleModel: true,
              vehicleType: true,
            },
          },
        },
      },
      legalHold: {
        select: {
          id: true,
          reviewBy: true,
          placedAt: true,
          releasedAt: true,
        },
      },
      extractionRuns: {
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          profileCode: true,
          engineName: true,
          engineVersion: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          outcome: true,
          errorClass: true,
          ranExternally: true,
          confidence: true,
          schemaViolations: true,
          wrappedDek: true,
          fields: {
            orderBy: { fieldCode: 'asc' },
            select: {
              fieldCode: true,
              valueCt: true,
              confidence: true,
              source: true,
              isIllegible: true,
              correctedAt: true,
            },
          },
        },
      },
      validationResults: {
        orderBy: { evaluatedAt: 'asc' },
        select: {
          validatorCode: true,
          status: true,
          detailCode: true,
          isBlocking: true,
          evaluatedAt: true,
        },
      },
    },
  });
  if (!document) throw new NotFoundError('VerificationDocument', documentId);

  const [upload, cases, registry] = await Promise.all([
    prisma.verificationUpload.findFirst({
      where: {
        submissionId: document.id,
        userId: document.userId,
        purpose: { in: ['CHECKLIST_DOCUMENT', 'IDENTITY_DOCUMENT'] },
        state: 'CONSUMED',
      },
      select: {
        mimeType: true,
        sizeBytes: true,
        encrypted: true,
        createdAt: true,
      },
    }),
    prisma.reviewCase.findMany({
      where: { submissionId: document.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        queue: true,
        priority: true,
        slaDueAt: true,
        assignedAt: true,
        closedAt: true,
        createdAt: true,
        decisions: {
          orderBy: { decidedAt: 'asc' },
          select: {
            outcome: true,
            reasonCode: true,
            actorFacingCategory: true,
            decidedAt: true,
            timeOnCaseMs: true,
          },
        },
      },
    }),
    prisma.docType.findUnique({
      where: { code: registryCode(document.user.countryCode, document.docType) },
      select: {
        bucket: true,
        imagePolicy: true,
        amlRecordClass: true,
        alwaysReview: true,
        fields: {
          orderBy: { displayOrder: 'asc' },
          select: {
            fieldCode: true,
            dataType: true,
            isRequired: true,
            displayOrder: true,
          },
        },
      },
    }),
  ]);

  return { document, upload, cases, registry };
}

export type ReviewDetailSnapshot = Awaited<ReturnType<typeof documentReviewDetailSnapshot>>;
type ReviewCaseSnapshot = ReviewDetailSnapshot['cases'][number];

export interface ActiveReviewContext {
  currentCaseId: string;
  currentQueue: ReviewCaseSnapshot['queue'];
}

function isIndependentReviewQueue(queue: ReviewCaseSnapshot['queue']): boolean {
  return queue === 'SECOND_REVIEW' || queue === 'QA_BLIND';
}

/** Shape decision history from the lane that is currently locked to the
 * reviewer. In an independent lane, even the existence/count/metadata of an
 * earlier decision can reveal whether the case came from a human escalation
 * or a machine collision, so only the active case is returned and all outcome
 * history is omitted. */
export function reviewCasesForActiveLane(
  cases: ReviewCaseSnapshot[],
  context: ActiveReviewContext,
) {
  const activeCase = cases.find((reviewCase) => reviewCase.id === context.currentCaseId);
  if (!activeCase || activeCase.queue !== context.currentQueue) {
    throw new NotFoundError('ReviewCase', context.currentCaseId);
  }
  const independent = isIndependentReviewQueue(context.currentQueue);
  const visibleCases = independent ? [activeCase] : cases;
  return visibleCases.map((reviewCase) => ({
    id: reviewCase.id,
    queue: reviewCase.queue,
    priority: reviewCase.priority,
    slaDueAt: reviewCase.slaDueAt,
    assigned: reviewCase.assignedAt !== null && reviewCase.closedAt === null,
    assignedAt: reviewCase.assignedAt,
    closedAt: reviewCase.closedAt,
    createdAt: reviewCase.createdAt,
    independentReviewRequired: independent,
    ...(independent ? {} : { priorDecisionCount: reviewCase.decisions.length }),
    decisions: independent ? [] : reviewCase.decisions,
  }));
}

function canonicalSnapshotValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') };
  if (Prisma.Decimal.isDecimal(value)) return { $decimal: value.toString() };
  if (Array.isArray(value)) return value.map(canonicalSnapshotValue);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalSnapshotValue(child)]),
  );
}

/** Digest every encrypted field and every fact used to shape the response.
 * Phase two recomputes it under locks, so a decision, purge, field correction,
 * key rotation or applicant-profile change that wins during KMS work prevents
 * the stale plaintext from leaving the process. */
export function reviewDetailSnapshotDigest(snapshot: ReviewDetailSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalSnapshotValue(snapshot)), 'utf8')
    .digest('hex');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Review detail operation aborted');
}

/** Perform only the potentially slow KMS/decryption work. Callers that return
 * this value must re-lock and compare reviewDetailSnapshotDigest first. */
export async function renderDocumentReviewDetail(
  snapshot: ReviewDetailSnapshot,
  options: { signal?: AbortSignal } & ActiveReviewContext,
) {
  const { document, upload, cases, registry } = snapshot;
  const independentReview = isIndependentReviewQueue(options.currentQueue);
  throwIfAborted(options.signal);
  const declarationByCode = new Map(
    (registry?.fields ?? []).map((field) => [field.fieldCode, field] as const),
  );
  const keyProvider = getKeyProvider();
  const extraction = [];
  for (const run of document.extractionRuns) {
    let dek: Buffer | null = null;
    let keyUnavailable = false;
    if (run.wrappedDek) {
      if (!keyProvider) {
        keyUnavailable = true;
      } else {
        try {
          dek = await keyProvider.unwrapDek(Buffer.from(run.wrappedDek), { signal: options.signal });
          throwIfAborted(options.signal);
        } catch (error) {
          throwIfAborted(options.signal);
          keyUnavailable = true;
        }
      }
    }
    const fields = run.fields.map((field) => {
      let value: string | null = null;
      let valueUnavailable = false;
      if (field.valueCt) {
        if (!dek) {
          valueUnavailable = true;
        } else {
          try {
            value = unpackAndDecrypt(Buffer.from(field.valueCt), dek).toString('utf8');
          } catch {
            valueUnavailable = true;
          }
        }
      }
      const declaration = declarationByCode.get(field.fieldCode);
      return {
        code: field.fieldCode,
        dataType: declaration?.dataType ?? null,
        required: declaration?.isRequired ?? false,
        value,
        valueUnavailable,
        present: field.valueCt !== null,
        confidence: field.confidence === null ? null : Number(field.confidence),
        source: field.source,
        illegible: field.isIllegible,
        correctedAt: field.correctedAt,
      };
    });
    extraction.push({
      runId: run.id,
      profile: run.profileCode,
      engine: run.engineName,
      engineVersion: run.engineVersion,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      outcome: run.outcome,
      errorClass: run.errorClass,
      ranExternally: run.ranExternally,
      confidence: run.confidence === null ? null : Number(run.confidence),
      schemaViolations: run.schemaViolations,
      keyUnavailable,
      fields,
    });
  }

  const declaredCodes = new Set(extraction.flatMap((run) => run.fields.map((field) => field.code)));
  const missingDeclaredFields = (registry?.fields ?? [])
    .filter((field) => !declaredCodes.has(field.fieldCode))
    .map((field) => ({
      code: field.fieldCode,
      dataType: field.dataType,
      required: field.isRequired,
      displayOrder: field.displayOrder,
    }));

  throwIfAborted(options.signal);
  return {
    document: {
      id: document.id,
      role: document.role,
      docType: document.docType,
      status: document.status,
      state: document.state,
      expiresAt: document.expiresAt,
      consentAt: document.consentAt,
      privacyNoticeVersion: document.privacyNoticeVersion,
      retentionExpiresAt: document.retentionExpiresAt,
      purgedAt: document.purgedAt,
      imagePurgedAt: document.imagePurgedAt,
      storageProvenance: document.storageProvenance,
      storageAnomalyCode: document.storageAnomalyCode,
      createdAt: document.createdAt,
      reviewedAt: document.reviewedAt,
    },
    applicant: document.user,
    content: upload,
    policy: registry ? {
      bucket: registry.bucket,
      imagePolicy: registry.imagePolicy,
      amlRecordClass: registry.amlRecordClass,
      alwaysReview: registry.alwaysReview,
    } : null,
    legalHold: document.legalHold,
    extraction,
    missingDeclaredFields,
    // Collision/velocity validator codes reveal whether an independent case was
    // machine-created or human-escalated. A blind reviewer receives the source
    // evidence and extracted values, but no automated verdict or origin signal.
    validations: independentReview ? [] : document.validationResults.map((validation) => ({
      code: validation.validatorCode,
      status: validation.status,
      detailCode: validation.detailCode,
      blocking: validation.isBlocking,
      evaluatedAt: validation.evaluatedAt,
    })),
    cases: reviewCasesForActiveLane(cases, options),
  };
}

/** Compatibility wrapper for non-HTTP callers. The admin disclosure route
 * uses snapshot/render/revalidate explicitly so KMS work never holds locks. */
export async function documentReviewDetail(
  prisma: ReviewDetailStore,
  documentId: string,
  context: ActiveReviewContext,
) {
  return renderDocumentReviewDetail(await documentReviewDetailSnapshot(prisma, documentId), context);
}

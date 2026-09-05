/**
 * [DOC-1 §4.4 · P4-4] The extraction ledger — a processor result lands as ROWS,
 * never in a log line.
 *
 * One extraction_run per processor call (engine, timing, outcome, whether the
 * document left the building). One extracted_field per DECLARED field of the
 * document type (§4.2 doc_field): the value envelope-encrypted under a per-run
 * DEK wrapped by the master KEK; a blind index (the identity graph's keyed
 * hash) when the field is blind-indexed; ABSENT (NULL) when the processor did
 * not return it. A key the registry does not declare is DROPPED and COUNTED —
 * never persisted, never named (DOC-INV-6). Then the validators the pipeline
 * can honestly evaluate at submission are written as validation_result rows,
 * and a blocking FAIL forbids auto-approval (§0.5: never past a FAIL).
 *
 * Without a KEK no value is stored at all: the row says ABSENT and the run says
 * NO_KEK. Plaintext PII in a column is not an option, in any environment.
 */
import type { Prisma, DocBucket, ExtractionOutcome, ValidationStatus } from '@prisma/client';
import { decryptBuffer, encryptBuffer, generateDek, getKeyProvider } from '../../providers/storage/envelope';
import { hashSignal, normalizeDocNumber } from '../integrity/normalize';
import type { KycEngine } from '../../providers/kyc/kyc-provider';
import { docExtractionRunCounter, docExtractionSchemaViolationCounter } from '../../plugins/observability';

/**
 * The processor contract's keys → §4.2 field codes. Data, not a case
 * conversion: the spec's identity field is `doc_number`. A key with no entry
 * here, or whose code the document type does not declare, is a schema
 * violation: dropped and counted.
 */
export const PROVIDER_KEY_TO_FIELD_CODE: Readonly<Record<string, string>> = { documentNumber: 'doc_number' };

export const V_ALL_REQUIRED_PRESENT = 'V_ALL_REQUIRED_PRESENT';
export const V_SHA_COLLISION = 'V_SHA_COLLISION';
/** An adapter that never described itself is recorded as an external unknown — the conservative reading. */
export const UNKNOWN_ENGINE: KycEngine = { name: 'unknown-adapter', version: 'unversioned', external: true };

export interface DeclaredField { fieldCode: string; isRequired: boolean; isBlindIndexed: boolean }
export interface PlannedField { fieldCode: string; valueCt: Buffer | null; valueBlind: string | null; isIllegible: boolean }
export interface PlannedValidation { validatorCode: string; status: ValidationStatus; detailCode: string | null; isBlocking: boolean }
export interface ExtractionPlan {
  run: {
    profileCode: string; engineName: string; engineVersion: string;
    startedAt: Date; finishedAt: Date; durationMs: number;
    outcome: ExtractionOutcome; errorClass: string | null;
    ranExternally: boolean; processorRef: string | null;
    wrappedDek: Buffer | null; schemaViolations: number;
    /** Processor-reported confidence for the set, 0..1; null = unknown. */
    confidence: number | null;
  };
  fields: PlannedField[];
  validations: PlannedValidation[];
  /** A blocking validator FAILed: this document may not be auto-approved. */
  blockingFail: boolean;
}
export interface ExtractionPlanInput {
  declared: readonly DeclaredField[];
  profileCode: string;
  engine: KycEngine;
  extracted: Readonly<Record<string, unknown>> | undefined;
  startedAt: Date;
  finishedAt: Date;
  collided: boolean;
  /** Processor-reported confidence, 0..1; undefined = unknown. */
  confidence?: number;
}

/** iv(12) | authTag(16) | ciphertext — the same layout the KEK uses for a wrapped DEK. */
export function packCiphertext(e: { ciphertext: Buffer; iv: Buffer; authTag: Buffer }): Buffer {
  return Buffer.concat([e.iv, e.authTag, e.ciphertext]);
}
export function unpackAndDecrypt(blob: Buffer, dek: Buffer): Buffer {
  return decryptBuffer(blob.subarray(28), dek, blob.subarray(0, 12), blob.subarray(12, 28));
}

export async function planExtraction(input: ExtractionPlanInput): Promise<ExtractionPlan> {
  const declaredByCode = new Map(input.declared.map((f) => [f.fieldCode, f] as const));
  const present = new Map<string, string>();
  let schemaViolations = 0;
  for (const [key, raw] of Object.entries(input.extracted ?? {})) {
    if (raw === undefined || raw === null || raw === '') continue; // absent, not a violation
    const code = PROVIDER_KEY_TO_FIELD_CODE[key];
    // DOC-INV-6: undeclared for this document type, or not the declared shape — dropped, counted, never named.
    if (!code || !declaredByCode.has(code) || typeof raw !== 'string') { schemaViolations += 1; continue; }
    present.set(code, raw);
  }

  let dek: Buffer | null = null;
  let wrappedDek: Buffer | null = null;
  let noKek = false;
  if (present.size > 0) {
    const kp = getKeyProvider();
    if (kp) { dek = generateDek(); wrappedDek = await kp.wrapDek(dek); } else noKek = true;
  }

  const fields: PlannedField[] = input.declared.map((f) => {
    const v = present.get(f.fieldCode);
    if (v === undefined) return { fieldCode: f.fieldCode, valueCt: null, valueBlind: null, isIllegible: false };
    return {
      fieldCode: f.fieldCode,
      valueCt: dek ? packCiphertext(encryptBuffer(Buffer.from(v, 'utf8'), dek)) : null,
      valueBlind: f.isBlindIndexed ? hashSignal(normalizeDocNumber(v)) : null,
      isIllegible: false,
    };
  });

  const required = input.declared.filter((f) => f.isRequired);
  const requiredMissing = required.filter((f) => !present.has(f.fieldCode));
  const outcome: ExtractionOutcome =
    required.length > 0 && requiredMissing.length === required.length ? 'FAILED' // T6: not one required field — the human keys it
    : requiredMissing.length > 0 || noKek ? 'PARTIAL'
    : 'OK';
  const errorClass = noKek ? 'NO_KEK' : outcome === 'FAILED' ? 'NO_REQUIRED_FIELDS' : null;

  const validations: PlannedValidation[] = [
    input.declared.length === 0
      ? { validatorCode: V_ALL_REQUIRED_PRESENT, status: 'SKIP', detailCode: 'NO_DECLARED_FIELDS', isBlocking: true }
      : requiredMissing.length > 0
        ? { validatorCode: V_ALL_REQUIRED_PRESENT, status: 'FAIL', detailCode: 'MISSING_REQUIRED', isBlocking: true }
        : { validatorCode: V_ALL_REQUIRED_PRESENT, status: 'PASS', detailCode: null, isBlocking: true },
    // §7.5: a collision never auto-approves and routes to SECOND_REVIEW (held by the
    // collision rule itself); the verdict is recorded as a WARN, not a rejection ground.
    input.collided
      ? { validatorCode: V_SHA_COLLISION, status: 'WARN', detailCode: 'CROSS_SUBJECT_SHA', isBlocking: false }
      : { validatorCode: V_SHA_COLLISION, status: 'PASS', detailCode: null, isBlocking: false },
  ];

  return {
    run: {
      profileCode: input.profileCode, engineName: input.engine.name, engineVersion: input.engine.version,
      startedAt: input.startedAt, finishedAt: input.finishedAt,
      durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
      outcome, errorClass, ranExternally: input.engine.external, processorRef: input.engine.processorRef ?? null,
      wrappedDek, schemaViolations,
      confidence: typeof input.confidence === 'number' && Number.isFinite(input.confidence)
        ? Math.round(Math.min(1, Math.max(0, input.confidence)) * 1000) / 1000
        : null,
    },
    fields,
    validations,
    blockingFail: validations.some((v) => v.isBlocking && v.status === 'FAIL'),
  };
}

/** Writes the plan as rows inside the caller's transaction — the document's, so a submission without its ledger cannot commit. */
export async function persistExtraction(
  tx: Prisma.TransactionClient,
  args: { submissionId: string; tenantId: string; plan: ExtractionPlan },
): Promise<void> {
  const { plan, submissionId, tenantId } = args;
  // Prisma Bytes columns take a Uint8Array over a plain ArrayBuffer; a Node Buffer is copied into one.
  const bytes = (b: Buffer | null) => (b ? new Uint8Array(b) : null);
  await tx.extractionRun.create({ data: {
    ...plan.run, wrappedDek: bytes(plan.run.wrappedDek), submissionId, tenantId,
    fields: { create: plan.fields.map((f) => ({ ...f, valueCt: bytes(f.valueCt), submissionId, tenantId, source: 'PROVIDER' as const })) },
  } });
  if (plan.validations.length > 0) {
    await tx.validationResult.createMany({ data: plan.validations.map((v) => ({ ...v, submissionId, tenantId })) });
  }
}

/** After the transaction committed: counts only — no value, no key name, ever. */
export function recordExtractionMetrics(plan: ExtractionPlan): void {
  docExtractionRunCounter.inc({ engine: plan.run.engineName, outcome: plan.run.outcome });
  if (plan.run.schemaViolations > 0) docExtractionSchemaViolationCounter.inc({ engine: plan.run.engineName }, plan.run.schemaViolations);
}

// ---------------------------------------------------------------------------
// [DOC-1 §6.9 · P6-4] Routing after extraction. The registry speaks for a
// document type once it is ACTIVE (legal facts verified); until then the
// legacy behaviour holds — the processor verdict, minus the §0.5 gate above.
// ---------------------------------------------------------------------------

/**
 * The always_review_set at launch (§6.9): every PERSONAL-bucket document and
 * anything that still needs a specimen — by rule; plus whatever the registry
 * marks alwaysReview by fact (the insurance certificate: covers_hire_and_reward
 * is a wording judgement a model must not make alone — FD-DOC-6). The fact
 * lives in the registry seed, never as a document-type literal here (DOC-INV-2).
 */
export interface RoutingType {
  isActive: boolean;
  bucket: DocBucket;
  needsSpecimen: boolean;
  alwaysReview: boolean;
  minConfidenceAutoApprove: { toString(): string } | number;
}
export function alwaysReview(type: Pick<RoutingType, 'bucket' | 'needsSpecimen' | 'alwaysReview'>): boolean {
  return type.bucket === 'PERSONAL' || type.needsSpecimen || type.alwaysReview;
}

export type IneligibleReason =
  | 'BLOCKING_FAIL' | 'ALWAYS_REVIEW' | 'COLLISION' | 'NOT_VALIDATED' | 'CONFIDENCE_UNKNOWN' | 'CONFIDENCE_BELOW_THRESHOLD';

/**
 * auto_approve_eligible (§6.9): every blocking validator PASS (a SKIP is not a
 * PASS — nothing was checked), confidence known and at or above the type's
 * threshold, no cross-subject collision, type not in the always-review set.
 * Evaluated only when the registry speaks for the type; the §0.5 gate applies
 * regardless.
 */
export function autoApproveEligible(
  plan: ExtractionPlan,
  type: RoutingType | null,
  collided: boolean,
): { eligible: boolean; reason: IneligibleReason | null } {
  if (plan.blockingFail) return { eligible: false, reason: 'BLOCKING_FAIL' };
  if (!type?.isActive) return { eligible: true, reason: null }; // the registry is silent: legacy behaviour
  if (alwaysReview(type)) return { eligible: false, reason: 'ALWAYS_REVIEW' };
  if (collided) return { eligible: false, reason: 'COLLISION' };
  if (!plan.validations.some((v) => v.isBlocking) || plan.validations.some((v) => v.isBlocking && v.status !== 'PASS')) {
    return { eligible: false, reason: 'NOT_VALIDATED' };
  }
  if (plan.run.confidence === null) return { eligible: false, reason: 'CONFIDENCE_UNKNOWN' };
  if (plan.run.confidence < Number(type.minConfidenceAutoApprove)) return { eligible: false, reason: 'CONFIDENCE_BELOW_THRESHOLD' };
  return { eligible: true, reason: null };
}

const INELIGIBLE_TEXT: Record<IneligibleReason, string> = {
  BLOCKING_FAIL: 'Required fields could not be read from the document — human review',
  ALWAYS_REVIEW: 'This document type is always reviewed by a person (DOC-1 §6.9)',
  COLLISION: 'Duplicate of a document already on another account — second review required',
  NOT_VALIDATED: 'Nothing was validated for this document type — human review',
  CONFIDENCE_UNKNOWN: 'The processor reported no confidence — human review',
  CONFIDENCE_BELOW_THRESHOLD: 'Processor confidence is below the auto-approval threshold — human review',
};

/** A processor approval becomes human review whenever §6.9 / §0.5 say it is not eligible. Anything else passes through untouched. */
export function gateAutoApproval<T extends { status: string; reason?: string; collided?: boolean }>(
  result: T,
  plan: ExtractionPlan,
  type: RoutingType | null,
): T {
  if (result.status !== 'approved') return result;
  const verdict = autoApproveEligible(plan, type, result.collided === true);
  if (verdict.eligible) return result;
  return { ...result, status: 'pending_manual', reason: INELIGIBLE_TEXT[verdict.reason!] };
}

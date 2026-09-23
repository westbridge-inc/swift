import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// [NO-AI · owner rule 2026-09-07] Identity and document verification is HUMAN
// review only. This seam once held two model-backed adapters (document OCR,
// authenticity scoring and face comparison, run by outside providers) and a
// sandbox that approved on a marker in the file name. All three are deleted,
// and so is every field through which an adapter could express a decision: a
// result carries a reference for the ledger and, at most, what an engine READ.
// It cannot say approved or rejected, because the contract has no such field.
//
// The interface stays because the extraction ledger records which engine
// handled a submission (DOC-1 P4-4) and because the outage ladder, custody and
// ledger suites are built against it. The only runtime implementation is the
// manual one below; `getKycProvider` refuses to construct anything else, and
// `no-ai-kyc-gate.unit.test.ts` fails the build if another one reappears.
// ---------------------------------------------------------------------------

export interface KycVerificationResult {
  /** Opaque reference recorded on the submission (kycRef). The manual engine mints one. */
  referenceToken: string;
  /** Why a person must look (an outage, a duplicate). Informational, never a decision. */
  reason?: string;
  /** What an engine READ, for the ledger (encrypted, blind-indexed, never persisted raw).
   *  The manual engine reads nothing: a reviewer keys the fields. */
  extracted?: { documentNumber?: string };
  /** An engine's reported confidence in what it read, 0..1, recorded on the run for the
   *  reviewer. It decides nothing. Absent = unknown. */
  confidence?: number;
}

/**
 * [DOC-1 §4.4 · P4-4] What the extraction ledger records about the adapter that
 * produced a result: engine name and version, whether the document LEFT THE
 * BUILDING (an external processor — its DGP-1 register code in processorRef).
 */
export interface KycEngine {
  name: string;
  version: string;
  external: boolean;
  processorRef?: string;
}

export interface KycProvider {
  /** Absent = an adapter that never described itself; the ledger records it as an external unknown. */
  readonly engine?: KycEngine;
  /** Hand ONE document to the engine of record. Nothing that comes back is a verdict. */
  verifyDocument(input: { userId: string; docType: string; fileUrl: string }): Promise<KycVerificationResult>;
}

/**
 * [FD-DOC-3b · founder decision 2026-09-07 · option (b) ON SHORE] No document image ever leaves
 * Swift's infrastructure: nothing is read automatically, every submission lands PENDING for a
 * human reviewer who keys the fields and decides. This engine returns a reference and nothing
 * else.
 */
export class ManualReviewKycProvider implements KycProvider {
  readonly engine: KycEngine = { name: 'manual-review', version: '1', external: false };
  async verifyDocument(): Promise<KycVerificationResult> { return { referenceToken: `manual_${randomUUID()}` }; }
}

/** `manual` is not the safe choice among several: it is the only implementation that exists. */
export function getKycProvider(): KycProvider {
  const provider = process.env['KYC_PROVIDER'];
  if (provider !== 'manual') {
    throw new Error(`KYC_PROVIDER must be 'manual' (human review); got ${provider === undefined ? 'unset' : JSON.stringify(provider)}. No other identity provider exists.`);
  }
  return new ManualReviewKycProvider();
}

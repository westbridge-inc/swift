/**
 * [DOC-1 §4.4 · DOC-INV-7] Proof of purge.
 *
 * "Every purge writes a deletion_receipt with a passing verification probe."
 * The probe is not the delete call's return value — the local adapter
 * swallows unlink errors and an object store can lie for a moment — it is an
 * ACTUAL read attempt against every named location after the deletion, plus
 * the wrapped key being gone. A receipt without a passing probe is not a
 * receipt: callers decide what that means (the reaper leaves the row due and
 * retries; erasure records the failure and files the storage orphan).
 */
import type { Prisma } from '@prisma/client';

export type ProbeResult = 'CONFIRMED_ABSENT' | 'FAILED';
export interface PurgeEvidence {
  /** sha256 of the original bytes (the envelope row's record), else of the ciphertext read before deletion; null when both are gone. */
  sha256: Buffer | null;
  bytesDeleted: bigint;
  storeLocations: string[];
  probe: ProbeResult;
}
/** Nothing was ever stored for this document: there is nothing to prove absent. */
export const NOTHING_STORED: PurgeEvidence = { sha256: null, bytesDeleted: 0n, storeLocations: [], probe: 'CONFIRMED_ABSENT' };

export interface ReceiptInput {
  submissionId: string;
  subjectId: string;
  tenantId: string;
  docTypeCode: string;
  /** 'reaper' | the account id that requested erasure */
  deletedBy: string;
  evidence: PurgeEvidence;
}

/** The receipt row — written inside the purge's own transaction, so a purge without a receipt cannot commit. */
export async function writeDeletionReceipt(tx: Pick<Prisma.TransactionClient, 'deletionReceipt'>, input: ReceiptInput) {
  return tx.deletionReceipt.create({
    data: {
      submissionId: input.submissionId,
      subjectId: input.subjectId,
      tenantId: input.tenantId,
      docTypeCode: input.docTypeCode,
      contentSha256: input.evidence.sha256 ? new Uint8Array(input.evidence.sha256) : null,
      bytesDeleted: input.evidence.bytesDeleted,
      deletedBy: input.deletedBy,
      storeLocations: input.evidence.storeLocations,
      verificationProbeResult: input.evidence.probe,
    },
  });
}

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
import type { StorageProvider } from '../../providers/storage/storage-provider';
import { resolveVerificationObject, type VerificationObjectReference, type VerificationObjectStore } from './object-authority';

export type ProbeResult = 'CONFIRMED_ABSENT' | 'FAILED';
export interface PurgeEvidence {
  /** sha256 of the original bytes from proven envelope metadata; null only for NOTHING_STORED. */
  sha256: Buffer | null;
  bytesDeleted: bigint;
  storeLocations: string[];
  probe: ProbeResult;
}
/** Nothing was ever stored for this document: there is nothing to prove absent. */
export const NOTHING_STORED: PurgeEvidence = { sha256: null, bytesDeleted: 0n, storeLocations: [], probe: 'CONFIRMED_ABSENT' };

function isMissingObject(error: unknown): boolean {
  const e = error as { code?: string; name?: string } | null;
  return e?.code === 'ENOENT' || e?.name === 'NoSuchKey' || e?.name === 'NotFound';
}

/** Delete the bytes, shred the key, then PROBE — a real read attempt against each store. */
export async function shredAndProbe(prisma: VerificationObjectStore, storage: StorageProvider, ref: VerificationObjectReference): Promise<PurgeEvidence> {
  const meta = await resolveVerificationObject(prisma, ref);
  const { fileKey } = ref;
  const storeLocations = [`storage:${fileKey}`, `encrypted_object:${fileKey}`];
  const sha256 = Buffer.from(meta.sha256, 'hex');
  let before: Buffer | null;
  try {
    before = await storage.getObject(fileKey);
  } catch (error) {
    if (!isMissingObject(error)) return { sha256, bytesDeleted: 0n, storeLocations, probe: 'FAILED' };
    before = null;
  }
  const bytesDeleted = BigInt(before?.length ?? meta.sizeBytes);
  await storage.delete(fileKey).catch(() => undefined);
  // Crypto-shred (spec §5.5): the wrapped DEK goes even if the bytes linger —
  // a ciphertext without its key is unrecoverable from any backup.
  await prisma.encryptedObject.updateMany({ where: { fileKey, createdBy: ref.userId }, data: { wrappedDek: null, shreddedAt: new Date() } });
  // The probe. Both must hold: the bytes are unreadable AND the key is gone.
  const absent = await storage.getObject(fileKey).then(() => false).catch(isMissingObject);
  const keyGone = await prisma.encryptedObject.findUnique({ where: { fileKey }, select: { wrappedDek: true } })
    .then((row) => row !== null && row.wrappedDek === null).catch(() => false);
  return { sha256, bytesDeleted, storeLocations, probe: absent && keyGone ? 'CONFIRMED_ABSENT' : 'FAILED' };
}

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

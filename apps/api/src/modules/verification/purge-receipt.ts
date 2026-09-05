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
import crypto from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { StorageProvider } from '../../providers/storage/storage-provider';

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

type ObjectStore = Pick<PrismaClient, 'encryptedObject'>;

/** Delete the bytes, shred the key, then PROBE — a real read attempt against each store. */
export async function shredAndProbe(prisma: ObjectStore, storage: StorageProvider, fileKey: string): Promise<PurgeEvidence> {
  const storeLocations = [`storage:${fileKey}`, `encrypted_object:${fileKey}`];
  const before = await storage.getObject(fileKey).catch(() => null);
  const meta = await prisma.encryptedObject.findUnique({ where: { fileKey }, select: { sizeBytes: true, sha256: true } }).catch(() => null);
  // The envelope row records the sha256 of the ORIGINAL bytes (what the person
  // uploaded); that is the fingerprint the receipt should carry. Only when the
  // row is gone does the ciphertext's own hash stand in.
  const recorded = meta?.sha256 && /^[0-9a-f]{64}$/i.test(meta.sha256) ? Buffer.from(meta.sha256, 'hex') : null;
  const sha256 = recorded ?? (before ? crypto.createHash('sha256').update(before).digest() : null);
  const bytesDeleted = BigInt(before?.length ?? meta?.sizeBytes ?? 0);
  await storage.delete(fileKey).catch(() => undefined);
  // Crypto-shred (spec §5.5): the wrapped DEK goes even if the bytes linger —
  // a ciphertext without its key is unrecoverable from any backup.
  await prisma.encryptedObject.updateMany({ where: { fileKey }, data: { wrappedDek: null, shreddedAt: new Date() } });
  // The probe. Both must hold: the bytes are unreadable AND the key is gone.
  const stillReadable = await storage.getObject(fileKey).then(() => true).catch(() => false);
  const row = await prisma.encryptedObject.findUnique({ where: { fileKey }, select: { wrappedDek: true } }).catch(() => null);
  const keyGone = !row || row.wrappedDek === null;
  return { sha256, bytesDeleted, storeLocations, probe: !stillReadable && keyGone ? 'CONFIRMED_ABSENT' : 'FAILED' };
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

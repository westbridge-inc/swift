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
import type { Prisma, PrismaClient } from '@prisma/client';
import type { StorageProvider } from '../../providers/storage/storage-provider';
import { bindTenantTransaction } from '../../plugins/prisma';
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

type ObjectMeta = Awaited<ReturnType<typeof resolveVerificationObject>>;

/** Delete the bytes, shred the key (if still there), then PROBE — a real read attempt against each store. */
async function destroyAndProbe(prisma: VerificationObjectStore, storage: StorageProvider, ref: VerificationObjectReference, meta: ObjectMeta): Promise<PurgeEvidence> {
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
  await prisma.encryptedObject.updateMany({ where: { fileKey, createdBy: ref.userId, wrappedDek: { not: null } }, data: { wrappedDek: null, shreddedAt: new Date() } });
  // The probe. Both must hold: the bytes are unreadable AND the key is gone.
  const absent = await storage.getObject(fileKey).then(() => false).catch(isMissingObject);
  const keyGone = await prisma.encryptedObject.findUnique({ where: { fileKey }, select: { wrappedDek: true } })
    .then((row) => row !== null && row.wrappedDek === null).catch(() => false);
  return { sha256, bytesDeleted, storeLocations, probe: absent && keyGone ? 'CONFIRMED_ABSENT' : 'FAILED' };
}

/** Delete the bytes, shred the key, then PROBE — a real read attempt against each store. */
export async function shredAndProbe(prisma: VerificationObjectStore, storage: StorageProvider, ref: VerificationObjectReference): Promise<PurgeEvidence> {
  return destroyAndProbe(prisma, storage, ref, await resolveVerificationObject(prisma, ref));
}

/**
 * [Row 243 · DOC-INV-14 · GUARDRAILS §2] A legal hold always beats a purge.
 *
 * The destruction is decided and DONE in one short database transaction under the person's
 * row lock: the document must still be unheld, and the object is crypto-shredded right there
 * (DEK gone, shreddedAt set) — without its key the ciphertext is unrecoverable from any copy.
 * Placing a hold takes the same lock (legal-hold.ts placeDocLegalHoldIn), so a hold either
 * committed first (nothing is destroyed: null), or comes after and finds the object already
 * shredded and does not claim it (a hold never resurrects bytes). The storage delete and the
 * probe run AFTER the lock is released, on bytes that are already unreadable: no storage call
 * ever runs under a lock, so a stalled store cannot outlive the transaction and let a hold in
 * before the destruction lands. A missing person row is never a pass: no lock, no destruction.
 * `still` narrows what "still purgeable" means for the caller (retention due, image not purged).
 * `keeps` is a caller's check that cannot be a row filter (the abandoned-application sweep: an open case naming the
 * person, REVIEW-M #2011 S4-1): it runs in this same transaction, under the lock, right before the key is destroyed;
 * true keeps the document (nothing destroyed: null). A check that throws destroys nothing either.
 */
export async function shredUnlessHeld(
  db: Pick<PrismaClient, '$transaction'> & VerificationObjectStore,
  storage: StorageProvider,
  ref: VerificationObjectReference & { documentId: string },
  still: Prisma.VerificationDocumentWhereInput = {},
  keeps?: (tx: Prisma.TransactionClient) => Promise<boolean>,
): Promise<PurgeEvidence | null> {
  const meta = await db.$transaction(async (tx) => {
    await bindTenantTransaction(tx);
    const person = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "users" WHERE "id" = ${ref.userId} FOR UPDATE /* verification-document-purge-authority */
    `;
    if (person.length !== 1) return null;
    const live = await tx.verificationDocument.findMany({
      where: { id: ref.documentId, userId: ref.userId, legalHoldId: null, ...still }, select: { id: true },
    });
    if (!live.some((d) => d.id === ref.documentId)) return null;
    if (keeps && (await keeps(tx))) return null;
    // A purge that shredded this key and then could not finish (store unreachable, probe failed)
    // left the person's own envelope keyless: finish destroying it rather than strand it.
    const prior = await tx.encryptedObject.findUnique({ where: { fileKey: ref.fileKey } });
    if (prior && prior.createdBy === ref.userId && prior.shreddedAt !== null && prior.wrappedDek === null) return prior;
    const object = await resolveVerificationObject(tx, ref);
    await tx.encryptedObject.updateMany({
      where: { fileKey: ref.fileKey, createdBy: ref.userId }, data: { wrappedDek: null, shreddedAt: new Date() },
    });
    return object;
  });
  if (!meta) return null;
  return destroyAndProbe(db, storage, ref, meta);
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

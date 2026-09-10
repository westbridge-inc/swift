import { createHash, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import {
  canonicalManagedObjectKey,
  managedObjectKeyAliases,
  managedObjectKeyIsNamespacedTo,
} from '../../utils/owned-storage-key';

export { managedObjectKeyIsNamespacedTo } from '../../utils/owned-storage-key';

type OwnershipStore = Pick<
  PrismaClient | Prisma.TransactionClient,
  'encryptedObject' | 'verificationDocument' | 'verificationUpload'
>;

export function canonicalVerificationObjectKey(raw: string): string | null {
  return canonicalManagedObjectKey(raw);
}

export function verificationObjectKeyAliases(raw: string): string[] {
  return managedObjectKeyAliases(raw);
}

export function verificationObjectKeyIsNamespacedTo(raw: string, userId: string): boolean {
  return managedObjectKeyIsNamespacedTo(raw, 'verification', userId);
}

export interface ResolveVerificationObjectOptions {
  allowDocumentId?: string;
  requireUnattached?: boolean;
  requireExclusiveReference?: boolean;
}

export interface ResolvedVerificationObject {
  providerKey: string;
  storageLocationId: string;
  objectVersion: string;
  mimeType: string;
  sizeBytes: number;
  encrypted: boolean;
  sha256: string;
}

/** Verify the final reviewer-facing plaintext, not merely provider length. The
 * consumed upload's digest is the sealed content authority for both encrypted
 * and unencrypted objects. */
export function assertVerificationObjectBodyIntegrity(
  object: Pick<ResolvedVerificationObject, 'sizeBytes' | 'sha256'>,
  body: Buffer,
): void {
  const actual = createHash('sha256').update(body).digest();
  const expected = /^[0-9a-f]{64}$/i.test(object.sha256)
    ? Buffer.from(object.sha256, 'hex')
    : Buffer.alloc(0);
  if (
    body.length !== object.sizeBytes
    || expected.length !== actual.length
    || !timingSafeEqual(actual, expected)
  ) {
    throw new AppError(
      409,
      'DOCUMENT_OBJECT_INTEGRITY',
      'The stored document no longer matches its upload authority.',
    );
  }
}

/**
 * Resolve only through a consumed, purpose-bound upload claim. A path-shaped
 * client or legacy document pointer is never object authority.
 */
export async function resolveOwnedVerificationObjectKey(
  prisma: OwnershipStore,
  userId: string,
  rawKey: string,
  options: ResolveVerificationObjectOptions,
): Promise<ResolvedVerificationObject | null> {
  if (!options.allowDocumentId || options.requireUnattached) return null;
  const canonical = canonicalVerificationObjectKey(rawKey);
  if (!canonical || !verificationObjectKeyIsNamespacedTo(rawKey, userId)) return null;

  const doc = await prisma.verificationDocument.findUnique({
    where: { id: options.allowDocumentId },
    select: {
      id: true,
      userId: true,
      fileUrl: true,
      docType: true,
      verificationRoleKey: true,
      storageProvenance: true,
      purgedAt: true,
    },
  });
  if (
    !doc
    || doc.userId !== userId
    || doc.fileUrl !== rawKey
    || doc.storageProvenance !== 'VERIFIED'
    || doc.purgedAt !== null
  ) return null;

  const claims = await prisma.verificationUpload.findMany({
    where: {
      submissionId: doc.id,
      userId,
      purpose: { in: ['CHECKLIST_DOCUMENT', 'IDENTITY_DOCUMENT'] },
      state: 'CONSUMED',
    },
    select: {
      id: true,
      providerKey: true,
      canonicalKey: true,
      storageLocationId: true,
      objectVersion: true,
      roleKey: true,
      docType: true,
      encrypted: true,
      sha256: true,
      sizeBytes: true,
      mimeType: true,
    },
  });
  if (claims.length !== 1) return null;
  const claim = claims[0]!;
  if (
    claim.providerKey !== rawKey
    || claim.canonicalKey !== canonical
    || claim.roleKey !== doc.verificationRoleKey
    || claim.docType !== doc.docType
    || !claim.objectVersion
    || !/^[0-9a-f]{64}$/i.test(claim.sha256)
  ) return null;

  if (options.requireExclusiveReference) {
    // A VerificationDocument stores only a provider key, so another document
    // with the same canonical pointer is ambiguous even when no upload claim
    // survives to tell us which historical location or generation it meant.
    // VerificationUpload has the missing identity facts: equal key text in a
    // different location or at a different immutable generation is a distinct
    // object and must not poison this claim.
    const [competingDocuments, competingObjectReferences] = await Promise.all([
      prisma.verificationDocument.count({
        where: {
          id: { not: doc.id },
          fileUrl: { in: verificationObjectKeyAliases(rawKey) },
        },
      }),
      prisma.verificationUpload.count({
        where: {
          id: { not: claim.id },
          storageLocationId: claim.storageLocationId,
          canonicalKey: claim.canonicalKey,
          objectVersion: claim.objectVersion,
        },
      }),
    ]);
    if (competingDocuments !== 0 || competingObjectReferences !== 0) return null;
  }

  const envelope = await prisma.encryptedObject.findUnique({
    where: { fileKey: claim.providerKey },
    select: { createdBy: true, sha256: true, sizeBytes: true, mimeType: true, wrappedDek: true, shreddedAt: true },
  });
  if (claim.encrypted) {
    if (
      !envelope
      || envelope.createdBy !== userId
      || envelope.sha256 !== claim.sha256
      || envelope.sizeBytes !== claim.sizeBytes
      || envelope.mimeType !== claim.mimeType
      || !envelope.wrappedDek
      || envelope.shreddedAt !== null
    ) return null;
  } else if (envelope) return null;
  return {
    providerKey: claim.providerKey,
    storageLocationId: claim.storageLocationId,
    objectVersion: claim.objectVersion,
    mimeType: claim.mimeType,
    sizeBytes: claim.sizeBytes,
    encrypted: claim.encrypted,
    sha256: claim.sha256.toLowerCase(),
  };
}

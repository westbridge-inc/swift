import { describe, expect, it, vi } from 'vitest';
import { resolveOwnedVerificationObjectKey } from '../modules/verification/storage-ownership';

const userId = 'storage-owner';
const documentId = 'document-primary';
const providerKey = `/uploads/verification/${userId}/object-primary`;
const canonicalKey = `verification/${userId}/object-primary`;

function ownershipStore(input?: {
  competingDocuments?: number;
  encrypted?: boolean;
  envelope?: null | {
    createdBy: string;
    sha256: string;
    sizeBytes: number;
    mimeType: string;
    wrappedDek: Uint8Array | null;
    shreddedAt: Date | null;
  };
  objectReferences?: Array<{
    id: string;
    storageLocationId: string;
    canonicalKey: string;
    objectVersion: string;
  }>;
}) {
  const documentCount = vi.fn().mockResolvedValue(input?.competingDocuments ?? 0);
  const uploadCount = vi.fn().mockImplementation(async ({ where }) => (
    input?.objectReferences ?? []
  ).filter((reference) => (
    reference.id !== where.id.not
    && reference.storageLocationId === where.storageLocationId
    && reference.canonicalKey === where.canonicalKey
    && reference.objectVersion === where.objectVersion
  )).length);
  const store = {
    verificationDocument: {
      findUnique: vi.fn().mockResolvedValue({
        id: documentId,
        userId,
        fileUrl: providerKey,
        docType: 'national_id',
        verificationRoleKey: 'MOVER',
        storageProvenance: 'VERIFIED',
        purgedAt: null,
      }),
      count: documentCount,
    },
    verificationUpload: {
      findMany: vi.fn().mockResolvedValue([{
        id: 'upload-primary',
        providerKey,
        canonicalKey,
        storageLocationId: 'store-current',
        objectVersion: 'generation-current',
        roleKey: 'MOVER',
        docType: 'national_id',
        encrypted: input?.encrypted ?? false,
        sha256: 'a'.repeat(64),
        sizeBytes: 123,
        mimeType: 'image/jpeg',
      }]),
      count: uploadCount,
    },
    encryptedObject: { findUnique: vi.fn().mockResolvedValue(input?.envelope ?? null) },
  };
  return { store, documentCount, uploadCount };
}

describe('verification storage reference exclusivity', () => {
  it('fails closed when a second document references an alias of the same canonical pointer', async () => {
    const { store, documentCount } = ownershipStore({ competingDocuments: 1 });

    await expect(resolveOwnedVerificationObjectKey(store as never, userId, providerKey, {
      allowDocumentId: documentId,
      requireExclusiveReference: true,
    })).resolves.toBeNull();

    expect(documentCount).toHaveBeenCalledWith({
      where: {
        id: { not: documentId },
        fileUrl: {
          in: [canonicalKey, `uploads/${canonicalKey}`, `/uploads/${canonicalKey}`],
        },
      },
    });
  });

  it('fails closed when a second upload references the same location, key, and generation', async () => {
    const { store, uploadCount } = ownershipStore({
      objectReferences: [{
        id: 'upload-competing',
        storageLocationId: 'store-current',
        canonicalKey,
        objectVersion: 'generation-current',
      }],
    });

    await expect(resolveOwnedVerificationObjectKey(store as never, userId, providerKey, {
      allowDocumentId: documentId,
      requireExclusiveReference: true,
    })).resolves.toBeNull();

    expect(uploadCount).toHaveBeenCalledWith({
      where: {
        id: { not: 'upload-primary' },
        storageLocationId: 'store-current',
        canonicalKey,
        objectVersion: 'generation-current',
      },
    });
  });

  it('keeps historical locations and immutable generations outside the exact-object identity', async () => {
    const { store, uploadCount } = ownershipStore({
      objectReferences: [
        {
          id: 'upload-old-location',
          storageLocationId: 'store-retired',
          canonicalKey,
          objectVersion: 'generation-current',
        },
        {
          id: 'upload-old-generation',
          storageLocationId: 'store-current',
          canonicalKey,
          objectVersion: 'generation-retired',
        },
      ],
    });

    await expect(resolveOwnedVerificationObjectKey(store as never, userId, providerKey, {
      allowDocumentId: documentId,
      requireExclusiveReference: true,
    })).resolves.toEqual({
      providerKey,
      storageLocationId: 'store-current',
      objectVersion: 'generation-current',
      mimeType: 'image/jpeg',
      sizeBytes: 123,
      encrypted: false,
      sha256: 'a'.repeat(64),
    });

    // The database predicate intentionally does not compare key text alone:
    // another store or another immutable version is a different object.
    expect(uploadCount).toHaveBeenCalledWith({
      where: {
        id: { not: 'upload-primary' },
        storageLocationId: 'store-current',
        canonicalKey,
        objectVersion: 'generation-current',
      },
    });
  });

  it('rejects an envelope that contradicts an unencrypted upload claim', async () => {
    const { store } = ownershipStore({
      envelope: {
        createdBy: userId,
        sha256: 'a'.repeat(64),
        sizeBytes: 123,
        mimeType: 'image/jpeg',
        wrappedDek: new Uint8Array([1]),
        shreddedAt: null,
      },
    });

    await expect(resolveOwnedVerificationObjectKey(store as never, userId, providerKey, {
      allowDocumentId: documentId,
      requireExclusiveReference: true,
    })).resolves.toBeNull();
  });

  it('rejects an encrypted upload claim when its envelope is missing', async () => {
    const { store } = ownershipStore({ encrypted: true, envelope: null });

    await expect(resolveOwnedVerificationObjectKey(store as never, userId, providerKey, {
      allowDocumentId: documentId,
      requireExclusiveReference: true,
    })).resolves.toBeNull();
  });
});

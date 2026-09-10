import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type PrismaClient,
  type VerificationPurgeMode,
  type VerificationUploadPurpose,
} from '@prisma/client';
import {
  getStorageProviderForLocation,
  type StoredObjectReference,
  type StorageProvider,
} from '../../providers/storage/storage-provider';
import {
  encryptBuffer,
  generateDek,
  getKeyProvider,
} from '../../providers/storage/envelope';
import { AppError, NotFoundError } from '../../utils/errors';
import { stripImageMetadata } from '../../utils/images';
import { recordStorageOrphan } from '../../lib/storage-orphans';
import { bindTenantTransaction } from '../../plugins/prisma';
import { canonicalVerificationObjectKey } from './storage-ownership';
import {
  type PurgeEvidence,
  writeDeletionReceipt,
} from './purge-receipt';

const UPLOAD_TTL_MS = 30 * 60 * 1000;
const SELFIE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type Logger = { error: (obj: Record<string, unknown>, msg: string) => void };
type UploadDb = Pick<PrismaClient, 'user' | 'verificationUpload' | 'encryptedObject' | 'storageOrphan' | '$transaction'>;

export interface VerificationUploadRequest {
  userId: string;
  purpose: VerificationUploadPurpose;
  roleKey?: string;
  docType?: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface VerificationUploadReceipt {
  uploadId: string;
  expiresAt: Date;
  duplicate: boolean;
}

function assertPurposeShape(input: VerificationUploadRequest): void {
  if (
    input.purpose === 'CHECKLIST_DOCUMENT'
    && (!input.roleKey || !input.docType)
  ) {
    throw new AppError(400, 'UPLOAD_PURPOSE_INVALID', 'Checklist uploads require the exact role and document type.');
  }
  if (
    input.purpose === 'IDENTITY_DOCUMENT'
    && (input.roleKey !== 'CUSTOMER' || input.docType !== 'identity_l2')
  ) {
    throw new AppError(400, 'UPLOAD_PURPOSE_INVALID', 'This upload is not valid for an identity document.');
  }
  if (
    input.purpose === 'IDENTITY_SELFIE'
    && (!input.roleKey || input.docType !== undefined)
  ) {
    throw new AppError(400, 'UPLOAD_PURPOSE_INVALID', 'Identity selfies require the verification role and no document type.');
  }
  if (
    input.purpose === 'IDENTITY_SELFIE'
    && !SELFIE_MIME_TYPES.has(input.mimeType)
  ) {
    throw new AppError(400, 'SELFIE_TYPE_INVALID', 'A selfie must be a JPEG, PNG, or WebP image.');
  }
}

/**
 * Persist authority before the storage write. Every failure after reservation
 * therefore leaves a row that a deletion worker can discover.
 */
export async function createVerificationUpload(
  db: UploadDb,
  storage: StorageProvider,
  log: Logger,
  input: VerificationUploadRequest,
): Promise<VerificationUploadReceipt> {
  assertPurposeShape(input);
  if (storage.exactDeleteCapability() === 'UNSUPPORTED') {
    throw new AppError(
      503,
      'VERIFICATION_STORAGE_UNSUPPORTED',
      'This storage provider has no proven exact-delete primitive for verification documents.',
    );
  }
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, tenantId: true, status: true },
  });
  if (!user) throw new NotFoundError('User', input.userId);
  if (['DEACTIVATED', 'BANNED', 'SUSPENDED'].includes(user.status)) {
    throw new AppError(409, 'ACCOUNT_INACTIVE', 'This account is not active.');
  }

  // Hash and process the exact privacy-shaped plaintext. Encrypted uploads
  // previously bypassed the storage seam's metadata stripper.
  const plaintext = stripImageMetadata(input.buffer, input.mimeType);
  const sha256 = createHash('sha256').update(plaintext).digest('hex');
  const keys = getKeyProvider();
  let storedBytes = plaintext;
  let envelope: {
    iv: Buffer;
    authTag: Buffer;
    wrappedDek: Buffer;
  } | null = null;
  if (keys) {
    const dek = generateDek();
    const encrypted = encryptBuffer(plaintext, dek);
    storedBytes = encrypted.ciphertext;
    envelope = {
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      wrappedDek: Buffer.from(await keys.wrapDek(dek)),
    };
  }

  const folder = `verification/${input.userId}`;
  const reserved = storage.reserveKey({
    filename: envelope ? `${input.filename}.enc` : input.filename,
    folder,
  });
  const canonicalKey = canonicalVerificationObjectKey(reserved.url);
  if (!canonicalKey) {
    throw new AppError(500, 'STORAGE_KEY_INVALID', 'The storage provider returned an invalid object identity.');
  }
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS);
  const claim = await db.verificationUpload.create({
    data: {
      tenantId: user.tenantId,
      userId: user.id,
      storageLocationId: storage.locationId(),
      providerKey: reserved.url,
      canonicalKey,
      purpose: input.purpose,
      roleKey: input.roleKey,
      docType: input.docType,
      mimeType: input.mimeType,
      sizeBytes: plaintext.length,
      sha256,
      encrypted: envelope !== null,
      state: 'UPLOADING',
      expiresAt,
    },
    select: { id: true },
  });

  let written: StoredObjectReference | null = null;
  try {
    const stored = await storage.upload({
      buffer: storedBytes,
      filename: envelope ? `${input.filename}.enc` : input.filename,
      mimeType: envelope ? 'application/octet-stream' : input.mimeType,
      folder,
      fileKey: reserved.url,
    });
    written = stored;
    if (stored.url !== reserved.url) {
      throw new Error('Storage provider changed a preallocated verification key');
    }
    await db.$transaction(async (tx) => {
      await bindTenantTransaction(tx);
      if (envelope) {
        await tx.encryptedObject.create({
          data: {
            fileKey: reserved.url,
            iv: new Uint8Array(envelope.iv),
            authTag: new Uint8Array(envelope.authTag),
            wrappedDek: new Uint8Array(envelope.wrappedDek),
            mimeType: input.mimeType,
            sizeBytes: plaintext.length,
            sha256,
            createdBy: input.userId,
          },
        });
      }
      const ready = await tx.verificationUpload.updateMany({
        where: { id: claim.id, userId: input.userId, state: 'UPLOADING' },
        data: { state: 'UPLOADED', objectVersion: stored.objectVersion },
      });
      if (ready.count !== 1) throw new Error('Verification upload reservation changed before commit');
    });
  } catch (error) {
    if (written?.url === reserved.url) {
      // A provider acknowledgement is the only moment at which we possess a
      // deletion capability. Seal that exact generation before authorizing a
      // retry worker; an unacknowledged write is never guessed safe to delete.
      await db.verificationUpload.updateMany({
        where: { id: claim.id, userId: input.userId, state: 'UPLOADING', objectVersion: null },
        data: { state: 'UPLOADED', objectVersion: written.objectVersion },
      }).catch((censusError) => {
        log.error({ error: censusError, uploadId: claim.id }, 'verification upload generation could not be sealed');
      });
      await db.verificationUpload.updateMany({
        where: {
          id: claim.id,
          userId: input.userId,
          state: 'UPLOADED',
          objectVersion: written.objectVersion,
        },
        data: { state: 'PURGE_PENDING', purgeRequestedAt: new Date() },
      }).catch((censusError) => {
        log.error({ error: censusError, uploadId: claim.id }, 'verification upload recovery state could not be recorded');
      });
      await recordStorageOrphan(db as PrismaClient, log, {
        key: reserved.url,
        reason: 'VERIFICATION_UPLOAD_INCOMPLETE',
        userId: input.userId,
        tenantId: user.tenantId,
        verificationUploadId: claim.id,
        storageLocationId: storage.locationId(),
      });
    } else {
      await db.verificationUpload.updateMany({
        where: { id: claim.id, userId: input.userId, state: 'UPLOADING' },
        data: {
          state: 'QUARANTINED',
          quarantineReason: written ? 'PROVIDER_KEY_CHANGED' : 'WRITE_OUTCOME_UNPROVEN',
          quarantinedAt: new Date(),
        },
      }).catch((censusError) => {
        log.error({ error: censusError, uploadId: claim.id }, 'unproved verification write could not be quarantined');
      });
    }
    throw error;
  }

  const duplicate = await db.verificationUpload.findFirst({
    where: {
      sha256,
      userId: { not: input.userId },
      state: { notIn: ['PURGED', 'QUARANTINED'] },
    },
    select: { id: true },
  });
  return { uploadId: claim.id, expiresAt, duplicate: duplicate !== null };
}

export interface RequiredUploadClaim {
  uploadId: string;
  purpose: VerificationUploadPurpose;
  roleKey?: string;
  docType?: string;
}

export interface AcquiredUploadClaim {
  id: string;
  purpose: VerificationUploadPurpose;
  providerKey: string;
  canonicalKey: string;
  storageLocationId: string;
  objectVersion: string;
  sha256: string;
  mimeType: string;
  roleKey: string | null;
  docType: string | null;
}

export interface AcquiredVerificationUploads {
  processingId: string;
  claims: AcquiredUploadClaim[];
}

type LockedClaimRow = AcquiredUploadClaim & {
  tenantId: string;
  userId: string;
  storageLocationId: string;
  roleKey: string | null;
  docType: string | null;
  encrypted: boolean;
  sizeBytes: number;
  state: string;
  expiresAt: Date;
  processingId: string | null;
  submissionId: string | null;
};

function claimFailure(message: string): AppError {
  return new AppError(409, 'UPLOAD_CLAIM_INVALID', message);
}

/**
 * Atomically move all requested one-use claims to one processing attempt.
 * The provider call happens only after this CAS commits.
 */
export async function acquireVerificationUploads(
  db: PrismaClient,
  userId: string,
  required: RequiredUploadClaim[],
): Promise<AcquiredVerificationUploads> {
  if (required.length === 0 || new Set(required.map((claim) => claim.uploadId)).size !== required.length) {
    throw claimFailure('Every submission requires distinct one-use uploads.');
  }

  // A missing object is definitive; a provider outage is not absence and must
  // not be converted into a manual-review document with no evidence bytes.
  for (const claim of required) {
    const pointer = await db.verificationUpload.findUnique({
      where: { id: claim.uploadId },
      select: {
        userId: true,
        state: true,
        providerKey: true,
        storageLocationId: true,
        objectVersion: true,
      },
    });
    if (!pointer || pointer.userId !== userId || pointer.state !== 'UPLOADED') {
      throw claimFailure('An upload is missing, belongs to another account, or was already used.');
    }
    if (!pointer.objectVersion) {
      await db.verificationUpload.updateMany({
        where: { id: claim.uploadId, userId, state: 'UPLOADED', objectVersion: null },
        data: {
          state: 'QUARANTINED',
          quarantineReason: 'OBJECT_GENERATION_UNSEALED',
          quarantinedAt: new Date(),
        },
      });
      throw claimFailure('The stored upload has no sealed object generation. Upload it again.');
    }
    const pointerStorage = getStorageProviderForLocation(pointer.storageLocationId);
    if (!pointerStorage) {
      throw new AppError(503, 'STORAGE_LOCATION_UNAVAILABLE', 'The storage location for this upload is unavailable. Try again later.');
    }
    const probe = await pointerStorage.probe(pointer.providerKey, pointer.objectVersion);
    if (probe === 'ABSENT' || probe === 'MISMATCH') {
      await db.verificationUpload.updateMany({
        where: { id: claim.uploadId, userId, state: 'UPLOADED' },
        data: {
          state: 'QUARANTINED',
          quarantineReason: probe === 'ABSENT'
            ? 'OBJECT_ABSENT_BEFORE_PROCESSING'
            : 'OBJECT_GENERATION_MISMATCH',
          quarantinedAt: new Date(),
        },
      });
      throw claimFailure('The stored upload is no longer present. Upload it again.');
    }
    if (probe === 'UNKNOWN') {
      throw new AppError(503, 'STORAGE_PROBE_INCONCLUSIVE', 'Storage could not verify this upload. Try again later.');
    }
  }

  const processingId = randomUUID();
  const processingPolicy = required.some((claim) => claim.purpose === 'IDENTITY_SELFIE')
    ? 'FACE_MATCH' as const
    : 'DOCUMENT_ONLY' as const;
  const ids = [...required.map((claim) => claim.uploadId)].sort();
  const claims = await db.$transaction(async (tx) => {
    await bindTenantTransaction(tx);
    const alive = await tx.$queryRaw<Array<{ status: string; tenantId: string }>>(
      Prisma.sql`SELECT status, "tenantId" FROM users WHERE id = ${userId} FOR UPDATE`,
    );
    if (!alive[0] || ['DEACTIVATED', 'BANNED', 'SUSPENDED'].includes(alive[0].status)) {
      throw new AppError(409, 'ACCOUNT_INACTIVE', 'This account is not active.');
    }
    // The User lock serializes this check with every other acquisition for the
    // account. A second pair of uploads cannot invoke KYC while an earlier
    // attempt is in flight, even when it uses different upload IDs.
    const otherAttempt = await tx.verificationUpload.findFirst({
      where: { userId, state: 'PROCESSING', id: { notIn: ids } },
      select: { id: true },
    });
    if (otherAttempt) {
      throw new AppError(409, 'VERIFICATION_ALREADY_PROCESSING', 'Another verification submission is already processing.');
    }
    const rows = await tx.$queryRaw<LockedClaimRow[]>(Prisma.sql`
      SELECT id::text, purpose, "providerKey", "canonicalKey", sha256, "mimeType",
             "tenantId", "userId", "storageLocationId", "objectVersion", "roleKey", "docType",
             encrypted, "sizeBytes", state, "expiresAt", "processingId"::text, "submissionId"
      FROM verification_uploads
      WHERE id::text IN (${Prisma.join(ids)})
      ORDER BY id
      FOR UPDATE
    `);
    if (rows.length !== required.length) throw claimFailure('One or more uploads do not exist.');
    const byId = new Map(rows.map((row) => [row.id, row]));
    const now = new Date();
    for (const expected of required) {
      const row = byId.get(expected.uploadId);
      if (
        !row
        || row.userId !== userId
        || row.tenantId !== alive[0].tenantId
        || !row.objectVersion
        || row.state !== 'UPLOADED'
        || row.processingId !== null
        || row.submissionId !== null
        || row.expiresAt.getTime() <= now.getTime()
        || row.purpose !== expected.purpose
        || row.roleKey !== (expected.roleKey ?? null)
        || row.docType !== (expected.docType ?? null)
        || canonicalVerificationObjectKey(row.providerKey) !== row.canonicalKey
      ) {
        throw claimFailure('An upload does not match this account, purpose, role, type, generation, or storage location.');
      }
      if (row.encrypted) {
        const envelope = await tx.encryptedObject.findUnique({
          where: { fileKey: row.providerKey },
          select: { createdBy: true, sha256: true, sizeBytes: true, mimeType: true, wrappedDek: true, shreddedAt: true },
        });
        if (
          !envelope
          || envelope.createdBy !== userId
          || envelope.sha256 !== row.sha256
          || envelope.sizeBytes !== row.sizeBytes
          || envelope.mimeType !== row.mimeType
          || !envelope.wrappedDek
          || envelope.shreddedAt !== null
        ) {
          throw claimFailure('Encrypted upload metadata is missing, mismatched, or shredded.');
        }
      }
    }
    if (new Set(rows.map((row) => row.canonicalKey)).size !== rows.length) {
      throw claimFailure('A document and selfie must be different stored objects.');
    }
    if (rows.length > 1 && new Set(rows.map((row) => row.sha256)).size !== rows.length) {
      throw claimFailure('A document and selfie must have different content.');
    }
    const acquired = await tx.verificationUpload.updateMany({
      where: { id: { in: ids }, userId, state: 'UPLOADED', processingId: null, submissionId: null },
      data: { state: 'PROCESSING', processingId, processingStartedAt: now, processingPolicy },
    });
    if (acquired.count !== rows.length) throw claimFailure('Another submission acquired one of these uploads.');
    return rows.map(({ id, purpose, providerKey, canonicalKey, storageLocationId, objectVersion, sha256, mimeType, roleKey, docType }) => ({
      id,
      purpose,
      providerKey,
      canonicalKey,
      storageLocationId,
      objectVersion: objectVersion!,
      sha256,
      mimeType,
      roleKey,
      docType,
    }));
  });
  return { processingId, claims };
}

/** Link one processing generation to its document; caller owns the transaction. */
export async function consumeVerificationUploads(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    processingId: string;
    uploadIds: string[];
    submissionId: string;
  },
): Promise<void> {
  const ids = [...input.uploadIds].sort();
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id::text
    FROM verification_uploads
    WHERE id::text IN (${Prisma.join(ids)})
    ORDER BY id
    FOR UPDATE
  `);
  if (rows.length !== ids.length) throw claimFailure('A processing upload disappeared before document creation.');
  const consumed = await tx.verificationUpload.updateMany({
    where: {
      id: { in: ids },
      userId: input.userId,
      state: 'PROCESSING',
      processingId: input.processingId,
      submissionId: null,
    },
    data: {
      state: 'CONSUMED',
      submissionId: input.submissionId,
      consumedAt: new Date(),
    },
  });
  if (consumed.count !== ids.length) {
    throw claimFailure('Upload processing authority changed before document creation.');
  }
}

/**
 * A processor or pre-commit failure consumes the generation rather than
 * returning it to UPLOADED (which would permit a second external disclosure).
 * The exact objects become durable purge obligations.
 */
export async function abandonVerificationUploads(
  db: PrismaClient,
  log: Logger,
  userId: string,
  authority: AcquiredVerificationUploads,
): Promise<void> {
  const now = new Date();
  const ids = authority.claims.map((claim) => claim.id);
  await db.verificationUpload.updateMany({
    where: {
      id: { in: ids },
      userId,
      processingId: authority.processingId,
      state: 'PROCESSING',
      submissionId: null,
    },
    data: { state: 'PURGE_PENDING', purgeRequestedAt: now },
  });
  const pending = await db.verificationUpload.findMany({
    where: { id: { in: ids }, userId, processingId: authority.processingId, state: 'PURGE_PENDING', submissionId: null },
    select: { id: true, providerKey: true, tenantId: true, storageLocationId: true },
  });
  await Promise.all(pending.map((claim) => recordStorageOrphan(db, log, {
    key: claim.providerKey,
    reason: 'VERIFICATION_PROCESSING_ABORTED',
    userId,
    tenantId: claim.tenantId,
    verificationUploadId: claim.id,
    storageLocationId: claim.storageLocationId,
  })));
}

const PURGE_MODE_STRENGTH: Record<VerificationPurgeMode, number> = {
  IMAGE_ONLY: 1,
  FULL_RETENTION: 2,
  FULL_ERASURE: 3,
};

export interface VerificationPurgeClaim {
  id: string;
  purpose: VerificationUploadPurpose;
  providerKey: string;
  canonicalKey: string;
  storageLocationId: string;
  objectVersion: string;
  sha256: string;
  sizeBytes: number;
  encrypted: boolean;
  state: 'PURGE_PENDING' | 'PURGED';
}

export interface AuthorizedVerificationPurge {
  document: {
    id: string;
    userId: string;
    tenantId: string;
    docType: string;
    mode: VerificationPurgeMode;
    requestedAt: Date;
    requestedBy: string;
  };
  claims: VerificationPurgeClaim[];
  alreadyFinalized: boolean;
}

type LockedPurgeDocument = {
  id: string;
  userId: string;
  tenantId: string;
  docType: string;
  verificationRoleKey: string | null;
  fileUrl: string;
  state: string | null;
  storageProvenance: string;
  storagePurgeRequestedAt: Date | null;
  storagePurgeMode: VerificationPurgeMode | null;
  storagePurgeRequestedBy: string | null;
  legalHoldId: string | null;
  retentionExpiresAt: Date | null;
  imagePurgedAt: Date | null;
  purgedAt: Date | null;
};

type LockedPurgeClaim = Omit<VerificationPurgeClaim, 'state'> & {
  userId: string;
  tenantId: string;
  roleKey: string | null;
  docType: string | null;
  processingId: string | null;
  processingPolicy: string | null;
  submissionId: string | null;
  state: string;
};

function exactPurgeClaimSet(doc: LockedPurgeDocument, claims: LockedPurgeClaim[]): void {
  if (claims.length === 0) {
    if (doc.fileUrl !== '') {
      throw new AppError(409, 'DOCUMENT_OBJECT_NOT_OWNED', 'Stored document bytes have no durable upload authority.');
    }
    return;
  }
  if (!['VERIFIED', 'QUARANTINED'].includes(doc.storageProvenance)) {
    throw new AppError(409, 'DOCUMENT_OBJECT_NOT_OWNED', 'Unverified legacy storage cannot authorize deletion.');
  }
  const primary = claims.filter((claim) => claim.purpose !== 'IDENTITY_SELFIE');
  if (primary.length !== 1) {
    throw new AppError(409, 'DOCUMENT_OBJECT_NOT_OWNED', 'The document does not have one exact primary upload authority.');
  }
  if (!doc.imagePurgedAt && !doc.purgedAt && primary[0]!.providerKey !== doc.fileUrl) {
    throw new AppError(409, 'DOCUMENT_OBJECT_NOT_OWNED', 'The primary upload authority does not match the document pointer.');
  }
  const expectedPrimaryPurpose = doc.docType === 'identity_l2' ? 'IDENTITY_DOCUMENT' : 'CHECKLIST_DOCUMENT';
  if (primary[0]!.purpose !== expectedPrimaryPurpose
    || !doc.verificationRoleKey
    || primary[0]!.roleKey !== doc.verificationRoleKey
    || primary[0]!.docType !== doc.docType
    || claims.some((claim) => !claim.objectVersion)
    || claims.some((claim) => canonicalVerificationObjectKey(claim.providerKey) !== claim.canonicalKey)
    || claims.some((claim) => claim.purpose === 'IDENTITY_SELFIE'
      && (claim.roleKey !== doc.verificationRoleKey || claim.docType !== null))) {
    throw new AppError(409, 'DOCUMENT_OBJECT_NOT_OWNED', 'The upload set does not match the document role, type, purpose, or canonical identity.');
  }
  const processingIds = new Set(claims.map((claim) => claim.processingId));
  const policies = new Set(claims.map((claim) => claim.processingPolicy));
  if (processingIds.size !== 1 || processingIds.has(null) || policies.size !== 1 || policies.has(null)) {
    throw new AppError(409, 'DOCUMENT_OBJECT_NOT_OWNED', 'The document upload set is not one sealed processing generation.');
  }
  const policy = primary[0]!.processingPolicy;
  const selfies = claims.filter((claim) => claim.purpose === 'IDENTITY_SELFIE');
  if ((policy === 'DOCUMENT_ONLY' && (claims.length !== 1 || selfies.length !== 0))
    || (policy === 'FACE_MATCH' && (claims.length !== 2 || selfies.length !== 1))) {
    throw new AppError(409, 'DOCUMENT_OBJECT_NOT_OWNED', 'The document upload set does not match its sealed processing policy.');
  }
  if (new Set(claims.map((claim) => claim.canonicalKey)).size !== claims.length
    || new Set(claims.map((claim) => claim.sha256)).size !== claims.length) {
    throw new AppError(409, 'DOCUMENT_OBJECT_NOT_OWNED', 'The document and selfie do not have distinct object and content identities.');
  }
}

/**
 * Linearization point for every verification-object deletion. The same User
 * lock is taken by legal-hold placement, then the document and all of its
 * immutable upload claims are locked before any claim can become purgeable.
 */
export async function authorizeVerificationPurge(
  db: PrismaClient,
  input: {
    documentId: string;
    userId: string;
    mode: VerificationPurgeMode;
    requestedBy: string;
    requireRetentionElapsed: boolean;
    now?: Date;
  },
): Promise<AuthorizedVerificationPurge> {
  const now = input.now ?? new Date();
  return db.$transaction(async (tx) => {
    await bindTenantTransaction(tx);
    const users = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM users WHERE id = ${input.userId}
      FOR UPDATE /* verification-document-purge-authority */
    `);
    if (!users[0]) throw new NotFoundError('User', input.userId);
    const docs = await tx.$queryRaw<LockedPurgeDocument[]>(Prisma.sql`
      SELECT d.id, d."userId", d."tenantId", d."docType", d."verificationRoleKey", d."fileUrl", d.state,
             d."storageProvenance", d."storagePurgeRequestedAt", d."storagePurgeMode",
             d."storagePurgeRequestedBy", d."legalHoldId", d."retentionExpiresAt",
             d."imagePurgedAt", d."purgedAt"
      FROM verification_documents d
      WHERE d.id = ${input.documentId} AND d."userId" = ${input.userId}
      FOR UPDATE OF d
    `);
    const doc = docs[0];
    if (!doc) throw new NotFoundError('VerificationDocument', input.documentId);
    if (doc.legalHoldId) {
      throw new AppError(409, 'DOCUMENT_LEGAL_HOLD', 'A legal hold blocks document deletion.');
    }
    const alreadyFinalized = input.mode === 'IMAGE_ONLY'
      ? doc.imagePurgedAt !== null || doc.purgedAt !== null
      : doc.purgedAt !== null;
    if (alreadyFinalized) {
      return {
        document: {
          id: doc.id,
          userId: doc.userId,
          tenantId: doc.tenantId,
          docType: doc.docType,
          mode: doc.storagePurgeMode ?? input.mode,
          requestedAt: doc.storagePurgeRequestedAt ?? now,
          requestedBy: doc.storagePurgeRequestedBy ?? input.requestedBy,
        },
        claims: [],
        alreadyFinalized: true,
      };
    }
    if (input.mode === 'IMAGE_ONLY' && doc.state !== 'COMMITTED') {
      throw new AppError(409, 'DOCUMENT_NOT_COMMITTED', 'Only a committed document image can be policy-purged.');
    }
    if (input.requireRetentionElapsed
      && (!doc.retentionExpiresAt || doc.retentionExpiresAt.getTime() >= now.getTime())) {
      throw new AppError(409, 'DOCUMENT_RETENTION_ACTIVE', 'The document retention period has not elapsed.');
    }

    const claims = await tx.$queryRaw<LockedPurgeClaim[]>(Prisma.sql`
      SELECT id::text, purpose, "providerKey", "canonicalKey", "storageLocationId", "objectVersion", sha256,
             "sizeBytes", encrypted, state, "userId", "tenantId", "roleKey", "docType",
             "processingId"::text, "processingPolicy", "submissionId"
      FROM verification_uploads
      WHERE "submissionId" = ${doc.id}
      ORDER BY id
      FOR UPDATE
    `);
    if (claims.some((claim) => claim.userId !== doc.userId
      || claim.tenantId !== doc.tenantId
      || !['CONSUMED', 'QUARANTINED', 'PURGE_PENDING', 'PURGED'].includes(claim.state))) {
      throw new AppError(409, 'DOCUMENT_OBJECT_NOT_OWNED', 'A linked upload has invalid owner, tenant, or lifecycle authority.');
    }
    exactPurgeClaimSet(doc, claims);
    if (doc.storageProvenance === 'QUARANTINED') {
      const stillTrusted = await tx.documentRecord.findFirst({
        where: { submissionId: doc.id, status: 'VALID' },
        select: { id: true },
      });
      if (stillTrusted) {
        throw new AppError(409, 'DOCUMENT_QUARANTINE_INCOMPLETE', 'Quarantined storage cannot be purged until its trust record is retired.');
      }
    }

    let effectiveMode = doc.storagePurgeMode;
    let requestedAt = doc.storagePurgeRequestedAt;
    let effectiveRequestedBy = doc.storagePurgeRequestedBy;
    if (!requestedAt) {
      const marked = await tx.verificationDocument.updateMany({
        where: {
          id: doc.id,
          userId: doc.userId,
          legalHoldId: null,
          storagePurgeRequestedAt: null,
        },
        data: {
          storagePurgeRequestedAt: now,
          storagePurgeMode: input.mode,
          storagePurgeRequestedBy: input.requestedBy,
        },
      });
      if (marked.count !== 1) throw new AppError(409, 'PURGE_AUTHORITY_CHANGED', 'Document purge authority changed.');
      effectiveMode = input.mode;
      requestedAt = now;
      effectiveRequestedBy = input.requestedBy;
    } else if (!effectiveMode || !doc.storagePurgeRequestedBy) {
      throw new AppError(409, 'PURGE_AUTHORITY_INVALID', 'The stored purge authority is incomplete.');
    } else if (PURGE_MODE_STRENGTH[input.mode] > PURGE_MODE_STRENGTH[effectiveMode]) {
      const escalated = await tx.verificationDocument.updateMany({
        where: {
          id: doc.id,
          userId: doc.userId,
          legalHoldId: null,
          storagePurgeRequestedAt: requestedAt,
          storagePurgeMode: effectiveMode,
        },
        data: { storagePurgeMode: input.mode, storagePurgeRequestedBy: input.requestedBy },
      });
      if (escalated.count !== 1) throw new AppError(409, 'PURGE_AUTHORITY_CHANGED', 'Document purge mode changed.');
      effectiveMode = input.mode;
      effectiveRequestedBy = input.requestedBy;
    }
    if (effectiveMode === 'FULL_ERASURE'
      && (!doc.retentionExpiresAt || doc.retentionExpiresAt.getTime() > now.getTime())) {
      await tx.verificationDocument.update({
        where: { id: doc.id },
        data: { retentionExpiresAt: now },
      });
    }

    const pendingIds = claims.filter((claim) => ['CONSUMED', 'QUARANTINED'].includes(claim.state)).map((claim) => claim.id);
    if (pendingIds.length > 0) {
      const pending = await tx.verificationUpload.updateMany({
        where: { id: { in: pendingIds }, submissionId: doc.id, state: { in: ['CONSUMED', 'QUARANTINED'] } },
        data: { state: 'PURGE_PENDING', purgeRequestedAt: requestedAt },
      });
      if (pending.count !== pendingIds.length) {
        throw new AppError(409, 'PURGE_AUTHORITY_CHANGED', 'A document upload changed before purge authorization.');
      }
    }

    return {
      document: {
        id: doc.id,
        userId: doc.userId,
        tenantId: doc.tenantId,
        docType: doc.docType,
        mode: effectiveMode,
        requestedAt,
        requestedBy: effectiveRequestedBy!,
      },
      claims: claims.map((claim) => ({
        id: claim.id,
        purpose: claim.purpose,
        providerKey: claim.providerKey,
        canonicalKey: claim.canonicalKey,
        storageLocationId: claim.storageLocationId,
        objectVersion: claim.objectVersion,
        sha256: claim.sha256,
        sizeBytes: claim.sizeBytes,
        encrypted: claim.encrypted,
        state: claim.state === 'PURGED' ? 'PURGED' : 'PURGE_PENDING',
      })),
      alreadyFinalized: false,
    };
  });
}

/** Delete only the exact claim set authorized above; UNKNOWN is never absence. */
function exactObjectReceiptLocation(claim: VerificationPurgeClaim): string {
  const { storageLocationId, providerKey, objectVersion } = claim;
  return `object:v1:${storageLocationId.length}:${storageLocationId}:${providerKey.length}:${providerKey}:${objectVersion.length}:${objectVersion}`;
}

export async function deleteAuthorizedVerificationUploads(
  db: PrismaClient,
  log: Logger,
  authority: AuthorizedVerificationPurge,
  resolveStorage: (locationId: string) => StorageProvider | null = getStorageProviderForLocation,
): Promise<PurgeEvidence> {
  if (authority.alreadyFinalized || authority.claims.length === 0) {
    return { sha256: null, bytesDeleted: 0n, storeLocations: [], probe: 'CONFIRMED_ABSENT' };
  }
  const primary = authority.claims.find((claim) => claim.purpose !== 'IDENTITY_SELFIE');
  const storeLocations = authority.claims.flatMap((claim) => [
    exactObjectReceiptLocation(claim),
    ...(claim.encrypted ? [`envelope:${claim.providerKey}`] : []),
  ]);
  let allAbsent = true;
  const attempted: VerificationPurgeClaim[] = [];
  for (const claim of authority.claims) {
    if (claim.state === 'PURGED') continue;
    attempted.push(claim);
    const storage = resolveStorage(claim.storageLocationId);
    if (!storage) {
      allAbsent = false;
      continue;
    }
    if (claim.encrypted) {
      await db.encryptedObject.updateMany({
        where: { fileKey: claim.providerKey, wrappedDek: { not: null }, shreddedAt: null },
        data: { wrappedDek: null, shreddedAt: new Date() },
      });
    }
    await storage.deleteExact(claim.providerKey, claim.objectVersion).catch(() => undefined);
    const probe = await storage.probe(claim.providerKey, claim.objectVersion).catch(() => 'UNKNOWN' as const);
    if (probe !== 'ABSENT' && probe !== 'MISMATCH') allAbsent = false;
  }
  if (!allAbsent) {
    // Register every still-open claim, including one whose object was already
    // absent, so a later whole-document retry can close the exact set.
    await Promise.all(attempted.map((claim) => recordStorageOrphan(db, log, {
      key: claim.providerKey,
      reason: 'VERIFICATION_PURGE_INCOMPLETE',
      userId: authority.document.userId,
      tenantId: authority.document.tenantId,
      verificationUploadId: claim.id,
      storageLocationId: claim.storageLocationId,
    })));
  }
  const evidence: PurgeEvidence = {
    sha256: primary && /^[0-9a-f]{64}$/i.test(primary.sha256) ? Buffer.from(primary.sha256, 'hex') : null,
    bytesDeleted: allAbsent
      ? authority.claims.filter((claim) => claim.state !== 'PURGED').reduce((sum, claim) => sum + BigInt(claim.sizeBytes), 0n)
      : 0n,
    storeLocations,
    probe: allAbsent ? 'CONFIRMED_ABSENT' : 'FAILED',
  };
  // A failed deletion is still an audit event. Success is receipted atomically
  // with the document marker in finalizeVerificationPurge; failure has no
  // marker to co-commit, so persist the failed probe here before returning the
  // still-open PURGE_PENDING authority to its caller.
  if (!allAbsent) {
    await writeDeletionReceipt(db, {
      submissionId: authority.document.id,
      subjectId: authority.document.userId,
      tenantId: authority.document.tenantId,
      docTypeCode: authority.document.docType,
      deletedBy: authority.document.requestedBy,
      evidence,
    });
  }
  return evidence;
}

/**
 * Erasure can crypto-shred extracted values as soon as the durable FULL_ERASURE
 * authority exists, even when an object-store outage leaves byte deletion
 * pending. The legal-hold/user locks make that decision non-racy.
 */
export async function shredFieldsForAuthorizedErasure(
  db: PrismaClient,
  authority: AuthorizedVerificationPurge,
): Promise<boolean> {
  if (authority.document.mode !== 'FULL_ERASURE' || authority.alreadyFinalized) return false;
  return db.$transaction(async (tx) => {
    await bindTenantTransaction(tx);
    const users = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM users WHERE id = ${authority.document.userId}
      FOR UPDATE /* verification-document-purge-authority */
    `);
    if (!users[0]) return false;
    const doc = await tx.verificationDocument.findFirst({
      where: {
        id: authority.document.id,
        userId: authority.document.userId,
        legalHoldId: null,
        storagePurgeRequestedAt: authority.document.requestedAt,
        storagePurgeMode: 'FULL_ERASURE',
      },
      select: { id: true },
    });
    if (!doc) return false;
    await tx.extractionRun.updateMany({ where: { submissionId: doc.id }, data: { wrappedDek: null } });
    // The blind index remains linkable personal data while it is attached to
    // an account. Erasure therefore removes both the decryptable value and its
    // equality-search signal; nulling the wrapped DEK alone is insufficient.
    await tx.extractedField.updateMany({
      where: { submissionId: doc.id },
      data: { valueCt: null, valueBlind: null },
    });
    return true;
  });
}

/** Commit the document marker, every claim tombstone, receipt and projections together. */
export async function finalizeVerificationPurge(
  db: PrismaClient,
  authority: AuthorizedVerificationPurge,
  evidence: PurgeEvidence,
  input: {
    shredFields: boolean;
    now?: Date;
    afterDocument?: (tx: Prisma.TransactionClient, userId: string) => Promise<void>;
  },
): Promise<boolean> {
  if (authority.alreadyFinalized) return true;
  if (evidence.probe !== 'CONFIRMED_ABSENT') return false;
  const now = input.now ?? new Date();
  return db.$transaction(async (tx) => {
    await bindTenantTransaction(tx);
    const users = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM users WHERE id = ${authority.document.userId}
      FOR UPDATE /* verification-document-purge-authority */
    `);
    if (!users[0]) return false;
    const docs = await tx.$queryRaw<Array<{
      id: string;
      legalHoldId: string | null;
      storagePurgeRequestedAt: Date | null;
      storagePurgeMode: VerificationPurgeMode | null;
      imagePurgedAt: Date | null;
      purgedAt: Date | null;
    }>>(Prisma.sql`
      SELECT id, "legalHoldId", "storagePurgeRequestedAt", "storagePurgeMode", "imagePurgedAt", "purgedAt"
      FROM verification_documents
      WHERE id = ${authority.document.id} AND "userId" = ${authority.document.userId}
      FOR UPDATE
    `);
    const doc = docs[0];
    if (!doc || doc.legalHoldId
      || doc.storagePurgeRequestedAt?.getTime() !== authority.document.requestedAt.getTime()
      || doc.storagePurgeMode !== authority.document.mode) return false;
    if ((authority.document.mode === 'IMAGE_ONLY' && doc.imagePurgedAt)
      || (authority.document.mode !== 'IMAGE_ONLY' && doc.purgedAt)) return true;

    const claimIds = authority.claims.map((claim) => claim.id).sort();
    if (claimIds.length > 0) {
      const claims = await tx.$queryRaw<Array<{ id: string; state: string }>>(Prisma.sql`
        SELECT id::text, state
        FROM verification_uploads
        WHERE "submissionId" = ${doc.id}
        ORDER BY id
        FOR UPDATE
      `);
      if (claims.length !== claimIds.length
        || claims.some((claim, index) => claim.id !== claimIds[index]
          || !['PURGE_PENDING', 'PURGED'].includes(claim.state))) return false;
    }

    // Receipt first: both the document marker and claim tombstones are guarded
    // by this exact confirmed-absent set. A later failure rolls all of it back.
    await writeDeletionReceipt(tx, {
      submissionId: doc.id,
      subjectId: authority.document.userId,
      tenantId: authority.document.tenantId,
      docTypeCode: authority.document.docType,
      deletedBy: authority.document.requestedBy,
      evidence,
    });
    const documentUpdate = authority.document.mode === 'IMAGE_ONLY'
      ? { imagePurgedAt: now, fileUrl: '' }
      : { purgedAt: now, fileUrl: '' };
    const marked = await tx.verificationDocument.updateMany({
      where: {
        id: doc.id,
        userId: authority.document.userId,
        legalHoldId: null,
        storagePurgeRequestedAt: authority.document.requestedAt,
        storagePurgeMode: authority.document.mode,
        ...(authority.document.mode === 'IMAGE_ONLY' ? { imagePurgedAt: null } : { purgedAt: null }),
      },
      data: documentUpdate,
    });
    if (marked.count !== 1) return false;
    if (claimIds.length > 0) {
      await tx.verificationUpload.updateMany({
        where: { id: { in: claimIds }, submissionId: doc.id, state: 'PURGE_PENDING' },
        data: { state: 'PURGED', purgedAt: now },
      });
      await tx.storageOrphan.updateMany({
        where: { verificationUploadId: { in: claimIds }, purgedAt: null },
        data: { purgedAt: now, confirmedAbsentAt: now, lastAttemptAt: now, lastErrorCode: null },
      });
    }
    if (input.shredFields) {
      await tx.extractionRun.updateMany({ where: { submissionId: doc.id }, data: { wrappedDek: null } });
      await tx.extractedField.updateMany({
        where: { submissionId: doc.id },
        data: { valueCt: null, valueBlind: null },
      });
    }
    await input.afterDocument?.(tx, authority.document.userId);
    return true;
  });
}

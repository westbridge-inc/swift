import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';
import type {
  Prisma,
  PrismaClient,
  VerificationDocument,
  VerificationUploadPurpose,
} from '@prisma/client';
import { biometricFaceMatchEnabled } from '../../lib/biometric-guard';
import type {
  ChecklistRole,
  VerificationService,
} from '../../modules/verification/verification.service';
import {
  acquireVerificationUploads,
  consumeVerificationUploads,
  createVerificationUpload,
} from '../../modules/verification/verification-upload';
import { hopDocState } from '../../modules/verification/doc-state';
import { bindTenantTransaction } from '../../plugins/prisma';
import {
  getStorageProvider,
  type StorageProvider,
} from '../../providers/storage/storage-provider';

const PNG_PREFIX = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const QUIET_LOG = { error: () => undefined };

export type VerificationRoleKey = 'CUSTOMER' | ChecklistRole;

export interface SeedUploadOptions {
  userId: string;
  purpose: VerificationUploadPurpose;
  roleKey: VerificationRoleKey;
  docType?: string;
  /**
   * Kept in the provider key so deterministic test KYC adapters can select a
   * verdict without accepting a client-provided object reference.
   */
  marker?: string;
  bytes?: Buffer;
  mimeType?: string;
}

export interface SeededVerificationUpload {
  uploadId: string;
  providerKey: string;
  objectVersion: string;
}

export type VerificationDocumentFixtureOverrides = Partial<Pick<
  Prisma.VerificationDocumentUncheckedCreateInput,
  | 'kycRef'
  | 'expiresAt'
  | 'reviewedBy'
  | 'reviewNote'
  | 'reviewedAt'
  | 'insurerName'
  | 'policyNumber'
  | 'coverageClass'
  | 'hireClassConfirmed'
  | 'plateCrossChecked'
  | 'consentAt'
  | 'privacyNoticeVersion'
  | 'retentionExpiresAt'
  | 'legalHoldId'
  | 'subjectId'
  | 'createdAt'
>>;

export interface SeedVerifiedDocumentOptions {
  userId: string;
  roleKey: VerificationRoleKey;
  docType: string;
  marker?: string;
  overrides?: VerificationDocumentFixtureOverrides;
}

function projectedUserRole(roleKey: VerificationRoleKey): 'MOVER' | 'CUSTOMER' | 'VENDOR_OWNER' {
  if (roleKey === 'MOVER') return 'MOVER';
  if (roleKey === 'CUSTOMER' || roleKey === 'SERVICE_PROVIDER') return 'CUSTOMER';
  return 'VENDOR_OWNER';
}

function safeMarker(value: string): string {
  const marker = value.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 64);
  return marker || 'fixture';
}

/**
 * Preserve the production provider and location identity while choosing a
 * readable, collision-resistant key. This is test determinism, not an intake
 * bypass: createVerificationUpload still reserves, stores, seals and persists
 * the real one-use authority row.
 */
function labelledProvider(delegate: StorageProvider, marker: string): StorageProvider {
  return {
    locationId: () => delegate.locationId(),
    exactDeleteCapability: () => delegate.exactDeleteCapability(),
    reserveKey: (input) => {
      const reserved = delegate.reserveKey(input).url;
      const slash = reserved.lastIndexOf('/');
      const ext = path.extname(reserved.slice(slash + 1)) || '.bin';
      const name = `${safeMarker(marker)}-${nanoid(12)}${ext}`;
      return { url: `${reserved.slice(0, slash + 1)}${name}` };
    },
    upload: (input) => delegate.upload(input),
    getSignedUrl: (fileKey, ttlSeconds, objectVersion) => delegate.getSignedUrl(fileKey, ttlSeconds, objectVersion),
    delete: (fileKey) => delegate.delete(fileKey),
    deleteExact: (fileKey, objectVersion) => delegate.deleteExact(fileKey, objectVersion),
    getObject: (fileKey, objectVersion, options) => delegate.getObject(fileKey, objectVersion, options),
    probe: (fileKey, objectVersion) => delegate.probe(fileKey, objectVersion),
    identifyGeneration: (fileKey) => delegate.identifyGeneration(fileKey),
  };
}

export async function seedVerificationUpload(
  db: PrismaClient,
  options: SeedUploadOptions,
): Promise<SeededVerificationUpload> {
  const marker = safeMarker(options.marker ?? `${options.purpose}-${options.docType ?? 'selfie'}`);
  const mimeType = options.mimeType ?? (options.purpose === 'IDENTITY_SELFIE' ? 'image/png' : 'application/pdf');
  const bytes = options.bytes ?? (mimeType === 'image/png'
    ? Buffer.concat([PNG_PREFIX, Buffer.from(`swift-test-${marker}-${nanoid(12)}`)])
    : Buffer.from(`%PDF-1.4\nswift-test-${marker}-${nanoid(12)}\n%%EOF\n`));
  const receipt = await createVerificationUpload(
    db,
    labelledProvider(getStorageProvider(), marker),
    QUIET_LOG,
    {
      userId: options.userId,
      purpose: options.purpose,
      roleKey: options.roleKey,
      ...(options.docType ? { docType: options.docType } : {}),
      buffer: bytes,
      filename: `${marker}${mimeType === 'application/pdf' ? '.pdf' : '.png'}`,
      mimeType,
    },
  );
  const claim = await db.verificationUpload.findUniqueOrThrow({
    where: { id: receipt.uploadId },
    select: { providerKey: true, objectVersion: true },
  });
  if (!claim.objectVersion) throw new Error('test upload did not seal an object generation');
  return { uploadId: receipt.uploadId, providerKey: claim.providerKey, objectVersion: claim.objectVersion };
}

/**
 * Seed a database-level document fixture through the same immutable authority
 * lifecycle as production: reserve/write/seal an object, acquire its one-use
 * claim, create an unverified CAPTURED document, consume the claim, and only
 * then seal VERIFIED provenance. This helper intentionally stops before any
 * review decision so state-machine tests can exercise the real transitions.
 */
export async function seedProvenanceVerifiedDocument(
  db: PrismaClient,
  input: SeedVerifiedDocumentOptions,
): Promise<VerificationDocument> {
  const purpose: VerificationUploadPurpose = input.docType === 'identity_l2'
    ? 'IDENTITY_DOCUMENT'
    : 'CHECKLIST_DOCUMENT';
  const primary = await seedVerificationUpload(db, {
    userId: input.userId,
    purpose,
    roleKey: input.roleKey,
    docType: input.docType,
    marker: input.marker,
  });
  const authority = await acquireVerificationUploads(db, input.userId, [{
    uploadId: primary.uploadId,
    purpose,
    roleKey: input.roleKey,
    docType: input.docType,
  }]);
  const user = await db.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { tenantId: true },
  });

  return db.$transaction(async (tx) => {
    await bindTenantTransaction(tx);
    const created = await tx.verificationDocument.create({
      data: {
        consentAt: new Date(),
        privacyNoticeVersion: 'test-v1',
        ...input.overrides,
        tenantId: user.tenantId,
        userId: input.userId,
        role: projectedUserRole(input.roleKey),
        docType: input.docType,
        fileUrl: authority.claims[0]!.providerKey,
        status: 'PENDING',
        state: 'CAPTURED',
        storageProvenance: 'UNVERIFIED',
        verificationRoleKey: input.roleKey,
      },
    });
    await consumeVerificationUploads(tx, {
      userId: input.userId,
      processingId: authority.processingId,
      uploadIds: authority.claims.map((claim) => claim.id),
      submissionId: created.id,
    });
    return tx.verificationDocument.update({
      where: { id: created.id },
      data: { storageProvenance: 'VERIFIED' },
    });
  });
}

/**
 * Seed trusted evidence for a test that is not itself about review authority.
 * It builds on the production upload/consume lifecycle above and then walks the
 * real human-review state path with a durable case and APPROVE decision. It
 * does not disable a trigger, fabricate VERIFIED on insert, or create a born-
 * approved row.
 */
export async function seedTrustedVerificationDocument(
  db: PrismaClient,
  input: SeedVerifiedDocumentOptions,
): Promise<VerificationDocument> {
  const pending = await seedProvenanceVerifiedDocument(db, input);
  return db.$transaction(async (tx) => {
    await bindTenantTransaction(tx);
    const hop = async (from: Parameters<typeof hopDocState>[2], to: Parameters<typeof hopDocState>[3], extra: Prisma.VerificationDocumentUpdateManyMutationInput = {}) => {
      if (!await hopDocState(tx, { id: pending.id, userId: input.userId }, from, to, extra)) {
        throw new Error(`trusted document fixture could not transition ${String(from)} -> ${to}`);
      }
    };
    await hop('CAPTURED', 'PREPROCESSED');
    await hop('PREPROCESSED', 'EXTRACTING');
    await hop('EXTRACTING', 'REVIEW_QUEUED');

    const reviewedAt = input.overrides?.reviewedAt instanceof Date
      ? input.overrides.reviewedAt
      : new Date();
    const reviewerId = typeof input.overrides?.reviewedBy === 'string'
      ? input.overrides.reviewedBy
      : `test-reviewer-${nanoid(12)}`;
    const reviewCase = await tx.reviewCase.create({
      data: {
        tenantId: pending.tenantId,
        submissionId: pending.id,
        queue: 'STANDARD',
        slaDueAt: new Date(reviewedAt.getTime() + 24 * 60 * 60 * 1000),
        assignedTo: reviewerId,
        assignedAt: reviewedAt,
        assignmentEpoch: randomUUID(),
      },
    });
    await hop('REVIEW_QUEUED', 'IN_REVIEW');
    await hop('IN_REVIEW', 'APPROVED', {
      reviewedBy: reviewerId,
      reviewedAt,
    });
    await tx.reviewDecision.create({
      data: {
        tenantId: pending.tenantId,
        caseId: reviewCase.id,
        reviewerId,
        outcome: 'APPROVE',
        reasonCode: 'APPROVED',
        actorFacingCategory: 'APPROVED',
        timeOnCaseMs: 0,
      },
    });
    await hop('APPROVED', 'COMMITTED');
    await tx.reviewCase.update({ where: { id: reviewCase.id }, data: { closedAt: reviewedAt } });
    return tx.verificationDocument.findUniqueOrThrow({ where: { id: pending.id } });
  });
}

export async function submitDocumentWithUpload(
  db: PrismaClient,
  service: VerificationService,
  input: {
    userId: string;
    roleKey: ChecklistRole;
    docType: string;
    privacyNoticeVersion?: string;
    marker?: string;
  },
) {
  const primary = await seedVerificationUpload(db, {
    userId: input.userId,
    purpose: 'CHECKLIST_DOCUMENT',
    roleKey: input.roleKey,
    docType: input.docType,
    marker: input.marker,
  });
  const needsSelfie = biometricFaceMatchEnabled()
    && (input.docType === 'national_id' || input.docType === 'owner_national_id');
  const selfie = needsSelfie
    ? await seedVerificationUpload(db, {
      userId: input.userId,
      purpose: 'IDENTITY_SELFIE',
      roleKey: input.roleKey,
      marker: `${input.marker ?? input.docType}-selfie`,
    })
    : null;
  const document = await service.submitDocument(
    input.userId,
    input.roleKey,
    input.docType,
    primary.uploadId,
    input.privacyNoticeVersion ?? 'test-v1',
    selfie?.uploadId,
  );
  return { document, primary, selfie };
}

export async function submitIdentityWithUploads(
  db: PrismaClient,
  service: VerificationService,
  input: {
    userId: string;
    privacyNoticeVersion?: string;
    marker?: string;
  },
) {
  const marker = input.marker ?? 'identity';
  const id = await seedVerificationUpload(db, {
    userId: input.userId,
    purpose: 'IDENTITY_DOCUMENT',
    roleKey: 'CUSTOMER',
    docType: 'identity_l2',
    marker,
  });
  const selfie = await seedVerificationUpload(db, {
    userId: input.userId,
    purpose: 'IDENTITY_SELFIE',
    roleKey: 'CUSTOMER',
    marker: `${marker}-selfie`,
  });
  const document = await service.submitIdentity(
    input.userId,
    id.uploadId,
    selfie.uploadId,
    input.privacyNoticeVersion ?? 'test-v1',
  );
  return { document, id, selfie };
}

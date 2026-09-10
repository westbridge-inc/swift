import type { PrismaClient } from '@prisma/client';
import {
  getStorageProviderForLocation,
  type StorageProbeResult,
} from '../providers/storage/storage-provider';
import { managedObjectKeyIsNamespacedTo } from '../utils/owned-storage-key';
import { bindTenantTransaction } from '../plugins/prisma';

/** Durable scheduling for storage deletion obligations. */

type StorageLike = {
  delete: (key: string) => Promise<unknown>;
  probe: (key: string) => Promise<StorageProbeResult>;
  locationId: () => string;
};
type Logger = { error: (obj: Record<string, unknown>, msg: string) => void };

function objectIdentity(storageLocationId: string | undefined, key: string, objectVersion?: string): string {
  return storageLocationId && objectVersion
    ? `v1:${storageLocationId.length}:${storageLocationId}:${key.length}:${key}:${objectVersion.length}:${objectVersion}`
    : storageLocationId
      ? `${storageLocationId.length}:${storageLocationId}${key}`
    : `legacy:${key}`;
}

function legacyOrphanHasDeleteAuthority(row: { key: string; reason: string; userId: string | null }): boolean {
  if (!row.userId || row.reason === 'ERASURE_PURGE_PROBE_FAILED') return false;
  return ['SELFIE_UNWIND_DELETE_FAILED', 'REPLACED_SELFIE_DELETE_FAILED', 'ACCOUNT_DELETION_DELETE_FAILED'].includes(row.reason)
    && managedObjectKeyIsNamespacedTo(row.key, 'avatars', row.userId);
}

function retryDelay(attempts: number): Date {
  const delayMs = Math.min(24 * 60 * 60 * 1000, 30_000 * (2 ** Math.min(attempts, 11)));
  return new Date(Date.now() + delayMs);
}

function codedError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'DELETE_FAILED';
  const value = error as { code?: unknown; name?: unknown };
  const code = typeof value.code === 'string' ? value.code : typeof value.name === 'string' ? value.name : null;
  return code && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : 'DELETE_FAILED';
}

export async function recordStorageOrphan(
  db: PrismaClient,
  log: Logger,
  input: {
    key: string;
    reason: string;
    userId?: string;
    tenantId?: string;
    verificationUploadId?: string;
    storageLocationId?: string;
  },
): Promise<void> {
  try {
    if (input.verificationUploadId) {
      const upload = await db.verificationUpload.findUnique({
        where: { id: input.verificationUploadId },
        select: {
          id: true,
          tenantId: true,
          userId: true,
          storageLocationId: true,
          providerKey: true,
          objectVersion: true,
          state: true,
        },
      });
      if (!upload
        || upload.state !== 'PURGE_PENDING'
        || !upload.objectVersion
        || upload.providerKey !== input.key
        || (input.userId !== undefined && upload.userId !== input.userId)
        || (input.tenantId !== undefined && upload.tenantId !== input.tenantId)
        || (input.storageLocationId !== undefined && upload.storageLocationId !== input.storageLocationId)
      ) {
        log.error({ uploadId: input.verificationUploadId, reason: input.reason }, 'storage-orphan authority did not match its upload claim');
        return;
      }
      await db.storageOrphan.upsert({
        where: { verificationUploadId: upload.id },
        create: {
          key: upload.providerKey,
          objectIdentity: objectIdentity(upload.storageLocationId, upload.providerKey, upload.objectVersion),
          storageLocationId: upload.storageLocationId,
          reason: input.reason,
          userId: upload.userId,
          tenantId: upload.tenantId,
          verificationUploadId: upload.id,
        },
        update: {
          reason: input.reason,
          purgedAt: null,
          confirmedAbsentAt: null,
          nextAttemptAt: new Date(),
          lastErrorCode: null,
        },
      });
      return;
    }

    // Kept only for pre-registry avatar paths. Verification-document callers
    // must provide verificationUploadId and cannot fall back here.
    const identity = objectIdentity(input.storageLocationId, input.key);
    await db.storageOrphan.upsert({
      where: { objectIdentity: identity },
      create: {
        key: input.key,
        objectIdentity: identity,
        storageLocationId: input.storageLocationId,
        reason: input.reason,
        userId: input.userId,
        tenantId: input.tenantId ?? 'swift-default',
      },
      update: {
        reason: input.reason,
        userId: input.userId,
        purgedAt: null,
        confirmedAbsentAt: null,
        nextAttemptAt: new Date(),
        lastErrorCode: null,
      },
    });
  } catch (error) {
    // Never mask the original deletion failure. Do not log object contents or
    // provider responses; the coded row identity is enough to investigate.
    log.error({ code: codedError(error), reason: input.reason }, 'storage-orphan census write failed');
  }
}

/** Retry due rows without letting one poisoned/failed row starve later work. */
export async function retryStorageOrphans(
  db: PrismaClient,
  storage: StorageLike,
  log: Logger,
  limit = 5,
): Promise<number> {
  const now = new Date();
  const abandonedProcessingBefore = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  // Claims themselves are the authoritative census. Recover reservations
  // whose uploader/processor died even if no catch block got to create an
  // orphan row, then materialize any missing scheduler rows below.
  const unsealed = await db.verificationUpload.findMany({
    where: {
      submissionId: null,
      state: 'UPLOADING',
      expiresAt: { lte: now },
    },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, providerKey: true, storageLocationId: true },
  });
  for (const upload of unsealed) {
    const provider = getStorageProviderForLocation(upload.storageLocationId);
    if (!provider) continue;
    const identified = await provider.identifyGeneration(upload.providerKey).catch(() => ({ status: 'UNKNOWN' as const }));
    if (identified.status === 'UNKNOWN') continue;
    if (identified.status === 'ABSENT') {
      await db.verificationUpload.updateMany({
        where: { id: upload.id, state: 'UPLOADING', objectVersion: null },
        data: {
          state: 'QUARANTINED',
          quarantineReason: 'INCOMPLETE_WRITE_CONFIRMED_ABSENT',
          quarantinedAt: now,
        },
      });
      continue;
    }
    if (identified.status !== 'PRESENT') continue;
    // The key was reserved durably before upload and every Swift provider is
    // write-once for that key. Recover the acknowledged generation, then make
    // it a deletion obligation in one DB transaction. A crash at either line
    // is retriable: UPLOADING can be identified again; UPLOADED is swept below.
    await db.$transaction(async (tx) => {
      await bindTenantTransaction(tx);
      const sealed = await tx.verificationUpload.updateMany({
        where: { id: upload.id, state: 'UPLOADING', objectVersion: null },
        data: { state: 'UPLOADED', objectVersion: identified.objectVersion },
      });
      if (sealed.count !== 1) return;
      const pending = await tx.verificationUpload.updateMany({
        where: { id: upload.id, state: 'UPLOADED', objectVersion: identified.objectVersion, submissionId: null },
        data: { state: 'PURGE_PENDING', purgeRequestedAt: now },
      });
      if (pending.count !== 1) throw new Error('Recovered verification upload changed before purge scheduling');
    });
  }
  await db.verificationUpload.updateMany({
    where: {
      submissionId: null,
      OR: [
        { state: 'UPLOADED', expiresAt: { lte: now } },
        { state: 'PROCESSING', processingStartedAt: { lte: abandonedProcessingBefore } },
      ],
    },
    data: { state: 'PURGE_PENDING', purgeRequestedAt: now },
  });
  const unscheduled = await db.verificationUpload.findMany({
    where: { state: 'PURGE_PENDING', storageOrphan: null },
    orderBy: [{ purgeRequestedAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, providerKey: true, userId: true, tenantId: true, storageLocationId: true, objectVersion: true },
  });
  for (const upload of unscheduled) {
    await recordStorageOrphan(db, log, {
      key: upload.providerKey,
      reason: 'VERIFICATION_PURGE_RECONCILE',
      userId: upload.userId,
      tenantId: upload.tenantId,
      verificationUploadId: upload.id,
      storageLocationId: upload.storageLocationId,
    });
  }

  const rows = await db.storageOrphan.findMany({
    where: { purgedAt: null, quarantinedAt: null, nextAttemptAt: { lte: now } },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
    take: limit,
    include: {
      verificationUpload: {
        select: {
          id: true,
          tenantId: true,
          userId: true,
          storageLocationId: true,
          providerKey: true,
          objectVersion: true,
          state: true,
          submissionId: true,
        },
      },
    },
  });
  let purged = 0;
  for (const row of rows) {
    const upload = row.verificationUpload;
    const document = upload?.submissionId
      ? await db.verificationDocument.findUnique({
        where: { id: upload.submissionId },
        select: {
          id: true,
          legalHoldId: true,
          storagePurgeRequestedAt: true,
          storageProvenance: true,
        },
      })
      : null;
    const linkedAuthority = !!upload
      && row.verificationUploadId === upload.id
      && row.tenantId === upload.tenantId
      && row.userId === upload.userId
      && row.storageLocationId === upload.storageLocationId
      && row.key === upload.providerKey
      && !!upload.objectVersion
      && row.objectIdentity === objectIdentity(upload.storageLocationId, upload.providerKey, upload.objectVersion)
      && upload.state === 'PURGE_PENDING'
      && (!upload.submissionId || (
        document?.id === upload.submissionId
        && document.legalHoldId === null
        && document.storagePurgeRequestedAt !== null
        && ['VERIFIED', 'QUARANTINED'].includes(document.storageProvenance)
      ));
    const legacyAuthority = !row.verificationUploadId
      && legacyOrphanHasDeleteAuthority(row)
      && (row.storageLocationId === null || row.storageLocationId === storage.locationId());
    if (!linkedAuthority && !legacyAuthority) {
      await db.storageOrphan.update({
        where: { id: row.id },
        data: {
          quarantinedAt: new Date(),
          quarantineReason: 'DELETE_AUTHORITY_UNPROVEN',
          lastErrorCode: 'AUTHORITY_INVALID',
        },
      });
      log.error({ orphanId: row.id, reason: row.reason }, 'storage-orphan authority unproved; row quarantined');
      continue;
    }

    const exactStorage = linkedAuthority && upload
      ? getStorageProviderForLocation(upload.storageLocationId)
      : null;
    if (linkedAuthority && !exactStorage) {
      const attempts = row.attempts + 1;
      await db.storageOrphan.update({
        where: { id: row.id },
        data: {
          attempts,
          lastAttemptAt: new Date(),
          nextAttemptAt: retryDelay(attempts),
          lastErrorCode: 'LOCATION_UNAVAILABLE',
        },
      });
      log.error({ orphanId: row.id }, 'storage-orphan location is unavailable; retry remains open');
      continue;
    }

    let deleteError: unknown = null;
    try {
      if (linkedAuthority && upload?.objectVersion) {
        await exactStorage!.deleteExact(row.key, upload.objectVersion);
      } else {
        await storage.delete(row.key);
      }
    } catch (error) {
      deleteError = error;
    }
    const probe = linkedAuthority && upload?.objectVersion
      ? await exactStorage!.probe(row.key, upload.objectVersion).catch(() => 'UNKNOWN' as const)
      : await storage.probe(row.key).catch(() => 'UNKNOWN' as const);
    if (probe === 'ABSENT' || (linkedAuthority && probe === 'MISMATCH')) {
      const now = new Date();
      await db.$transaction(async (tx) => {
        await bindTenantTransaction(tx);
        if (upload && !upload.submissionId) {
          await tx.storageOrphan.update({
            where: { id: row.id },
            data: {
              confirmedAbsentAt: now,
              lastAttemptAt: now,
              attempts: { increment: 1 },
              lastErrorCode: null,
            },
          });
          const closedClaim = await tx.verificationUpload.updateMany({
            where: { id: upload.id, state: 'PURGE_PENDING' },
            data: { state: 'PURGED', purgedAt: now },
          });
          if (closedClaim.count !== 1) throw new Error('Verification upload purge authority changed');
        }
        await tx.storageOrphan.update({
          where: { id: row.id },
          data: {
            purgedAt: now,
            confirmedAbsentAt: now,
            lastAttemptAt: now,
            ...(!upload || upload.submissionId ? { attempts: { increment: 1 } } : {}),
            lastErrorCode: null,
          },
        });
      });
      purged += 1;
      continue;
    }

    const attempts = row.attempts + 1;
    await db.storageOrphan.update({
      where: { id: row.id },
      data: {
        attempts,
        lastAttemptAt: new Date(),
        nextAttemptAt: retryDelay(attempts),
        lastErrorCode: deleteError ? codedError(deleteError) : probe === 'PRESENT' ? 'OBJECT_PRESENT' : 'PROBE_UNKNOWN',
      },
    });
    log.error({ orphanId: row.id, probe }, 'storage-orphan retry remains open');
  }
  return purged;
}

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { StorageProvider } from '../../providers/storage/storage-provider';
import { isSealedPhotoKey, photoSealingAvailable, sealPhoto, SHREDDED_FINGERPRINT } from '../../providers/storage/sealed-photo';
import { deleteStorageObjectAndConfirmAbsent, queueStorageOrphan, retryStorageOrphan } from '../../lib/storage-orphans';
import { isOwnedAvatarKey } from '../verification/object-authority';
import { canonicalSubjectKey } from './upload-erasure';
import { runAsSystem } from '../../plugins/tenant-context';

/**
 * [DOC-SECURITY G2] SEAL THE SELFIES STORED BEFORE SEALING SHIPPED.
 *
 * New profile photos and shift selfies are sealed at upload (providers/storage/sealed-photo.ts).
 * One stored earlier is still a plain image in the bucket; it keeps working (resolveAvatarUrl
 * presigns it as before) until this pass seals it. For each one, under the person's row lock:
 * the stored bytes are read, sealed into a NEW object with its envelope, the pointer moves with a
 * compare-and-set, and the plain object is deleted (a profile photo through the replaced-selfie
 * orphan path, a shift selfie with a confirmed absence). Only the server-issued shapes in the
 * person's own folder are touched; a person under a legal hold is left exactly as they are.
 * Idempotent: a sealed key is never a candidate. Dry run by default (counts only).
 */

type Log = { warn: (obj: Record<string, unknown>, msg: string) => void; error: (obj: Record<string, unknown>, msg: string) => void };
const SILENT: Log = { warn: () => undefined, error: () => undefined };
type Storage = Pick<StorageProvider, 'upload' | 'delete' | 'getObject'>;

export interface SealExistingResult {
  avatars: { candidates: number; sealed: number; held: number; skipped: number };
  /** `oldCopyNotConfirmedGone`: sealed and moved, but the plain object's deletion is not confirmed (logged by key digest). */
  liveness: { candidates: number; sealed: number; held: number; skipped: number; oldCopyNotConfirmedGone: number };
}

const DECLARED_TYPE_BY_EXT: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const declaredTypeOf = (key: string) => DECLARED_TYPE_BY_EXT[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/jpeg';

async function underLegalHold(db: Pick<PrismaClient, 'docLegalHold'>, userId: string): Promise<boolean> {
  return await db.docLegalHold.count({ where: { subjectUserId: userId, releasedAt: null } }) > 0;
}

export async function sealExistingPhotos(
  db: PrismaClient,
  storage: Storage,
  opts: { dryRun?: boolean; limit?: number; log?: Log } = {},
): Promise<SealExistingResult> {
  const dryRun = opts.dryRun !== false;
  const limit = opts.limit ?? 500;
  if (!dryRun && !photoSealingAvailable()) throw new Error('MASTER_KEK is not configured: nothing can be sealed');
  const result: SealExistingResult = {
    avatars: { candidates: 0, sealed: 0, held: 0, skipped: 0 },
    liveness: { candidates: 0, sealed: 0, held: 0, skipped: 0, oldCopyNotConfirmedGone: 0 },
  };
  const log = opts.log ?? SILENT;
  return runAsSystem('documents:seal-existing-photos', async () => {
    // ── Profile photos ────────────────────────────────────────────────────
    const people = await db.user.findMany({
      where: { avatar: { not: null }, NOT: { avatar: { endsWith: '.enc' } } },
      select: { id: true, avatar: true, tenantId: true }, orderBy: { id: 'asc' }, take: limit,
    });
    for (const person of people) {
      const oldKey = person.avatar!;
      if (isSealedPhotoKey(oldKey) || !isOwnedAvatarKey(oldKey, person.id)) continue; // a seed URL or a drawn portrait: not a stored selfie
      result.avatars.candidates += 1;
      if (dryRun) continue;
      if (await underLegalHold(db, person.id)) { result.avatars.held += 1; continue; }
      let bytes: Buffer;
      try { bytes = await storage.getObject(oldKey); } catch { result.avatars.skipped += 1; continue; }
      let newKey: string;
      try {
        newKey = await sealPhoto(db, storage, { buffer: bytes, declaredMimeType: declaredTypeOf(oldKey), ownerId: person.id, folder: 'avatars' });
      } catch (err) {
        log.error({ err, userId: person.id }, 'seal-existing: profile photo could not be sealed; left as it is');
        result.avatars.skipped += 1;
        continue;
      }
      const moved = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${person.id} FOR UPDATE /* signup-selfie-pointer-authority */`;
        const swapped = await tx.user.updateMany({ where: { id: person.id, avatar: oldKey }, data: { avatar: newKey } });
        // The retired key (the plain one when it moved, else the unused sealed copy) is a replaced selfie to delete.
        const retired = swapped.count === 1 ? oldKey : newKey;
        const orphan = await queueStorageOrphan(tx, { key: retired, reason: 'REPLACED_SELFIE_DELETE_PENDING', userId: person.id, tenantId: person.tenantId });
        return { moved: swapped.count === 1, orphanId: orphan.id };
      });
      await retryStorageOrphan(db, storage, log, moved.orphanId);
      if (moved.moved) result.avatars.sealed += 1; else result.avatars.skipped += 1;
    }

    // ── Shift liveness selfies ────────────────────────────────────────────
    const checks = await db.livenessCheck.findMany({
      where: { NOT: { selfieUrl: { endsWith: '.enc' } } },
      select: { userId: true, selfieUrl: true }, distinct: ['selfieUrl'], orderBy: { selfieUrl: 'asc' }, take: limit,
    });
    for (const check of checks) {
      const oldKey = check.selfieUrl;
      if (isSealedPhotoKey(oldKey) || !canonicalSubjectKey(oldKey, check.userId, 'liveness')) continue;
      result.liveness.candidates += 1;
      if (dryRun) continue;
      if (await underLegalHold(db, check.userId)) { result.liveness.held += 1; continue; }
      let bytes: Buffer;
      try { bytes = await storage.getObject(oldKey); } catch { result.liveness.skipped += 1; continue; }
      let newKey: string;
      try {
        newKey = await sealPhoto(db, storage, { buffer: bytes, declaredMimeType: declaredTypeOf(oldKey), ownerId: check.userId, folder: 'liveness' });
      } catch (err) {
        log.error({ err, userId: check.userId }, 'seal-existing: shift selfie could not be sealed; left as it is');
        result.liveness.skipped += 1;
        continue;
      }
      const moved = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${check.userId} FOR UPDATE /* upload-erasure-authority */`;
        if (await underLegalHold(tx, check.userId)) return 0;
        return (await tx.livenessCheck.updateMany({ where: { userId: check.userId, selfieUrl: oldKey }, data: { selfieUrl: newKey } })).count;
      });
      if (moved === 0) {
        // Nothing moved (a hold arrived, or the rows went): the sealed copy is the unused one.
        await db.encryptedObject.updateMany({ where: { fileKey: newKey, createdBy: check.userId }, data: { wrappedDek: null, shreddedAt: new Date(), sha256: SHREDDED_FINGERPRINT } });
        await storage.delete(newKey).catch(() => undefined);
        result.liveness.skipped += 1;
        continue;
      }
      if (!await deleteStorageObjectAndConfirmAbsent(storage, oldKey)) {
        result.liveness.oldCopyNotConfirmedGone += 1;
        log.warn({ userId: check.userId, keyDigest: createHash('sha256').update(oldKey).digest('hex').slice(0, 16) },
          'seal-existing: the shift selfie is sealed, but its plain copy is not confirmed gone; delete it by hand');
      }
      result.liveness.sealed += 1;
    }
    return result;
  });
}

import crypto, { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { cleanStoredPhoto } from '../../utils/images';
import { AppError } from '../../utils/errors';
import { storageSigningKeys } from '../../utils/signing-keys';
import { decryptBuffer, encryptBuffer, generateDek, getKeyProvider } from './envelope';
import type { StorageProvider } from './storage-provider';

/**
 * [DOC-SECURITY G2] A PHOTO OF A PERSON'S FACE IS SEALED AT REST, LIKE A VERIFICATION DOCUMENT.
 *
 * The signup selfie (the profile photo, `users.avatar`) and the shift liveness selfie
 * (`LivenessCheck.selfieUrl`) were stored as plain images in the bucket, while the processor
 * register and the Privacy Policy say the store holds encrypted images. Each one now gets the
 * documents' envelope (envelope.ts): a fresh 256-bit DEK per photo, AES-256-GCM, the DEK wrapped
 * by MASTER_KEK in `encrypted_objects`. The bucket only ever holds ciphertext, and shredding the
 * wrapped DEK makes every copy of it (a bucket version, a backup) unreadable; the restore replay
 * re-shreds it from the ledger like any other envelope.
 *
 * The photo is cleaned first (camera metadata removed, failing closed, then read by the real
 * decoder): the storage seam only ever sees ciphertext, so it cannot clean it later.
 *
 * Reading: a profile photo is shown to the people the app shows it to, through a short-lived
 * signed link minted by the API read that already decided this (resolveAvatarUrl), exactly where
 * a presigned bucket link was minted before. The link opens GET /api/v1/auth/selfie/:userId/:file,
 * which decrypts in memory, and only while the account still points at that photo. A liveness
 * selfie has no reader.
 *
 * These envelopes are not verification uploads: the unclaimed-upload sweep, the duplicate-document
 * signal and the abandoned-application clock leave them out (SEALED_PHOTO_KEY_WHERE); the avatar
 * and liveness erasure passes own them.
 */

export const SEALED_PHOTO_FOLDERS = ['avatars', 'liveness'] as const;
export type SealedPhotoFolder = (typeof SEALED_PHOTO_FOLDERS)[number];

/** The server-issued name of a sealed photo (createOpaqueStorageName over `photo.enc`). */
const SEALED_FILE = /^[A-Za-z0-9_-]{16}\.enc$/;
const OWNER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SEALED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** What a shredded envelope's fingerprint reads as (the same word as user/upload-erasure ERASED_FINGERPRINT). */
export const SHREDDED_FINGERPRINT = 'erased';

/** How long a signed profile-photo link lives: the presigned bucket link it replaces lived one hour. */
export const SEALED_AVATAR_TTL_SECONDS = 3600;

export interface SealedPhotoParts { folder: SealedPhotoFolder; ownerId: string; file: string }

/** The parts of a sealed photo key — `<folder>/<owner>/<name>.enc` (object store) or the same under
 *  `/uploads/` (local disk) — or null for anything else (a plain photo, a document, a foreign shape). */
export function sealedPhotoParts(key: string | null | undefined): SealedPhotoParts | null {
  if (!key) return null;
  const relative = key.startsWith('/uploads/') ? key.slice('/uploads/'.length) : key;
  if (relative.startsWith('/')) return null;
  const parts = relative.split('/');
  if (parts.length !== 3) return null;
  const [folder, ownerId, file] = parts as [string, string, string];
  if (!(SEALED_PHOTO_FOLDERS as readonly string[]).includes(folder) || !OWNER_ID.test(ownerId) || !SEALED_FILE.test(file)) return null;
  return { folder: folder as SealedPhotoFolder, ownerId, file };
}

export const isSealedPhotoKey = (key: string | null | undefined): boolean => sealedPhotoParts(key) !== null;

/** An envelope row that is a sealed photo, never a verification upload (the object key says which). */
export const SEALED_PHOTO_KEY_WHERE: Prisma.EncryptedObjectWhereInput = {
  OR: SEALED_PHOTO_FOLDERS.flatMap((folder) => [
    { fileKey: { startsWith: `${folder}/` } },
    { fileKey: { startsWith: `/uploads/${folder}/` } },
  ]),
};

/** Sealing is the rule wherever a key is configured; production never boots without one (boot-config). */
export function photoSealingAvailable(): boolean {
  return getKeyProvider() !== null;
}

/**
 * Clean, encrypt and store one photo of `ownerId` under `<folder>/<ownerId>/`, with its envelope row.
 * Returns the stored key. An envelope row that cannot be written takes its object with it.
 */
export async function sealPhoto(
  db: Pick<PrismaClient, 'encryptedObject'>,
  storage: Pick<StorageProvider, 'upload' | 'delete'>,
  input: { buffer: Buffer; declaredMimeType: string; ownerId: string; folder: SealedPhotoFolder },
): Promise<string> {
  const keys = getKeyProvider();
  if (!keys) throw new AppError(503, 'PHOTO_SEALING_UNAVAILABLE', 'Photo upload is temporarily unavailable. Try again later.');
  if (!OWNER_ID.test(input.ownerId)) throw new AppError(400, 'BAD_IMAGE', 'File content does not match an image format');
  const photo = await cleanStoredPhoto(input.buffer, input.declaredMimeType);
  if (!photo) throw new AppError(400, 'BAD_IMAGE', 'File content does not match an image format');
  // The fingerprint of the photo AS SUBMITTED, as for a document (one-way: nothing of the removed metadata).
  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  const dek = generateDek();
  const { ciphertext, iv, authTag } = encryptBuffer(photo.buffer, dek);
  const wrappedDek = await keys.wrapDek(dek);
  const { url } = await storage.upload({
    buffer: ciphertext, filename: 'photo.enc', mimeType: 'application/octet-stream', folder: `${input.folder}/${input.ownerId}`,
  });
  try {
    await db.encryptedObject.create({ data: {
      fileKey: url, iv: new Uint8Array(iv), authTag: new Uint8Array(authTag), wrappedDek: new Uint8Array(wrappedDek),
      mimeType: photo.mimeType, sizeBytes: photo.buffer.length, sha256, createdBy: input.ownerId,
    } });
  } catch (err) {
    await storage.delete(url).catch(() => undefined);
    throw err;
  }
  return url;
}

function sealedPhotoUnavailable(): AppError {
  return new AppError(404, 'PHOTO_UNAVAILABLE', 'This photo is not available.');
}

/** Decrypt one sealed photo of `ownerId`, in memory. Anything unproven (a foreign or malformed key, a
 *  missing, shredded or foreign envelope, no key configured, a failed decrypt) is one refusal. */
export async function openSealedPhoto(
  db: Pick<PrismaClient, 'encryptedObject'>,
  storage: Pick<StorageProvider, 'getObject'>,
  ref: { fileKey: string; ownerId: string },
): Promise<{ bytes: Buffer; mimeType: string }> {
  const parts = sealedPhotoParts(ref.fileKey);
  const keys = getKeyProvider();
  if (!parts || parts.ownerId !== ref.ownerId || !keys) throw sealedPhotoUnavailable();
  try {
    const meta = await db.encryptedObject.findUnique({ where: { fileKey: ref.fileKey } });
    if (!meta || meta.fileKey !== ref.fileKey || meta.createdBy !== ref.ownerId || meta.shreddedAt !== null || !meta.wrappedDek?.length
      || meta.iv.length !== 12 || meta.authTag.length !== 16 || !SEALED_TYPES.has(meta.mimeType)) throw new Error('unproven envelope');
    const ciphertext = await storage.getObject(ref.fileKey);
    const dek = await keys.unwrapDek(Buffer.from(meta.wrappedDek));
    return { bytes: decryptBuffer(ciphertext, dek, Buffer.from(meta.iv), Buffer.from(meta.authTag)), mimeType: meta.mimeType };
  } catch {
    throw sealedPhotoUnavailable();
  }
}

/** Crypto-shred a sealed photo's key (first: the ciphertext is then unreadable from any copy). No-op for a plain photo. */
export async function shredSealedPhotoKey(tx: Pick<Prisma.TransactionClient, 'encryptedObject'>, fileKey: string, ownerId: string): Promise<void> {
  if (!isSealedPhotoKey(fileKey)) return;
  await tx.encryptedObject.updateMany({ where: { fileKey, createdBy: ownerId, shreddedAt: null }, data: { wrappedDek: null } });
}

/** After the bytes are confirmed gone: the envelope is closed and forgets its fingerprint. */
export async function closeSealedPhotoEnvelope(tx: Pick<Prisma.TransactionClient, 'encryptedObject'>, fileKey: string, ownerId: string): Promise<void> {
  if (!isSealedPhotoKey(fileKey)) return;
  await tx.encryptedObject.updateMany({
    where: { fileKey, createdBy: ownerId, shreddedAt: null },
    data: { wrappedDek: null, shreddedAt: new Date(), sha256: SHREDDED_FINGERPRINT },
  });
}

// ── The signed profile-photo link ────────────────────────────────────────────

function avatarLinkSignature(secret: string, ownerId: string, file: string, expires: number): string {
  return crypto.createHmac('sha256', secret).update(`sealed-avatar:${ownerId}:${file}:${expires}`).digest('hex').slice(0, 32);
}

/** The signed link a client loads a sealed profile photo through; null for any other key. Absolute when
 *  API_PUBLIC_URL is set (every deployed server), so a phone that renders the value as given still can. */
export function sealedAvatarUrl(key: string, now = Date.now(), env: Record<string, string | undefined> = process.env): string | null {
  const parts = sealedPhotoParts(key);
  if (!parts || parts.folder !== 'avatars') return null;
  const expires = Math.floor(now / 1000) + SEALED_AVATAR_TTL_SECONDS;
  const sig = avatarLinkSignature(storageSigningKeys(env).current.secret, parts.ownerId, parts.file, expires);
  const base = (env['API_PUBLIC_URL'] ?? '').trim().replace(/\/+$/, '');
  return `${base}/api/v1/auth/selfie/${parts.ownerId}/${parts.file}?expires=${expires}&sig=${sig}`;
}

/** Is this a live link this server signed for this photo? Constant-time, either key of the ring. */
export function verifySealedAvatarLink(
  ownerId: string, file: string, expires: number, sig: string, now = Date.now(), env: Record<string, string | undefined> = process.env,
): boolean {
  const nowS = Math.floor(now / 1000);
  if (!OWNER_ID.test(ownerId) || !SEALED_FILE.test(file) || !Number.isSafeInteger(expires)) return false;
  if (expires < nowS || expires > nowS + SEALED_AVATAR_TTL_SECONDS + 60) return false;
  if (!/^[a-f0-9]{32}$/.test(sig)) return false;
  const ring = storageSigningKeys(env);
  const provided = Buffer.from(sig);
  return [ring.current, ring.previous].some((key) => {
    if (!key) return false;
    const expected = Buffer.from(avatarLinkSignature(key.secret, ownerId, file, expires));
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  });
}

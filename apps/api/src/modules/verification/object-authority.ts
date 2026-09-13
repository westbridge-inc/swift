import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { localStorageBaseDir, resolveLocalStorageKey, storageProviderKind } from '../../providers/storage/storage-key';

export type VerificationObjectStore = Pick<PrismaClient, 'encryptedObject' | 'verificationDocument'>;
export interface VerificationObjectReference {
  fileKey: string;
  userId: string;
  /** Present for an existing submission; absent only for an unclaimed upload. */
  documentId?: string;
}

export function verificationObjectUnavailable(): AppError {
  // One response for foreign, missing, shared, malformed, shredded and unproven
  // legacy objects. Neither the key nor metadata/storage errors leave this boundary.
  return new AppError(400, 'VERIFICATION_OBJECT_UNAVAILABLE', 'This verification file is unavailable. Upload it again.');
}

function ownedKey(key: string, userId: string, folder: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) return null;
  const relative = key.startsWith('/uploads/') ? key.slice('/uploads/'.length) : key;
  const prefix = `${folder}/${userId}/`;
  if (!relative.startsWith(prefix)) return null;
  const name = relative.slice(prefix.length);
  // No URL, escaping, percent-encoding, query, fragment, or alternate separator.
  // Verification ownership comes from metadata; signup avatars need the exact
  // server-issued filename shape because they have no envelope metadata.
  const filename = folder === 'avatars' ? /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9]+$/ : /^[A-Za-z0-9_-]{1,200}\.enc$/;
  return filename.test(name) ? relative : null;
}

const CENSUS_PAGE_SIZE = 100;
const CENSUS_MAX_PAGES = 100;

/** Local keys have infinitely many textual aliases; an IN-list cannot prove
 * exclusivity. Scan the two existing reference tables in bounded pages, keep
 * at most two matches, and refuse authority if the complete census exceeds
 * the bound. This temporary containment cost ends only with structural keys. */
async function localReferences<T>(
  read: (after: string | undefined) => Promise<T[]>,
  cursor: (row: T) => string,
  key: (row: T) => string,
  fileKey: string,
): Promise<T[]> {
  const baseDir = localStorageBaseDir();
  const physical = resolveLocalStorageKey(fileKey, baseDir);
  const matches: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < CENSUS_MAX_PAGES; page++) {
    const rows = await read(after);
    for (const row of rows) {
      let same = false;
      try { same = resolveLocalStorageKey(key(row), baseDir) === physical; } catch { /* invalid keys cannot resolve in this adapter */ }
      if (same) matches.push(row);
      if (matches.length === 2) return matches;
    }
    if (rows.length < CENSUS_PAGE_SIZE) return matches;
    const next = cursor(rows[rows.length - 1]!);
    if (next === after) throw verificationObjectUnavailable();
    after = next;
  }
  throw verificationObjectUnavailable();
}

/** Existing-metadata containment, not a substitute for structural object lineage
 * or a committed purge fence. Only one exact metadata row and one expected
 * submission (or no submission at intake) may authorize this object. These two
 * tables currently have no tenant filter; don't replace the census with a
 * tenant-scoped child query, which would hide conflicting legacy references. */
export async function resolveVerificationObject(db: VerificationObjectStore, ref: VerificationObjectReference) {
  try {
    const relative = ownedKey(ref.fileKey, ref.userId, 'verification');
    if (!relative || !relative.endsWith('.enc')) throw verificationObjectUnavailable();
    const [objects, documents] = storageProviderKind() === 'local'
      ? await Promise.all([
        localReferences((after) => db.encryptedObject.findMany({
          where: after ? { fileKey: { gt: after } } : {}, orderBy: { fileKey: 'asc' }, take: CENSUS_PAGE_SIZE,
        }), (row) => row.fileKey, (row) => row.fileKey, ref.fileKey),
        localReferences((after) => db.verificationDocument.findMany({
          where: after ? { id: { gt: after } } : {}, orderBy: { id: 'asc' },
          select: { id: true, userId: true, fileUrl: true }, take: CENSUS_PAGE_SIZE,
        }), (row) => row.id, (row) => row.fileUrl, ref.fileKey),
      ])
      : await Promise.all([
        db.encryptedObject.findMany({ where: { fileKey: { in: [ref.fileKey] } }, take: 2 }),
        db.verificationDocument.findMany({ where: { fileUrl: { in: [ref.fileKey] } }, select: { id: true, userId: true, fileUrl: true }, take: 2 }),
      ]);
    const object = objects[0];
    if (objects.length !== 1 || !object || object.fileKey !== ref.fileKey || object.createdBy !== ref.userId
      || object.shreddedAt !== null || !object.wrappedDek?.length || object.iv.length !== 12 || object.authTag.length !== 16
      || !/^[a-f0-9]{64}$/i.test(object.sha256) || !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes <= 0
      || !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(object.mimeType)) {
      throw verificationObjectUnavailable();
    }
    if (ref.documentId === undefined ? documents.length !== 0
      : documents.length !== 1 || documents[0]?.id !== ref.documentId || documents[0]?.userId !== ref.userId || documents[0]?.fileUrl !== ref.fileKey) {
      throw verificationObjectUnavailable();
    }
    return object;
  } catch {
    throw verificationObjectUnavailable();
  }
}

/** Transitional signup-selfie authority. POST /auth/selfie is the only non-null
 * avatar writer; profile edits cannot choose this pointer. Read that persisted
 * fact ourselves, and require the exact subject namespace and capture marker.
 * This exception is only for the signup face, never a verification document. */
export async function resolveSignupSelfie(db: Pick<PrismaClient, 'user'>, userId: string): Promise<string> {
  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { avatar: true, selfieCapturedAt: true } });
    if (!user?.avatar || !user.selfieCapturedAt || !isOwnedAvatarKey(user.avatar, userId)) throw new Error();
    return user.avatar;
  } catch {
    throw new AppError(400, 'SELFIE_REQUIRED', 'Retake your profile selfie before submitting your ID.');
  }
}

/** Avatar cleanup must never interpret a document pointer as deletion authority. */
export function isOwnedAvatarKey(key: string, userId: string): boolean {
  return ownedKey(key, userId, 'avatars') !== null;
}

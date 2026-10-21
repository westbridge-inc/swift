import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * [IMAGES-E2E · REVIEW-F S2-1 on #1918] Deleting the bytes of a photo customers were shown.
 *
 * A store's photos (`items/<store>/<file>`) and a provider's portfolio photos
 * (`portfolio/<provider>/<file>`) are kept by Swift. A portfolio photo can show a
 * customer's home or people. When the photo is taken down, dropped from a profile
 * or its owner's account is erased, clearing the row's pointer is not enough: once
 * the only pointer is gone no sweep can find the object again (lib/storage-orphans,
 * F-026-02). So the durable deletion row is written FIRST, in the same transaction
 * that clears the pointer, and the object is then deleted; a delete that fails stays
 * open for the standing retry (retryStorageOrphans).
 */

/** Taken down, dropped from a profile, or replaced by a new upload. */
export const PUBLIC_PHOTO_REMOVED = 'PUBLIC_PHOTO_REMOVED_DELETE_PENDING';
/** The owner's account was erased. */
export const PUBLIC_PHOTO_ACCOUNT_DELETION = 'ACCOUNT_DELETION_PUBLIC_PHOTO_PENDING';
export const PUBLIC_PHOTO_DELETE_REASONS: ReadonlySet<string> = new Set([PUBLIC_PHOTO_REMOVED, PUBLIC_PHOTO_ACCOUNT_DELETION]);

export type PublicPhotoFolder = 'items' | 'portfolio';

/** Exactly the two shapes the upload saves: the object-storage key, or the local "/uploads/" path. */
const PUBLIC_PHOTO_KEY = /^(?:\/uploads\/)?(items|portfolio)\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{16}(?:\.[A-Za-z0-9_-]{1,16})?)$/;

export function parsePublicPhotoKey(key: string): { folder: PublicPhotoFolder; ownerId: string; file: string } | null {
  const m = PUBLIC_PHOTO_KEY.exec(key);
  return m ? { folder: m[1] as PublicPhotoFolder, ownerId: m[2]!, file: m[3]! } : null;
}

/** A photo Swift keeps in THIS provider's portfolio folder. */
export function isProviderPortfolioKey(key: string, providerId: string): boolean {
  const parsed = parsePublicPhotoKey(key);
  return parsed !== null && parsed.folder === 'portfolio' && parsed.ownerId === providerId;
}

/** Both stored shapes of one object, for the reference reads. */
function bothShapes(key: string): string[] {
  const bare = key.startsWith('/uploads/') ? key.slice('/uploads/'.length) : key;
  return [bare, `/uploads/${bare}`];
}

type Tx = Prisma.TransactionClient | PrismaClient;

/** True while any row still points at the photo (then it is not deleted). An archived
 *  item or section still counts: the bytes go only when nothing names them. */
export async function publicPhotoStillReferenced(tx: Tx, key: string): Promise<boolean> {
  const parsed = parsePublicPhotoKey(key);
  if (!parsed) return true;
  const shapes = bothShapes(key);
  if (parsed.folder === 'portfolio') {
    return (await tx.serviceProvider.count({ where: { portfolioPhotos: { hasSome: shapes } } })) > 0;
  }
  const [stores, sections, items] = await Promise.all([
    tx.vendor.count({ where: { OR: [{ logoUrl: { in: shapes } }, { coverImageUrl: { in: shapes } }] } }),
    tx.category.count({ where: { imageUrl: { in: shapes } } }),
    tx.item.count({ where: { imageUrl: { in: shapes } } }),
  ]);
  return stores + sections + items > 0;
}

/** The user who owns the photo's folder: the provider's user, or the store owner's user. */
export async function publicPhotoFolderOwner(tx: Tx, key: string): Promise<string | null> {
  const parsed = parsePublicPhotoKey(key);
  if (!parsed) return null;
  if (parsed.folder === 'portfolio') {
    return (await tx.serviceProvider.findUnique({ where: { id: parsed.ownerId }, select: { userId: true } }))?.userId ?? null;
  }
  return (await tx.vendor.findUnique({ where: { id: parsed.ownerId }, select: { owner: { select: { userId: true } } } }))?.owner?.userId ?? null;
}

import type { Prisma } from '@prisma/client';
import { queueStorageOrphan } from '../../lib/storage-orphans';
import { PUBLIC_PHOTO_REMOVED, isStorePhotoKey } from '../../utils/public-photo-deletion';

/**
 * [IMAGES-E2E PR4 · the REVIEW-F S2-1 gap, for store photos] Before a store photo's pointer
 * (logo, cover, section or item photo) is replaced or cleared, the durable deletion row for
 * each photo Swift keeps in the store's folder is written in the SAME transaction (an outside
 * address has no object of ours). The row names the store owner, who owns the folder
 * (lib/storage-orphans checks it). Returns the rows to delete once the transaction commits.
 */
export async function queueStorePhotoDeletions(
  tx: Prisma.TransactionClient,
  vendorId: string,
  keys: Array<string | null | undefined>,
  reason: string = PUBLIC_PHOTO_REMOVED,
): Promise<string[]> {
  const own = [...new Set(keys.filter((key): key is string => typeof key === 'string' && isStorePhotoKey(key, vendorId)))];
  if (own.length === 0) return [];
  const store = await tx.vendor.findUnique({ where: { id: vendorId }, select: { tenantId: true, owner: { select: { userId: true } } } });
  const userId = store?.owner?.userId;
  if (!store || !userId) return [];
  const ids: string[] = [];
  for (const key of own) ids.push((await queueStorageOrphan(tx, { key, reason, userId, tenantId: store.tenantId })).id);
  return ids;
}

/** Every photo of these stores (logo, cover, every section and item, archived ones included)
 *  is queued for deletion and its address cleared: the owner's account is being erased. */
export async function queueStoresPhotoErasure(
  tx: Prisma.TransactionClient,
  vendorIds: string[],
  reason: string,
): Promise<void> {
  for (const vendorId of vendorIds) {
    const [store, sections, items] = await Promise.all([
      tx.vendor.findUnique({ where: { id: vendorId }, select: { logoUrl: true, coverImageUrl: true } }),
      tx.category.findMany({ where: { vendorId, imageUrl: { not: null } }, select: { imageUrl: true } }),
      tx.item.findMany({ where: { vendorId, imageUrl: { not: null } }, select: { imageUrl: true } }),
    ]);
    await queueStorePhotoDeletions(tx, vendorId, [
      store?.logoUrl, store?.coverImageUrl, ...sections.map((c) => c.imageUrl), ...items.map((i) => i.imageUrl),
    ], reason);
    await tx.vendor.update({ where: { id: vendorId }, data: { logoUrl: null, coverImageUrl: null } });
    await tx.category.updateMany({ where: { vendorId, imageUrl: { not: null } }, data: { imageUrl: null } });
    await tx.item.updateMany({ where: { vendorId, imageUrl: { not: null } }, data: { imageUrl: null } });
  }
}

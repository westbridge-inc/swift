import type { Prisma } from '@prisma/client';
import { queueStorageOrphan } from '../../lib/storage-orphans';
import { PUBLIC_PHOTO_REMOVED, isProviderPortfolioKey } from '../../utils/public-photo-deletion';

/** [IMAGES-E2E · REVIEW-G S3-1 on #1918] The portfolio customers are handed: only photos Swift
 *  keeps in this provider's own folder. An address saved before photos became upload-only (any
 *  outside host) is dropped: customers' phones would load it from that host, unscanned and with
 *  their IP handed to a third party (COORD ruling 19 Oct (a), as for menu item photos). */
export function servedPortfolioPhotos(provider: { id: string; portfolioPhotos: string[] }): string[] {
  return provider.portfolioPhotos.filter((photo) => isProviderPortfolioKey(photo, provider.id));
}

/** [IMAGES-E2E · REVIEW-F S2-1 on #1918] Before a portfolio pointer disappears, the durable
 *  deletion row for each Swift-kept photo is written in the SAME transaction (an outside address
 *  has no object of ours). Returns the rows to delete once the transaction commits. */
export async function queuePortfolioPhotoDeletions(
  tx: Prisma.TransactionClient,
  provider: { id: string; userId: string },
  tenantId: string,
  removed: string[],
  reason: string = PUBLIC_PHOTO_REMOVED,
): Promise<string[]> {
  const ids: string[] = [];
  for (const key of removed) {
    if (!isProviderPortfolioKey(key, provider.id)) continue;
    ids.push((await queueStorageOrphan(tx, { key, reason, userId: provider.userId, tenantId })).id);
  }
  return ids;
}

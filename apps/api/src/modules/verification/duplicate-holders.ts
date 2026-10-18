import type { PrismaClient } from '@prisma/client';
import { runAsSystem } from '../../plugins/tenant-context';

/**
 * [SWIFT-078 · DOC-INV-11 · Row 331 DSAR-ERASURE (c)] The OTHER accounts that
 * hold the same document bytes, for the duplicate-document signal and the
 * identity-graph edge. An erased account is never one of them: erasure forgets
 * the fingerprint of everything it shredded, and an object it still keeps (a
 * legal hold) must not link a closed account to anybody, or put a new identity
 * signal on a person who asked to be erased.
 *
 * The erased check reads every tenant (system capability): the duplicate signal
 * is platform-wide, so it must see a closure in any tenant too.
 */
export async function liveDuplicateHolders(
  db: Pick<PrismaClient, 'encryptedObject' | 'user'>,
  sha256: string,
  userId: string,
): Promise<string[]> {
  const rows = await db.encryptedObject.findMany({
    where: { sha256, createdBy: { not: userId } },
    select: { createdBy: true, sha256: true },
    distinct: ['createdBy'],
    orderBy: { createdBy: 'asc' },
  });
  const holders = rows.filter((r) => r.sha256 === sha256 && r.createdBy !== userId).map((r) => r.createdBy);
  if (!holders.length) return [];
  const closed = await runAsSystem('verification:duplicate-holder-closure-census', () => db.user.findMany({
    where: { id: { in: holders }, phone: { startsWith: 'deleted:' } },
    select: { id: true, phone: true },
  }));
  const erased = new Set(closed.filter((u) => u.phone === `deleted:${u.id}`).map((u) => u.id));
  return holders.filter((id) => !erased.has(id));
}

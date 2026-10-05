/**
 * [DOC-1 §8.6 · P8-6] Reviewer recusal.
 *
 * A reviewer may not decide a case where the subject shares an identity-graph
 * node with the reviewer's own account, device or phone number. The identity
 * graph (swift-trial-integrity) already has ONE definition of "the same
 * person": the cluster an account resolves to after merges. Recusal is that
 * definition applied to reviewer and subject — enforced here, server-side, at
 * claim time AND at decision time, never in the UI (DOC-INV-8).
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { requireIdentityAuthority } from '../integrity/identity-review';

export async function isRecused(prisma: PrismaClient | Prisma.TransactionClient, reviewerId: string, subjectUserId: string): Promise<boolean> {
  if (reviewerId === subjectUserId) return true;
  const sameCluster = (await requireIdentityAuthority(prisma, reviewerId)).memberIds;
  await requireIdentityAuthority(prisma, subjectUserId);
  return sameCluster.includes(subjectUserId);
}

export async function assertNotRecused(prisma: PrismaClient | Prisma.TransactionClient, reviewerId: string, subjectUserId: string): Promise<void> {
  if (await isRecused(prisma, reviewerId, subjectUserId)) {
    throw new AppError(403, 'REVIEWER_RECUSED', 'You share an identity signal with this person — another reviewer must take this case (DOC-1 §8.6)');
  }
}

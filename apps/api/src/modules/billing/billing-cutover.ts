import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';

export const BILLING_CUTOVER_KEY = 'system:billing-confirmation-cutover:v1';
export const BILLING_CUTOVER_VERSION = '20260930180000-v1';
type Db = PrismaClient | Prisma.TransactionClient;

/** No cache: a missing or different-version completion never enables effects.
 * The database makes completion one-way and checks full backfill coverage. */
export async function billingEffectsReady(db: Db): Promise<boolean> {
  const row = await db.platformConfig.findUnique({ where: { key: BILLING_CUTOVER_KEY }, select: { value: true } });
  const value = row?.value as Prisma.JsonObject | undefined;
  return value?.['version'] === BILLING_CUTOVER_VERSION && value?.['state'] === 'READY'
    && typeof value['completedAt'] === 'string' && typeof value['coverageDigest'] === 'string';
}

export async function requireBillingEffectsReady(db: Db): Promise<void> {
  if (!await billingEffectsReady(db)) throw new AppError(503, 'BILLING_PREPARING', 'Weekly-fee collection is temporarily paused.');
}

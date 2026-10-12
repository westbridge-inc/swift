import { PrismaClient } from '@prisma/client';
import { backfillBillingConfirmation } from '../../modules/billing/billing-confirmation-backfill';
import { environmentForTests, lockTestTarget } from './target-lock';

/**
 * [#1393 · migration 20260930180000] A test database built by replaying the
 * migrations holds weekly-fee effects BLOCKED until the versioned confirmation
 * backfill proves full coverage. Production completes that backfill in its
 * cutover runbook (apps/api/BILLING-CONFIRMATION-CUTOVER.md) with every old
 * writer stopped. The disposable test database completes it here, once, through
 * the same code and the same owner-only SQL boundary, after the same target
 * gate every run passes (it runs again here, so this step can never reach a
 * database that gate would refuse). An already READY database is left exactly
 * as it is; a database whose owners are invalid fails the run loudly instead of
 * testing billing while it is blocked.
 */
export default async function setup(): Promise<void> {
  const env = environmentForTests();
  await lockTestTarget(env);
  const db = new PrismaClient({ datasourceUrl: env['DATABASE_URL'] });
  try {
    const result = await backfillBillingConfirmation(db);
    // eslint-disable-next-line no-console
    if (!result.alreadyComplete) console.log(`[billing cutover] test database: ${result.mapped} subscriptions mapped, confirmation clock READY`);
  } finally {
    await db.$disconnect();
  }
}

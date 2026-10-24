import { PrismaClient } from '@prisma/client';
import { backfillBillingConfirmation } from '../modules/billing/billing-confirmation-backfill';
import { BILLING_CUTOVER_VERSION } from '../modules/billing/billing-cutover';

async function main() {
  const value = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  const expectedDatabase = value('--expected-database');
  const expectedDeployment = value('--expected-deployment');
  if (!process.argv.includes('--execute') || !process.argv.includes('--expected-database')
    || !process.argv.includes('--expected-deployment') || value('--version') !== BILLING_CUTOVER_VERSION) {
    throw new Error('Pass --execute, --version, --expected-database and --expected-deployment for this exact cutover. Stop all old API and billing writers first.');
  }
  const db = new PrismaClient();
  try {
    const [target] = await db.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    const identity = await db.deploymentIdentity.findUnique({ where: { id: 'singleton' } });
    if (!target || !identity || target.database !== expectedDatabase || identity.deploymentId !== expectedDeployment) throw new Error('Billing backfill target does not match the named database and deployment');
    console.log({ database: target.database, deploymentId: identity.deploymentId, version: BILLING_CUTOVER_VERSION });
    console.log(await backfillBillingConfirmation(db));
  } finally { await db.$disconnect(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Billing backfill failed'); process.exitCode = 1; });

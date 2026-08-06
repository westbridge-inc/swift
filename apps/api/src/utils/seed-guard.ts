import type { PrismaClient } from '@prisma/client';

/** All deterministic demo account owners use this range in prisma/seed.ts. */
export const DEMO_PHONE_PREFIX = '+592600';

const DEMO_SEED_ENVIRONMENTS = new Set(['development', 'test']);

/**
 * [F-0001] Protect the default Prisma demo seed from reaching real data.
 *
 * `prisma migrate reset` can invoke the configured seed automatically, so a
 * local-looking DATABASE_URL is not sufficient proof of intent. Every demo
 * seed requires an explicit confirmation, and existing business data is an
 * absolute stop rather than something the confirmation can override.
 */
export async function assertSafeToSeedDemo(
  db: Pick<PrismaClient, 'vendor' | 'order'>,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const nodeEnv = env['NODE_ENV'];

  if (nodeEnv === 'production') {
    throw new Error(
      'FATAL: refusing to run the DEMO seed with NODE_ENV=production. ' +
      'Run prisma/seed-production.ts to seed the production platform spine.',
    );
  }

  if (!nodeEnv || !DEMO_SEED_ENVIRONMENTS.has(nodeEnv)) {
    throw new Error(
      `FATAL: refusing to run the DEMO seed because NODE_ENV must be development or test; got ` +
      `${nodeEnv ?? 'unset'}.`,
    );
  }

  if (env['SEED_DEMO_CONFIRM'] !== 'YES') {
    throw new Error(
      'FATAL: refusing to run the DEMO seed without explicit confirmation. ' +
      'Re-run the intentional development/test seed with SEED_DEMO_CONFIRM=YES.',
    );
  }

  // Fail closed: a rejected inspection must reject the seed. Demo vendors are
  // identified by the deterministic demo owner's phone range, not by hostname
  // guesses such as `db` or `postgres`, which can point at shared databases.
  const [nonDemoVendors, orders] = await Promise.all([
    db.vendor.count({
      where: {
        owner: {
          user: {
            phone: { not: { startsWith: DEMO_PHONE_PREFIX } },
          },
        },
      },
    }),
    db.order.count(),
  ]);

  if (nonDemoVendors > 0 || orders > 0) {
    throw new Error(
      `FATAL: refusing to add demo data to a database containing ${nonDemoVendors} non-demo vendor(s) ` +
      `and ${orders} order(s). Existing business data cannot be overridden by confirmation.`,
    );
  }
}

import type { PrismaClient } from '@prisma/client';

/** Exact user identities created by prisma/seed.ts. */
export const DEMO_IDENTITY_PHONES = [
  '+5926001000',
  '+5926002000',
  '+5926003000',
  '+5926004000',
  '+5926005001',
  '+5926005002',
  '+5926005003',
] as const;

const DEMO_SEED_ENVIRONMENTS = new Set(['development', 'test']);

/**
 * [F-0001] Protect the default Prisma demo seed from reaching real data.
 *
 * This guard protects only demo insertion. It cannot protect data from
 * `prisma migrate reset`, which drops and recreates the database before it can
 * invoke the seed. Every demo seed requires an explicit confirmation, and
 * existing business data is an absolute stop rather than something the
 * confirmation can override.
 */
export async function assertSafeToSeedDemo(
  db: Pick<PrismaClient, 'user' | 'vendor' | 'order'>,
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

  // Fail closed: a rejected inspection must reject the seed. Demo identities
  // are an exact allowlist; a phone prefix can also belong to a real account.
  const demoIdentityPhones = [...DEMO_IDENTITY_PHONES];
  const [nonDemoUsers, nonDemoVendors, orders] = await Promise.all([
    db.user.count({
      where: {
        phone: { notIn: demoIdentityPhones },
      },
    }),
    db.vendor.count({
      where: {
        owner: {
          user: {
            phone: { notIn: demoIdentityPhones },
          },
        },
      },
    }),
    db.order.count(),
  ]);

  if (nonDemoUsers > 0 || nonDemoVendors > 0 || orders > 0) {
    throw new Error(
      `FATAL: refusing to add demo data to a database containing ${nonDemoUsers} non-demo user(s), ` +
      `${nonDemoVendors} non-demo vendor(s), and ${orders} order(s). ` +
      'Existing business data cannot be overridden by confirmation.',
    );
  }
}

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
/** Deployment identities a demo seed may run against. Anything else — production, staging, a
 *  name nobody recognises — is refused; an ABSENT identity is tolerated only when the database is
 *  also empty of business rows (an ephemeral database by evidence). */
export const DEMO_SEED_IDENTITIES: ReadonlySet<string> = new Set(['development', 'test', 'ephemeral', 'local']);

export async function assertSafeToSeedDemo(
  db: Pick<PrismaClient, 'user' | 'vendor' | 'order'> & { deploymentIdentity?: Pick<PrismaClient['deploymentIdentity'], 'findUnique'> },
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const nodeEnv = env['NODE_ENV'];
  // [R048-005] The database's OWN declaration of what it is outranks the shell's NODE_ENV: a demo
  // seed pointed at a database that calls itself production (or anything not in the demo set) is
  // refused before any row is inspected.
  if (db.deploymentIdentity) {
    const identity = await db.deploymentIdentity.findUnique({ where: { id: 'singleton' }, select: { environment: true, deploymentId: true } }).catch(() => null);
    if (identity && !DEMO_SEED_IDENTITIES.has(identity.environment)) {
      throw new Error(
        `FATAL: refusing to run the DEMO seed against a database whose deployment identity is ` +
        `"${identity.environment}" (${identity.deploymentId}). Demo fixtures run only on an ephemeral ` +
        `development/test database.`,
      );
    }
  }

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

/**
 * [R048-005] A demo database declares what it is. When a development/test
 * database has NO deployment identity yet and holds no business rows, the demo
 * seed writes one — `local-<host>` / NODE_ENV — so every later plan can bind
 * to it and a production database can never be mistaken for it. An existing
 * identity is never rewritten here.
 */
export async function ensureEphemeralIdentity(
  db: Pick<PrismaClient, 'user' | 'vendor' | 'order'> & { deploymentIdentity: Pick<PrismaClient['deploymentIdentity'], 'findUnique' | 'create'> },
  env: Record<string, string | undefined> = process.env,
): Promise<{ deploymentId: string; environment: string }> {
  const existing = await db.deploymentIdentity.findUnique({ where: { id: 'singleton' }, select: { deploymentId: true, environment: true } });
  if (existing) return existing;
  const nodeEnv = env['NODE_ENV'];
  if (!nodeEnv || !DEMO_SEED_ENVIRONMENTS.has(nodeEnv)) throw new Error(`FATAL: cannot declare an ephemeral identity under NODE_ENV=${nodeEnv ?? 'unset'}`);
  const [users, vendors, orders] = await Promise.all([db.user.count(), db.vendor.count(), db.order.count()]);
  if (users + vendors + orders > 0) throw new Error(`FATAL: this database holds ${users} user(s), ${vendors} vendor(s), ${orders} order(s) and declares no deployment identity — it is not ephemeral by evidence; set its identity deliberately.`);
  const host = (env['HOSTNAME'] ?? 'local').replace(/[^A-Za-z0-9-]/g, '-').slice(0, 40);
  const created = await db.deploymentIdentity.create({ data: { id: 'singleton', deploymentId: `local-${host}`, environment: nodeEnv, note: 'declared by the demo seed on an empty database' }, select: { deploymentId: true, environment: true } });
  return created;
}

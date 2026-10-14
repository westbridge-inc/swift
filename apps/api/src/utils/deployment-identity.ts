/**
 * [S3-L1] A process starts only on a database of its own kind.
 *
 * Every production guard keys on NODE_ENV (utils/runtime-mode.ts). Nothing
 * tied the DATABASE to that posture: a production host whose deploy/.env was
 * edited to NODE_ENV=development would serve the production database with
 * every production guard off (ads on, sandbox providers, the OTP bypass).
 *
 * The database already says which deployment it belongs to: the
 * deployment_identity row, written once when it is set up (PILOT-RUNBOOK
 * section 12 on production; the seed, purge and billing tools bind to it).
 * The rule, checked by the API and the worker before anything is served or
 * any job runs:
 *   - a production process starts only on a database whose identity says
 *     exactly `production` (no row, another word, or an unreadable table
 *     refuses);
 *   - any other mode refuses a database whose identity says `production`.
 *     Outside production a database without the row, or without the table
 *     (a schema older than it), passes; any other read failure refuses.
 * Refusals name the mode and the identity word, never a connection detail.
 */
import { PrismaClient } from '@prisma/client';
import { runtimeMode } from './runtime-mode';

export type IdentityDb = { deploymentIdentity: Pick<PrismaClient['deploymentIdentity'], 'findUnique'> };

export class DeploymentIdentityRefused extends Error {
  override readonly name = 'DeploymentIdentityRefused';
}

/** Prisma's "the table does not exist" error code. */
const TABLE_MISSING = 'P2021';

const shown = (word: string) => JSON.stringify(word.slice(0, 40));

export async function assertDeploymentIdentityMatchesMode(
  db: IdentityDb,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const mode = runtimeMode(env);
  let environment: string | null;
  try {
    const row = await db.deploymentIdentity.findUnique({ where: { id: 'singleton' }, select: { environment: true } });
    environment = row?.environment ?? null;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (mode !== 'production' && code === TABLE_MISSING) return;
    throw new DeploymentIdentityRefused(
      `FATAL: NODE_ENV=${mode}, and this database's deployment_identity could not be read (${typeof code === 'string' ? code : 'read failed'}). ` +
      (mode === 'production'
        ? 'A production process starts only on a database that says it is production.'
        : 'Refusing to start without knowing whether this is the production database.'),
    );
  }
  if (mode === 'production' && environment !== 'production') {
    throw new DeploymentIdentityRefused(
      environment === null
        ? 'FATAL: NODE_ENV=production, but this database has no deployment_identity row. A production process starts only on a database that says it is production (PILOT-RUNBOOK section 12 writes the row once, before the first boot).'
        : `FATAL: NODE_ENV=production, but this database's deployment_identity says ${shown(environment)}. A production process never serves another deployment's database.`,
    );
  }
  if (mode !== 'production' && environment === 'production') {
    throw new DeploymentIdentityRefused(
      `FATAL: NODE_ENV=${mode}, but this database's deployment_identity says "production". The production database is served only by a production process (NODE_ENV=production, PILOT_ENV=production); every production guard is off in ${mode}.`,
    );
  }
}

/**
 * The API's start check, BEFORE the app is built: building it starts the
 * in-process job workers. A short-lived client of its own, closed after.
 */
export async function checkDeploymentIdentityAtStart(
  makeClient: () => IdentityDb & { $disconnect(): Promise<void> } = () => new PrismaClient(),
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const db = makeClient();
  try {
    await assertDeploymentIdentityMatchesMode(db, env);
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

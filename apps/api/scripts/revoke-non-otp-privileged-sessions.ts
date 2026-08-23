import Fastify from 'fastify';
import { prismaPlugin } from '../src/plugins/prisma';
import { redisPlugin } from '../src/plugins/redis';
import { AuthService } from '../src/modules/auth/auth.service';
import { assertSafeBootConfig } from '../src/utils/boot-config';

const CONFIRMATION = 'REVOKE_NON_OTP_PRIVILEGED_SESSIONS';
const BATCH_SIZE = 500;

function requireAuthorization(): void {
  if (process.env['PRIVILEGED_SESSION_CUTOVER_CONFIRM'] !== CONFIRMATION) {
    throw new Error(
      `Refusing session revocation: set PRIVILEGED_SESSION_CUTOVER_CONFIRM=${CONFIRMATION} only after maintenance mode is active and every old API/worker/socket binary is stopped`,
    );
  }
  if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is required');
  if (!process.env['REDIS_URL']) throw new Error('REDIS_URL is required');

  // [F-028-14] The FULL production posture, not just the confirmation value.
  // Every downstream guard — getPushProvider's DevPush refusal,
  // assertSafeBootConfig — defines "production" solely by the exact
  // NODE_ENV string. This script is documented to run against the production
  // database, and each logout it performs fans out push notifications; run
  // with production targets but NODE_ENV absent or misspelled, the boot
  // barrier waves it through, PUSH_PROVIDER defaults to 'dev', and every
  // revocation notice is silently swallowed by an in-memory DevPush while
  // reporting success. The operator typed the confirmation value; they have
  // already declared this is production — so the environment must SAY so
  // before AuthService is ever constructed.
  if (process.env['NODE_ENV'] !== 'production') {
    throw new Error(
      'Refusing session revocation: the cutover confirmation is set but NODE_ENV is '
      + `${JSON.stringify(process.env['NODE_ENV'] ?? '(unset)')} — this command targets production, so run it with `
      + 'NODE_ENV=production or the DevPush/boot guards cannot see what you are doing.',
    );
  }
  if ((process.env['PUSH_PROVIDER'] ?? 'dev') === 'dev') {
    throw new Error(
      'Refusing session revocation: PUSH_PROVIDER is dev (in-memory) — every revocation push this cutover '
      + 'sends would be silently swallowed while reporting success. Set PUSH_PROVIDER=expo.',
    );
  }
}

async function main(): Promise<void> {
  requireAuthorization();
  // [F-027-15] This script is documented to run against PRODUCTION, and it
  // constructs Fastify plus AuthService directly — outside the boot barrier
  // that server.ts and worker.ts pass through. Same barrier, same refusal.
  assertSafeBootConfig();
  const app = Fastify({ logger: true });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.ready();

  let revoked = 0;
  try {
    const auth = new AuthService(app);
    let scanAgain = true;
    while (scanAgain) {
      const sessions = await app.prisma.session.findMany({
        where: {
          authMethod: { not: 'OTP' },
          user: {
            OR: [
              { activeRole: { in: ['ADMIN', 'SUPER_ADMIN'] } },
              { roles: { hasSome: ['ADMIN', 'SUPER_ADMIN'] } },
            ],
          },
        },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        select: { id: true, userId: true, authMethod: true },
      });
      if (sessions.length === 0) {
        scanAgain = false;
        continue;
      }

      for (const session of sessions) {
        await auth.logout(session.id, session.userId);
        revoked += 1;
      }
      process.stderr.write(`${JSON.stringify({
        operation: 'privileged-session-assurance-cutover-progress',
        revoked,
      })}\n`);
    }

    const residual = await app.prisma.session.count({
      where: {
        authMethod: { not: 'OTP' },
        user: {
          OR: [
            { activeRole: { in: ['ADMIN', 'SUPER_ADMIN'] } },
            { roles: { hasSome: ['ADMIN', 'SUPER_ADMIN'] } },
          ],
        },
      },
    });
    if (residual !== 0) {
      throw new Error(`${residual} non-OTP privileged session(s) remain; keep maintenance mode active`);
    }

    process.stdout.write(`${JSON.stringify({
      operation: 'privileged-session-assurance-cutover',
      completed: true,
      revoked,
      residual,
    })}\n`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Privileged session assurance cutover failed: ${message}\n`);
  process.exitCode = 1;
});

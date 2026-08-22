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

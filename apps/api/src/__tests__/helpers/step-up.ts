import type { FastifyInstance } from 'fastify';
import { stepUpKey, STEP_UP_TTL_S } from '../../modules/auth/step-up';

/**
 * Grant a verified step-up to the session behind `token` without the SMS
 * round-trip. The round-trip itself — send, wrong code, right code, lock —
 * is graded in attack-payout-link-change.test.ts; every other suite that
 * touches a money surface only needs the session to be stepped up.
 */
export async function grantStepUp(app: FastifyInstance, token: string): Promise<void> {
  const session = await app.prisma.session.findUnique({ where: { token }, select: { id: true } });
  if (!session) throw new Error('grantStepUp: no session for this token');
  await app.redis.set(stepUpKey(session.id), '1', 'EX', STEP_UP_TTL_S);
}

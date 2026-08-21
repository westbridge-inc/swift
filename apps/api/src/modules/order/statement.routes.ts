import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../utils/errors';
import {
  buildDriverStatement,
  buildRiderStatement,
  buildVendorStatement,
  signStatementToken,
  type StatementKind,
} from './statement';

/**
 * Signed statement render (marketplace §12): the browser can't send a JWT, so
 * the AUTHED statement routes mint a short-lived HMAC link and THIS route
 * verifies it — the document render-token model. PUBLIC on purpose: the
 * signature (minted only for the authenticated owner) IS the authorization.
 */
export async function statementRoutes(app: FastifyInstance) {
  app.get('/render', async (request, reply) => {
    const q = z
      .object({
        kind: z.enum(['rider', 'driver', 'vendor']),
        actor: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
        expires: z.coerce.number().int(),
        sig: z.string().length(32),
      })
      .parse(request.query);

    if (q.expires < Math.floor(Date.now() / 1000)) {
      throw new AppError(410, 'LINK_EXPIRED', 'This statement link has expired — open a fresh one from the app.');
    }
    // [F-249] Constant-time, like every other signature check in the codebase
    // (envelope.ts verifyRenderToken, the agent-cash webhook). `!==` on strings
    // short-circuits at the first differing byte, leaking through response
    // timing how much of the HMAC an attacker has guessed — and the signature
    // IS the authorization for someone's earnings statement.
    const expected = Buffer.from(signStatementToken(q.kind as StatementKind, q.actor, q.from, q.to, q.expires));
    const provided = Buffer.from(q.sig);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new AppError(403, 'BAD_SIGNATURE', 'This statement link is not valid.');
    }

    const period = { from: new Date(q.from), to: new Date(q.to), label: periodLabel(q.from, q.to) };
    reply.type('text/html; charset=utf-8');
    if (q.kind === 'vendor') return buildVendorStatement(app.prisma, q.actor, period);
    if (q.kind === 'driver') {
      const driver = await app.prisma.driver.findUniqueOrThrow({ where: { id: q.actor }, select: { userId: true } });
      return buildDriverStatement(app.prisma, q.actor, driver.userId, period);
    }
    const rider = await app.prisma.rider.findUniqueOrThrow({ where: { id: q.actor }, select: { userId: true } });
    return buildRiderStatement(app.prisma, q.actor, rider.userId, period);
  });
}

function periodLabel(from: string, to: string): string {
  const day = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  return `${day(from)} — ${day(to)}`;
}

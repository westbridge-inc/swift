import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../utils/errors';
import {
  buildDriverStatement,
  buildRiderStatement,
  buildVendorStatement,
  verifyStatementSignature,
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
        // [F-028-15] Signature-protocol version. Absent = a link minted by a
        // pre-F-027-10 instance (v1 format) — during a rolling deploy both
        // formats are in flight for up to the 10-minute TTL, so the verifier
        // accepts both. Old instances still reject v2 links (their zod strips
        // the unknown param and v1-verifies); unfixable from this side, and
        // the TTL bounds the exposure.
        v: z.enum(['1', '2', '3']).optional(),
        k: z.string().regex(/^[0-9a-f]{8}$/).optional(),
        kind: z.enum(['rider', 'driver', 'vendor']),
        actor: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
        expires: z.coerce.number().int(),
        // [F-027-10] The exact alphabet, not just the length. `.length(32)`
        // counts UTF-16 code units while Buffer.from() produces UTF-8 bytes,
        // so 32 'é' characters passed the schema as a 64-BYTE buffer — and the
        // byte-length comparison below then returned before timingSafeEqual
        // ever ran. Pinning the charset makes every accepted signature exactly
        // 32 bytes, so the constant-time path is the only path.
        sig: z.string().regex(/^[0-9a-f]{32}$/),
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
    // [F-027-10] Both buffers are now guaranteed 32 bytes — `expected` is 32
    // hex chars by construction, `provided` by the schema above — so the
    // length guard is a belt-and-braces impossibility rather than a branch an
    // attacker can steer into.
    // [F-028-15] Both formats emit 32 hex chars, so the schema, the length
    // guard, and the constant-time compare are identical either way.
    // [M-37] One keyring-bound, constant-time verifier for every protocol
    // version: a v3 link verifies under the key it names (current, or the
    // previous key during a rotation); a key nobody holds verifies nothing.
    if (!verifyStatementSignature({ ...q, kind: q.kind as StatementKind }, undefined)) {
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

import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    // jti: per-token nonce — same-second logins must not mint identical
    // HS256 tokens (sessions.token is unique)
    payload: { userId: string; role: string; jti?: string };
    user: { userId: string; role: string; jti?: string };
  }
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  const secret = process.env['JWT_SECRET'];
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  await app.register(jwt, {
    secret,
    sign: { expiresIn: '30m' },
  });

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();

      // SEC-8: a JWT alone is not enough — the session must still exist.
      // Logout/reset delete sessions, which kills the access token immediately.
      const token = request.headers.authorization?.slice('Bearer '.length) ?? '';
      const session = await app.prisma.session.findUnique({
        where: { token },
        select: { expiresAt: true },
      });
      if (!session || session.expiresAt < new Date()) {
        throw new Error('Session revoked or expired');
      }
    } catch {
      reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
    }
  });
});

import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { enterTenant } from './prisma';
import { AuthService } from '../modules/auth/auth.service';
import {
  hasPrivilegedSessionAssurance,
  requiresPrivilegedSessionAssurance,
} from '../modules/auth/session-assurance';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateOptional: (request: FastifyRequest) => Promise<void>;
  }

  interface FastifyRequest {
    /** Database session that authenticated this request. Stable across access-token rotation. */
    authSessionId: string | null;
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
    // Launch-readiness §1.1: short-lived access tokens; the mobile client
    // silently refreshes on 401 (rotating refresh + reuse detection tested).
    sign: { expiresIn: '15m' },
  });

  app.decorateRequest('authSessionId', null);
  const authService = new AuthService(app);

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();

      // SEC-8: a JWT alone is not enough — the session must still exist.
      // Logout/reset delete sessions, which kills the access token immediately.
      const token = request.headers.authorization?.slice('Bearer '.length) ?? '';
      const session = await app.prisma.session.findUnique({
        where: { token },
        select: {
          id: true,
          expiresAt: true,
          authMethod: true,
          user: {
            select: {
              id: true,
              tenantId: true,
              status: true,
              roles: true,
              activeRole: true,
            },
          },
        },
      });
      if (
        !session
        || session.expiresAt < new Date()
        || session.user.id !== request.user.userId
      ) {
        throw new Error('Session revoked or expired');
      }
      // SEC: a suspended/banned/deactivated account is cut off on its very next
      // request — even with a still-valid access token + live session. (Admin
      // suspend previously left the token working until it expired.) In-progress
      // PENDING_VERIFICATION still needs access to finish onboarding.
      if (session.user.status === 'SUSPENDED' || session.user.status === 'BANNED' || session.user.status === 'DEACTIVATED') {
        throw new Error('Account is not active');
      }
      if (
        requiresPrivilegedSessionAssurance(session.user.activeRole, session.user.roles)
        && !hasPrivilegedSessionAssurance(session.authMethod)
      ) {
        await authService.logout(session.id, session.user.id);
        throw new Error('Privileged session assurance is insufficient');
      }
      // The JWT role is a short-lived transport hint, never current authority.
      // Role switching intentionally keeps the session alive, so reconcile the
      // principal from the locked database model on every protected request.
      request.user.role = session.user.activeRole;
      request.authSessionId = session.id;
      // Multi-tenancy stage 2: bind this request to the caller's tenant so
      // every tenant-owned query downstream is scoped to it.
      enterTenant(session.user.tenantId);
    } catch {
      request.authSessionId = null;
      reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
    }
  });

  // Optional auth for public-but-personalizable routes (browsing). Attaches the
  // user when a valid token + live session is present, otherwise proceeds as a
  // guest — never 401s. Action routes keep using `authenticate`.
  app.decorate('authenticateOptional', async (request: FastifyRequest) => {
    try {
      await request.jwtVerify();
      const token = request.headers.authorization?.slice('Bearer '.length) ?? '';
      const session = await app.prisma.session.findUnique({
        where: { token },
        select: {
          id: true,
          expiresAt: true,
          authMethod: true,
          user: {
            select: {
              id: true,
              tenantId: true,
              status: true,
              roles: true,
              activeRole: true,
            },
          },
        },
      });
      if (
        !session ||
        session.expiresAt < new Date() ||
        session.user.id !== request.user.userId ||
        session.user.status === 'SUSPENDED' ||
        session.user.status === 'BANNED' ||
        session.user.status === 'DEACTIVATED'
      ) {
        request.authSessionId = null;
        (request as { user?: unknown }).user = undefined;
      } else if (
        requiresPrivilegedSessionAssurance(session.user.activeRole, session.user.roles)
        && !hasPrivilegedSessionAssurance(session.authMethod)
      ) {
        await authService.logout(session.id, session.user.id);
        request.authSessionId = null;
        (request as { user?: unknown }).user = undefined;
      } else {
        request.user.role = session.user.activeRole;
        request.authSessionId = session.id;
        enterTenant(session.user.tenantId);
      }
    } catch {
      request.authSessionId = null;
      (request as { user?: unknown }).user = undefined;
    }
  });
});

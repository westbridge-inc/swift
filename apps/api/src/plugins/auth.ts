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

/**
 * [F-250] A refusal we actually DECIDED — the credential was checked and it
 * did not pass. Distinguished from an infrastructure failure, which is not a
 * verdict about anyone's credentials and must never be reported as one.
 */
class AuthRefused extends Error {}

/** fastify-jwt's own rejections (malformed / expired / bad signature) are
 *  genuine credential verdicts too. */
function isCredentialVerdict(err: unknown): boolean {
  if (err instanceof AuthRefused) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('FST_JWT');
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
        throw new AuthRefused('Session revoked or expired');
      }
      // SEC: a suspended/banned/deactivated account is cut off on its very next
      // request — even with a still-valid access token + live session. (Admin
      // suspend previously left the token working until it expired.) In-progress
      // PENDING_VERIFICATION still needs access to finish onboarding.
      if (session.user.status === 'SUSPENDED' || session.user.status === 'BANNED' || session.user.status === 'DEACTIVATED') {
        throw new AuthRefused('Account is not active');
      }
      if (
        requiresPrivilegedSessionAssurance(session.user.activeRole, session.user.roles)
        && !hasPrivilegedSessionAssurance(session.authMethod)
      ) {
        await authService.logout(session.id, session.user.id);
        throw new AuthRefused('Privileged session assurance is insufficient');
      }
      // The JWT role is a short-lived transport hint, never current authority.
      // Role switching intentionally keeps the session alive, so reconcile the
      // principal from the locked database model on every protected request.
      request.user.role = session.user.activeRole;
      request.authSessionId = session.id;
      // Multi-tenancy stage 2: bind this request to the caller's tenant so
      // every tenant-owned query downstream is scoped to it.
      enterTenant(session.user.tenantId);
    } catch (err) {
      request.authSessionId = null;
      // [F-250] "I could not REACH the session store" is not "your token is
      // invalid". The bare catch here reported every infrastructure failure —
      // a saturated connection pool, an unreachable database — as UNAUTHORIZED,
      // and it logged nothing at all. Two consequences, both observed live on
      // the rig under a 220-request burst (70 of them answered 401 while the
      // tokens were perfectly valid):
      //   * clients treat 401 as "credentials are dead", clear their tokens and
      //     force a re-login, so a transient DB blip becomes a fleet-wide
      //     forced logout that outlives the blip; and
      //   * it lands hardest on the SOS routes, which are deliberately exempt
      //     from the rate limiter precisely so a person can tap repeatedly —
      //     they are told their session is invalid at the worst possible moment.
      // A verdict we actually reached is 401. Anything else is 503 and is
      // LOUD, because it is an outage, not a login problem.
      if (isCredentialVerdict(err)) {
        reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
        return;
      }
      request.log.error({ err, url: request.url }, '[F-250] could not verify the session — reporting 503, NOT 401');
      reply.status(503).send({
        success: false,
        error: { code: 'AUTH_UNAVAILABLE', message: 'We could not verify your session right now. Please try again in a moment — you have not been signed out.' },
      });
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
    } catch (err) {
      // Falling back to guest is correct here — this decorator never 401s, and
      // the route's own queries will surface a real outage on their own path.
      // [F-250] But it must not be SILENT: an unreachable session store
      // quietly demotes every signed-in browser to a guest view, which looks
      // like a personalization bug and never like the outage it is.
      if (!isCredentialVerdict(err)) {
        request.log.error({ err, url: request.url }, '[F-250] optional auth could not reach the session store — serving this request as a GUEST');
      }
      request.authSessionId = null;
      (request as { user?: unknown }).user = undefined;
    }
  });
});

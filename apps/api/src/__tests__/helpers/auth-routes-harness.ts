import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { authRoutes } from '../../modules/auth/auth.routes';

/**
 * [FLOW-QA F15] The auth routes count sign-in tries through @fastify/rate-limit (modules/auth/auth-rate-limits.ts:
 * the per-number ceiling is a hook built with app.createRateLimit). app.ts registers the limiter before the routes,
 * as production does; a test harness that mounts the auth routes on a bare Fastify does it here.
 *
 * Suites that are not about limits (most of them) get the limiter with every request let through (allowList), which
 * is how they ran before: they mounted the routes with no limiter at all. The suites that prove the ceilings
 * (rate-limit.test, auth-rate-limits.unit.test, golden/gold-5-plat) register the real limiter themselves; when one is
 * already registered, this leaves it as it is.
 */
export async function registerAuthRoutes(app: FastifyInstance, prefix = '/api/v1/auth'): Promise<void> {
  if (!app.hasDecorator('createRateLimit')) {
    await app.register(rateLimit, { global: false, allowList: () => true });
  }
  await app.register(authRoutes, { prefix });
}

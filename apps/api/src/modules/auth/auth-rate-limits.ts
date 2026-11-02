import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { AppError } from '../../utils/errors';
import { normalizePhone } from '../../utils/phone';

// ---------------------------------------------------------------------------
// [FLOW-QA F15 · 2 Nov 2026] Sign-in limits that do not lock out a whole carrier.
//
// Guyana's mobile carriers put many phones behind one public address (CGNAT). The auth routes used to cap the
// ADDRESS alone (send/verify 5 a minute, register/refresh 10), so a handful of people signing in at once from one
// carrier address locked each other out. Now each route has two ceilings:
//   - per address AND credential (the phone number in the body; for a refresh, the session cookie): the old,
//     tight number, so one person (or one attacker on one number) is held exactly as before;
//   - per address alone: a higher ceiling, so many different people behind one address can sign in, while one
//     address rotating through numbers or fake cookies is still bounded.
// The per-number SMS protections are unchanged and still apply on top: the 60-second cooldown per number, the
// hourly cap per number, the per-number, per-address and global daily SMS budgets (auth.service sendOtp).
// The address is fastify's proxy-resolved request.ip (TRUST_PROXY decides who may set X-Forwarded-For; a numeric
// TRUST_PROXY fails closed at boot), never a header the caller writes.
// ---------------------------------------------------------------------------

export const AUTH_LIMITS = {
  /** send-otp, verify-otp, password reset: per address + number, and per address alone. */
  codePerNumber: 5,
  codePerAddress: 30,
  /** register, password login: per address + number, and per address alone. */
  accountPerNumber: 10,
  accountPerAddress: 30,
  /** refresh: per address + session cookie, and per address alone. */
  refreshPerSession: 10,
  refreshPerAddress: 60,
} as const;

const WINDOW_MS = 60_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

/** The number in a request body, in the one stored form; null when there is none. */
export function bodyPhone(request: Pick<FastifyRequest, 'body'>): string | null {
  const phone = (request.body as { phone?: unknown } | null | undefined)?.phone;
  if (typeof phone !== 'string') return null;
  const normalized = normalizePhone(phone);
  return normalized.replace(/\D/g, '').length >= 7 ? normalized : null;
}

/** The whole cookie header of a refresh (it carries the refresh cookie); null without one. */
export function sessionCookie(request: Pick<FastifyRequest, 'headers'>): string | null {
  const cookie = request.headers['cookie'];
  return typeof cookie === 'string' && cookie.length > 0 ? cookie : null;
}

/**
 * The per-address ceiling, as the route's own @fastify/rate-limit config (keyed by the plugin's key generator: the
 * verified user, else the resolved address).
 */
export const perAddress = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });

/**
 * The per-address-and-credential ceiling, as a preValidation hook (the body is parsed by then). It counts in the
 * limiter's own store (Redis in production) under its own key, and is refused in the server's usual shape with the
 * wait, so the apps can count down instead of showing an error. A request without the credential is left to the
 * per-address ceiling.
 */
export function perCredential(
  app: FastifyInstance,
  name: string,
  max: number,
  credential: (request: FastifyRequest) => string | null,
) {
  const limiter = app.createRateLimit({
    max,
    timeWindow: WINDOW_MS,
    keyGenerator: (request: FastifyRequest) => `auth-${name}:${request.ip}:${digest(credential(request) ?? '')}`,
  });
  return async (request: FastifyRequest) => {
    if (!credential(request)) return;
    const result = await limiter(request);
    if (result.isAllowed || !result.isExceeded) return;
    const retryAfterSeconds = Math.max(1, result.ttlInSeconds);
    throw new AppError(429, 'RATE_LIMITED', `Too many tries. Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`, { retryAfterSeconds, codeAlreadySent: false });
  };
}

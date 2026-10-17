import Redis from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import { rateLimitKey, type RateLimitPrincipal } from './rate-limit-key';

// ---------------------------------------------------------------------------
// [row 331 · APP-PLATFORM-GUARDS · G5-F3] The API's rate limiter, composed in
// ONE place: app.ts registers exactly this, and gold-5-plat composes exactly
// this on a real Redis, so the test can never drift from production.
//
// In production the counters live in Redis (SWIFT-AUD-D6-02: one ceiling
// shared by every API instance). The limiter used to FAIL CLOSED on a store
// error: @fastify/rate-limit re-throws it unless `skipOnError` is set, its hook
// runs on every route, and with the offline queue off a lost connection
// rejects the INCR at once. So a Redis blip answered every request with a 500,
// the /live probe included. Now:
//   - the limiter fails OPEN on a store error (that request is not counted);
//   - the store's client logs an alert while it is down, and once when it is
//     back, so "unlimited for now" is never silent;
//   - /live does not consult the limiter at all (plugins/readiness.ts).
// Failing open does not open a guessing window on sign-in: the OTP codes, the
// OTP cooldowns and the password lockouts are themselves Redis-backed and fail
// closed, so while Redis is unreachable no code or password can be checked.
// ---------------------------------------------------------------------------

/** The namespace production's limiter keys live under (shared by every instance). */
export const RATE_LIMIT_NAMESPACE = 'swift-rl:';

type AlertLog = Pick<FastifyBaseLogger, 'error' | 'info'>;

/** At most one "still down" alert per this many milliseconds. */
const ALERT_EVERY_MS = 60_000;

/**
 * Log the limiter store's outages. An alert when the connection errors, is
 * re-dialling, or has ended (at most one a minute while it stays down), and one
 * line when it is ready again. Never the error's text: it carries the host.
 */
export function watchRateLimitStore(
  store: Pick<Redis, 'on'>,
  log: AlertLog,
  now: () => number = Date.now,
): void {
  let down = false;
  let lastAlertAt = Number.NEGATIVE_INFINITY;
  const alert = (event: 'error' | 'reconnecting' | 'end', err?: unknown) => {
    down = true;
    if (now() - lastAlertAt < ALERT_EVERY_MS) return;
    lastAlertAt = now();
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    log.error(
      { event, ...(err instanceof Error ? { errName: err.name } : {}), ...(typeof code === 'string' ? { code } : {}) },
      'rate limiter store unreachable: the limiter is failing OPEN (requests are served without a ceiling) until Redis answers again',
    );
  };
  store.on('error', (err: unknown) => alert('error', err));
  store.on('reconnecting', () => alert('reconnecting'));
  store.on('end', () => alert('end'));
  store.on('ready', () => {
    if (!down) return;
    down = false;
    lastAlertAt = Number.NEGATIVE_INFINITY;
    log.info({ event: 'ready' }, 'rate limiter store reachable again: the ceilings apply');
  });
}

/** Production's store client: no offline queue and one retry, so a request
 *  never waits on a dead store; outages are logged by watchRateLimitStore. */
export function createRateLimitStore(url: string, log: AlertLog): Redis {
  const store = new Redis(url, {
    connectionName: 'swift-rate-limit',
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  watchRateLimitStore(store, log);
  return store;
}

/**
 * The limiter's options. `store` is production's Redis client (absent in
 * dev/test, which keep the in-memory store: a shared Redis counter across
 * vitest's per-file workers would cross-contaminate the suite). Callers with a
 * VERIFIED token are bucketed per userId; anonymous and unverifiable requests
 * share the resolved-IP bucket (never the spoofable X-Forwarded-For) — D1-01.
 * `max` is the global ceiling per minute; per-route ceilings (auth, OTP)
 * inherit everything else, `skipOnError` included.
 */
export function rateLimitOptions(opts: {
  store?: Redis;
  verify: (token: string) => RateLimitPrincipal | Promise<RateLimitPrincipal>;
  max: number;
}): RateLimitPluginOptions {
  return {
    ...(opts.store ? { redis: opts.store, nameSpace: RATE_LIMIT_NAMESPACE } : {}),
    keyGenerator: rateLimitKey(opts.verify),
    max: opts.max,
    timeWindow: '1 minute',
    skipOnError: true,
  };
}

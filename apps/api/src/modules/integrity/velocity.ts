import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { AppError } from '../../utils/errors';
import { algoValue, ALGO_DEFAULTS } from '../algo/algo-config';
import { clusterRootId } from './identity.service';
import { velocityCounter } from '../../plugins/observability';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// VELOCITY — how many times one person (their account, their identity
// cluster, their device, their IP) may try an action inside a window.
//
// [R048-007] Three things this used to get wrong, each fixed here:
//   - the counter was INCR then EXPIRE in two round trips: a crash between them
//     left a key with no TTL, a window that never ended. The bump is now one
//     Lua script — increment and (only on the first hit) expire, atomically.
//   - keys carried raw identifiers (user ids, device ids, IP addresses) into
//     Redis. They are now HMAC'd with a server secret: the key still counts
//     the same person and reveals nobody.
//   - a Redis outage failed OPEN for every surface. A burst beating a broken
//     checkout is the right call for a promo code; it is the wrong call for a
//     payout destination. Money and identity surfaces now fail CLOSED
//     (503 CONTROL_UNAVAILABLE, counted); everything else keeps failing open,
//     counted.
// ---------------------------------------------------------------------------

export interface VelocityLimit {
  max: number;
  perSeconds: number;
  /** A cap for the whole identity cluster / IP — one person, several accounts, one budget. */
  clusterMax?: number;
}

export interface VelocityActor {
  userId?: string | null;
  clusterId?: string | null;
  deviceId?: string | null;
  ip?: string | null;
}

export interface VelocityVerdict {
  allowed: boolean;
  remaining: number;
  retryAfterS: number;
  limitedBy: 'actor' | 'cluster' | 'device' | 'ip' | null;
  exempt: boolean;
  /** [R048-007] The control itself was unavailable and the surface fails closed. */
  controlUnavailable?: boolean;
}

/** Safety actions are never throttled — a person reaching for help is not a burst. */
export function isSafetyAction(action: string): boolean {
  return action.startsWith('safety.') || action.startsWith('sos');
}

/** [R048-007] Surfaces where an unavailable control is a refusal, not a pass. */
export const MONEY_SURFACE_PREFIXES = ['money.', 'payout.', 'mmg.', 'identity.', 'billing.'] as const;
export function failsClosed(action: string): boolean {
  return MONEY_SURFACE_PREFIXES.some((p) => action.startsWith(p));
}

const velocitySecret = (env: Record<string, string | undefined> = process.env): string =>
  env['VELOCITY_KEY_SECRET'] ?? env['JWT_SECRET'] ?? 'dev-velocity-key-secret';

/** An identifier as it appears in a Redis key: HMAC'd, truncated — the same person hashes the same, and reveals nothing. */
export function hashVelocityId(id: string, env?: Record<string, string | undefined>): string {
  return createHmac('sha256', velocitySecret(env)).update(id).digest('hex').slice(0, 32);
}

export function velocityKey(dimension: string, id: string, action: string, windowStart: number, env?: Record<string, string | undefined>): string {
  return `vel:${action}:${dimension}:${hashVelocityId(id, env)}:${windowStart}`;
}

/** Increment and, only on the first hit, set the window's expiry — one atomic script. */
export const VELOCITY_BUMP_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c
`;

export function resolveLimit(
  action: string,
  configured: Record<string, VelocityLimit> | null | undefined,
): VelocityLimit | null {
  const defaults = ALGO_DEFAULTS['velocity.limits'] as Record<string, VelocityLimit>;
  const merged = { ...defaults, ...(configured ?? {}) };
  const limit = merged[action];
  if (!limit || !(limit.max > 0) || !(limit.perSeconds > 0)) return null;
  return limit;
}

export async function checkVelocity(
  deps: { redis: Redis; prisma?: PrismaClient },
  input: { action: string; actor: VelocityActor; now?: Date },
): Promise<VelocityVerdict> {
  const open: VelocityVerdict = { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterS: 0, limitedBy: null, exempt: false };
  if (isSafetyAction(input.action)) return { ...open, exempt: true };
  let configured: Record<string, VelocityLimit> | null = null;
  if (deps.prisma) {
    try { configured = (await algoValue(deps.prisma, 'velocity.limits')) as Record<string, VelocityLimit>; } catch { configured = null; }
  }
  const limit = resolveLimit(input.action, configured);
  if (!limit) return open;
  const now = input.now ?? new Date();
  const windowStart = Math.floor(now.getTime() / 1000 / limit.perSeconds) * limit.perSeconds;
  const ttl = Math.max(1, windowStart + limit.perSeconds - Math.floor(now.getTime() / 1000));
  const dimensions: Array<{ name: VelocityVerdict['limitedBy'] & string; id: string | null | undefined; max: number }> = [
    { name: 'actor', id: input.actor.userId, max: limit.max },
    { name: 'cluster', id: input.actor.clusterId, max: limit.clusterMax ?? limit.max },
    { name: 'device', id: input.actor.deviceId, max: limit.max },
    { name: 'ip', id: input.actor.ip, max: limit.clusterMax ?? limit.max },
  ];
  let remaining = Number.POSITIVE_INFINITY;
  let limitedBy: VelocityVerdict['limitedBy'] = null;
  try {
    for (const d of dimensions) {
      if (!d.id) continue;
      const key = velocityKey(d.name, d.id, input.action, windowStart);
      const count = Number(await deps.redis.eval(VELOCITY_BUMP_LUA, 1, key, String(ttl)));
      const left = d.max - count;
      if (left < remaining) remaining = left;
      if (count > d.max && limitedBy === null) limitedBy = d.name;
    }
  } catch (err) {
    if (failsClosed(input.action)) {
      velocityCounter.labels('fail_closed').inc();
      log().error({ err, action: input.action }, 'velocity: redis unavailable on a money surface — failing CLOSED');
      return { allowed: false, remaining: 0, retryAfterS: 30, limitedBy: null, exempt: false, controlUnavailable: true };
    }
    velocityCounter.labels('fail_open').inc();
    log().warn({ err, action: input.action }, 'velocity: redis unavailable — failing open');
    return open;
  }
  if (limitedBy) {
    velocityCounter.labels('limited').inc();
    return { allowed: false, remaining: 0, retryAfterS: ttl, limitedBy, exempt: false };
  }
  velocityCounter.labels('allowed').inc();
  return { allowed: true, remaining: Math.max(0, remaining), retryAfterS: 0, limitedBy: null, exempt: false };
}

/** The verdict for THIS request, thrown as the platform's error when refused. Callable inline (a money field on a wider route) or as a preHandler. */
export async function assertVelocity(app: FastifyInstance, request: FastifyRequest, action: string): Promise<void> {
  const userId = (request as FastifyRequest & { user?: { userId?: string } }).user?.userId ?? null;
  const clusterId = userId ? await clusterRootId(app.prisma, userId).catch(() => null) : null;
  const deviceHeader = request.headers['x-device-id'];
  const verdict = await checkVelocity(
    { redis: app.redis, prisma: app.prisma },
    { action, actor: { userId, clusterId, deviceId: typeof deviceHeader === 'string' ? deviceHeader.slice(0, 64) : null, ip: request.ip } },
  );
  if (verdict.controlUnavailable) {
    throw new AppError(503, 'CONTROL_UNAVAILABLE', 'This change cannot be checked right now; nothing was changed. Try again in a moment.');
  }
  if (!verdict.allowed) {
    throw new AppError(429, 'VELOCITY_LIMIT', `Too many tries — wait ${Math.ceil(verdict.retryAfterS / 60)} minute${verdict.retryAfterS > 90 ? 's' : ''} and try again.`);
  }
}

export function velocityGuard(app: FastifyInstance, action: string) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await assertVelocity(app, request, action);
  };
}

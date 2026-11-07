import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { AppError } from '../../utils/errors';
import { algoValue, ALGO_DEFAULTS } from '../algo/algo-config';
import { identityAuthority } from './identity-review';
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

export const ORDER_PLACE_ACTION = 'order.place';

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
  const authority = userId ? await identityAuthority(app.prisma, userId) : null;
  // Retain account/device/IP velocity; do not charge an ambiguous shared counter.
  const clusterId = authority?.status === 'RESOLVED' ? authority.clusterId : null;
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

/**
 * [FULL-LAUNCH · owner ruling 5 Nov 2026] The limit on placing orders: store orders and parcels (a ride is held to one
 * active ride). The person and their identity cluster, never the IP or the device: Guyana's carriers put many customers
 * behind one address, so assertVelocity's IP count would throttle strangers. Redis down fails open like every surface
 * outside MONEY_SURFACE_PREFIXES.
 *
 * It counts orders, not attempts. The reservation is all-or-nothing across both keys, so a refused attempt spends
 * nothing and a shared cluster budget is never touched by one person's refused taps; the caller gives a reservation
 * back when the order was CONFIRMED rolled back, and never when its outcome is unknown or after it committed.
 */
export interface OrderPlacementBudget {
  limit: VelocityLimit;
  userId: string;
  clusterId: string | null;
}

/** The two keys of this hour, as checkVelocity names them. */
export interface OrderPlacementReservation {
  keys: string[];
  orders: number;
}

/** Reserve ARGV[2] from every key, or none: each key's ceiling is ARGV[3..]. Returns 0, or the first key that is full. */
export const ORDER_RESERVE_LUA = `
local n = tonumber(ARGV[2])
for i, key in ipairs(KEYS) do
  if (tonumber(redis.call('GET', key)) or 0) + n > tonumber(ARGV[2 + i]) then return i end
end
for _, key in ipairs(KEYS) do
  if redis.call('INCRBY', key, n) == n then redis.call('EXPIRE', key, ARGV[1]) end
end
return 0
`;

/** Give a reservation back. A key the window already took stays gone, and no count goes below zero. */
export const ORDER_REFUND_LUA = `
for _, key in ipairs(KEYS) do
  if (tonumber(redis.call('GET', key)) or 0) >= tonumber(ARGV[1]) then redis.call('DECRBY', key, ARGV[1]) end
end
return 0
`;

/** The database reads a reservation needs. Apart from it, so a caller can reserve inside its transaction: on the
 *  tenant wall a read of a non-tenant model must not run inside a caller's transaction. Null: no limit configured. */
export async function readOrderPlacementBudget(deps: { prisma: PrismaClient }, userId: string): Promise<OrderPlacementBudget | null> {
  let configured: Record<string, VelocityLimit> | null = null;
  try { configured = (await algoValue(deps.prisma, 'velocity.limits')) as Record<string, VelocityLimit>; } catch { configured = null; }
  const limit = resolveLimit(ORDER_PLACE_ACTION, configured);
  if (!limit) return null;
  const authority = await identityAuthority(deps.prisma, userId);
  return { limit, userId, clusterId: authority.status === 'RESOLVED' ? authority.clusterId : null };
}

/** Redis only. Null: nothing was reserved, because no limit is set or Redis is down (fail open). */
export async function reserveOrderPlacement(
  redis: Redis,
  budget: OrderPlacementBudget | null,
  orders = 1,
  now = new Date(),
): Promise<OrderPlacementReservation | null> {
  if (!budget) return null;
  const { limit, userId, clusterId } = budget;
  const seconds = Math.floor(now.getTime() / 1000);
  const windowStart = Math.floor(seconds / limit.perSeconds) * limit.perSeconds;
  const ttl = Math.max(1, windowStart + limit.perSeconds - seconds);
  const keys = [velocityKey('actor', userId, ORDER_PLACE_ACTION, windowStart)];
  const ceilings = [limit.max];
  if (clusterId) {
    keys.push(velocityKey('cluster', clusterId, ORDER_PLACE_ACTION, windowStart));
    ceilings.push(limit.clusterMax ?? limit.max);
  }
  let full: number;
  try {
    full = Number(await redis.eval(ORDER_RESERVE_LUA, keys.length, ...keys, String(ttl), String(orders), ...ceilings.map(String)));
  } catch (err) {
    velocityCounter.labels('fail_open').inc();
    log().warn({ err, action: ORDER_PLACE_ACTION }, 'velocity: redis unavailable — failing open');
    return null;
  }
  if (full > 0) {
    velocityCounter.labels('limited').inc();
    const minutes = Math.ceil(ttl / 60);
    throw new AppError(429, 'VELOCITY_LIMIT', `Too many orders in a short time — wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`);
  }
  velocityCounter.labels('allowed').inc();
  return { keys, orders };
}

/** The order was confirmed rolled back: its reservation comes back. A failed refund leaves the spend, logged. */
export async function refundOrderPlacement(redis: Redis, reservation: OrderPlacementReservation | null): Promise<void> {
  if (!reservation) return;
  await redis.eval(ORDER_REFUND_LUA, reservation.keys.length, ...reservation.keys, String(reservation.orders))
    .catch((err: unknown) => log().warn({ err, action: ORDER_PLACE_ACTION }, 'velocity: an order reservation could not be given back'));
}

export function velocityGuard(app: FastifyInstance, action: string) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await assertVelocity(app, request, action);
  };
}

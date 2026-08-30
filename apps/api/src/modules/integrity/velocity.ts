import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { AppError } from '../../utils/errors';
import { algoValue, ALGO_DEFAULTS } from '../algo/algo-config';
import { clusterRootId } from './identity.service';
import { log } from '../../utils/logger';

/**
 * [ALG-38] The generic velocity engine.
 *
 * Per-surface limits exist — OTP per hour, the daily SMS budget, the IP
 * ceiling. This replaces none of them; it covers the surfaces nobody thought
 * about, with one call:
 *
 *   checkVelocity(deps, { action, actor }) → { allowed, remaining, retryAfterS }
 *
 * Fixed windows in Redis, keyed by actor, identity CLUSTER, device and IP.
 * The cluster key matters most: per-account limits are trivially defeated by
 * making accounts, and the identity graph already knows which accounts are
 * one person. Limits per action live in AlgoConfig `velocity.limits`.
 *
 * Two exemptions, absolute: SOS and any safety action are never rate-limited
 * (LHC-1 K2) — an action named `safety.*` or `sos*` returns allowed before a
 * single key is read, whatever the config says. And a step-up OTP for an
 * existing session must not share a bucket with a signup OTP: the OTP
 * limiter keys by phone today; when it moves here, those are two actions.
 *
 * Redis trouble fails OPEN: a velocity engine that could take a checkout
 * down with it would be worse than a burst.
 */

export interface VelocityLimit {
  max: number;
  perSeconds: number;
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
}

export function isSafetyAction(action: string): boolean {
  return action.startsWith('safety.') || action.startsWith('sos');
}

export function velocityKey(dimension: string, id: string, action: string, windowStart: number): string {
  return `vel:${action}:${dimension}:${id}:${windowStart}`;
}

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
  const ttl = windowStart + limit.perSeconds - Math.floor(now.getTime() / 1000);

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
      const count = await deps.redis.incr(key);
      if (count === 1) await deps.redis.expire(key, Math.max(1, ttl));
      const left = d.max - count;
      if (left < remaining) remaining = left;
      if (count > d.max && limitedBy === null) limitedBy = d.name;
    }
  } catch (err) {
    log().warn({ err, action: input.action }, 'velocity: redis unavailable — failing open');
    return open;
  }
  if (limitedBy) return { allowed: false, remaining: 0, retryAfterS: Math.max(1, ttl), limitedBy, exempt: false };
  return { allowed: true, remaining: Math.max(0, remaining), retryAfterS: 0, limitedBy: null, exempt: false };
}

/** Fastify preHandler: refuse with 429 VELOCITY_LIMIT when the actor (or their
 *  identity cluster) has done this too often. Reads the authenticated user
 *  when there is one, the proxy-resolved IP always. */
export function velocityGuard(app: FastifyInstance, action: string) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const userId = (request as FastifyRequest & { user?: { userId?: string } }).user?.userId ?? null;
    const clusterId = userId ? await clusterRootId(app.prisma, userId).catch(() => null) : null;
    const deviceHeader = request.headers['x-device-id'];
    const verdict = await checkVelocity(
      { redis: app.redis, prisma: app.prisma },
      { action, actor: { userId, clusterId, deviceId: typeof deviceHeader === 'string' ? deviceHeader.slice(0, 64) : null, ip: request.ip } },
    );
    if (!verdict.allowed) {
      throw new AppError(429, 'VELOCITY_LIMIT', `Too many tries — wait ${Math.ceil(verdict.retryAfterS / 60)} minute${verdict.retryAfterS > 90 ? 's' : ''} and try again.`, { retryAfterS: verdict.retryAfterS });
    }
  };
}

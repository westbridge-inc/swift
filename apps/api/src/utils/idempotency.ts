import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { AppError } from './errors';
import { getTenantId } from '../plugins/tenant-context';

/** [MASTER-008] Who is asking: the authenticated user, in the tenant bound to
 *  this request. A stored result is only ever replayed to the SAME principal,
 *  so a key learnt or guessed by anyone else names nothing of theirs. There is
 *  no shared "anonymous" principal: a keyed request with no authenticated user
 *  is refused, so an unauthenticated route can never share stored results. */
function principalOf(request: FastifyRequest): string {
  const user = (request as { user?: { userId?: unknown } }).user;
  if (typeof user?.userId !== 'string' || user.userId === '') {
    throw new AppError(500, 'IDEMPOTENCY_PRINCIPAL_REQUIRED', 'Idempotent replay needs an authenticated user; this route has none.');
  }
  return `${getTenantId() ?? '-'}:${user.userId}`;
}

/** [MASTER-008] The request body's canonical fingerprint (sorted keys at every
 *  depth): one key names ONE command, so the same key with a different body is
 *  refused rather than answered with another command's result. */
function bodyFingerprint(body: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(sort(body ?? null)) ?? 'null').digest('hex');
}

/** The cache key for this request, or null when it carries no usable
 *  Idempotency-Key. Bound to the scope, the subject, the principal and the key. */
export function idempotencyCacheKey(request: FastifyRequest, scope: string, subjectId: string): string | null {
  const idemKey = request.headers['idempotency-key'];
  return typeof idemKey === 'string' && idemKey.length >= 8 && idemKey.length <= 128
    ? `${scope}:idem:${subjectId}:${principalOf(request)}:${idemKey}`
    : null;
}

/**
 * Request-level idempotency for money/order-mutating endpoints (standing order
 * 5). With an `Idempotency-Key` header the first request claims the key
 * atomically for 24h; a concurrent duplicate is refused (409 DUPLICATE_REQUEST)
 * and a later replay gets the STORED result back instead of re-running the
 * effect (which, on a completed order, would otherwise fail the state-machine
 * transition and surface as an error to a client that merely retried a flaky
 * network). Without the header the effect just runs — idempotency is opt-in, so
 * existing clients are unchanged. A failed run RELEASES the claim so a corrected
 * retry can proceed. Generalizes the pattern /checkout has inlined; scope the
 * key by the resource being mutated so a reused key can't cross operations.
 * [MASTER-008] The key is also bound to the principal (tenant + user) and the
 * stored result to the request body: a replay goes only to the same principal
 * for the same request, and the caller authorizes the subject first.
 *
 * Callers authorize the subject BEFORE calling this: a replay returns the
 * stored result without running `run`, so a check inside `run` never runs on
 * a replay. [MASTER-008]
 */
export async function withIdempotency<T>(
  app: FastifyInstance,
  request: FastifyRequest,
  scope: string,
  subjectId: string,
  run: () => Promise<T>,
): Promise<{ data: T; replayed: boolean }> {
  const redisKey = idempotencyCacheKey(request, scope, subjectId);
  if (!redisKey) return { data: await run(), replayed: false };
  const body = bodyFingerprint(request.body);

  const claimed = await app.redis.set(redisKey, 'IN_FLIGHT', 'EX', 86_400, 'NX');
  if (claimed !== 'OK') {
    const existing = await app.redis.get(redisKey);
    if (existing && existing !== 'IN_FLIGHT') {
      const stored = JSON.parse(existing) as { body?: unknown; data?: T };
      if (stored.body !== body) {
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request — use a new key for a new request.');
      }
      return { data: stored.data as T, replayed: true };
    }
    throw new AppError(409, 'DUPLICATE_REQUEST', 'This request is already being processed — hold on.');
  }
  try {
    const data = await run();
    // Best-effort store: the effect already happened; a failed store just means
    // a replay re-runs (and the state machine no-ops or 409s), never double-acts.
    await app.redis.set(redisKey, JSON.stringify({ body, data }), 'EX', 86_400).catch(() => {});
    return { data, replayed: false };
  } catch (err) {
    // The effect did not complete — release the claim so a corrected retry (or a
    // genuine second attempt) is not blocked for the full 24h window.
    await app.redis.del(redisKey).catch(() => {});
    throw err;
  }
}

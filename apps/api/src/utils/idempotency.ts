import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from './errors';

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
 */
export async function withIdempotency<T>(
  app: FastifyInstance,
  request: FastifyRequest,
  scope: string,
  subjectId: string,
  run: () => Promise<T>,
): Promise<{ data: T; replayed: boolean }> {
  const idemKey = request.headers['idempotency-key'];
  const redisKey =
    typeof idemKey === 'string' && idemKey.length >= 8 && idemKey.length <= 128
      ? `${scope}:idem:${subjectId}:${idemKey}`
      : null;
  if (!redisKey) return { data: await run(), replayed: false };

  const claimed = await app.redis.set(redisKey, 'IN_FLIGHT', 'EX', 86_400, 'NX');
  if (claimed !== 'OK') {
    const existing = await app.redis.get(redisKey);
    if (existing && existing !== 'IN_FLIGHT') {
      return { data: JSON.parse(existing) as T, replayed: true };
    }
    throw new AppError(409, 'DUPLICATE_REQUEST', 'This request is already being processed — hold on.');
  }
  try {
    const data = await run();
    // Best-effort store: the effect already happened; a failed store just means
    // a replay re-runs (and the state machine no-ops or 409s), never double-acts.
    await app.redis.set(redisKey, JSON.stringify(data), 'EX', 86_400).catch(() => {});
    return { data, replayed: false };
  } catch (err) {
    // The effect did not complete — release the claim so a corrected retry (or a
    // genuine second attempt) is not blocked for the full 24h window.
    await app.redis.del(redisKey).catch(() => {});
    throw err;
  }
}

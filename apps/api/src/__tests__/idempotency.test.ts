import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withIdempotency } from '../utils/idempotency';

// Request-level idempotency for money endpoints: claim-first (so concurrent
// duplicates can't both act), replay the stored result, release on failure.

function mockRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (k: string, v: string, _ex?: string, _ttl?: number, nx?: string) => {
      if (nx === 'NX' && store.has(k)) return null; // atomic SET NX
      store.set(k, v);
      return 'OK';
    }),
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
  };
}
const req = (key?: string) => ({ headers: key ? { 'idempotency-key': key } : {} }) as unknown as FastifyRequest;
const appWith = (redis: ReturnType<typeof mockRedis>) => ({ redis }) as unknown as FastifyInstance;
const KEY = 'key-abcdef12';

describe('withIdempotency', () => {
  it('no Idempotency-Key header → runs the effect once, never touches redis', async () => {
    const redis = mockRedis();
    let ran = 0;
    const { data, replayed } = await withIdempotency(appWith(redis), req(), 'op', 'o1', async () => { ran++; return { ok: 1 }; });
    expect(ran).toBe(1);
    expect(replayed).toBe(false);
    expect(data).toEqual({ ok: 1 });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('first call runs + stores; a replay returns the STORED result WITHOUT re-running', async () => {
    const redis = mockRedis();
    let ran = 0;
    const run = async () => { ran++; return { orderId: 'o1', n: ran }; };
    const first = await withIdempotency(appWith(redis), req(KEY), 'op', 'o1', run);
    expect(first).toEqual({ data: { orderId: 'o1', n: 1 }, replayed: false });
    const replay = await withIdempotency(appWith(redis), req(KEY), 'op', 'o1', run);
    expect(ran).toBe(1); // the effect ran EXACTLY once
    expect(replay).toEqual({ data: { orderId: 'o1', n: 1 }, replayed: true });
  });

  it('a concurrent duplicate (claimed, result not stored yet) is refused with 409', async () => {
    const redis = mockRedis();
    await redis.set('op:idem:o1:' + KEY, 'IN_FLIGHT', 'EX', 100, 'NX'); // another request holds it
    await expect(
      withIdempotency(appWith(redis), req(KEY), 'op', 'o1', async () => ({ ok: 1 })),
    ).rejects.toMatchObject({ statusCode: 409, code: 'DUPLICATE_REQUEST' });
  });

  it('a FAILED effect releases the claim so a corrected retry proceeds', async () => {
    const redis = mockRedis();
    await expect(
      withIdempotency(appWith(redis), req(KEY), 'op', 'o1', async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    expect(redis.store.has('op:idem:o1:' + KEY)).toBe(false); // released, not left IN_FLIGHT
    let ran = 0;
    const retry = await withIdempotency(appWith(redis), req(KEY), 'op', 'o1', async () => { ran++; return { ok: 1 }; });
    expect(ran).toBe(1);
    expect(retry.replayed).toBe(false);
  });

  it('a too-short / oversized key is ignored (runs, no dedup)', async () => {
    const redis = mockRedis();
    let ran = 0;
    await withIdempotency(appWith(redis), req('short'), 'op', 'o1', async () => { ran++; return { ok: 1 }; });
    expect(ran).toBe(1);
    expect(redis.set).not.toHaveBeenCalled();
  });
});

import type { FastifyInstance } from 'fastify';
import { ORDER_PLACE_ACTION } from '../integrity/velocity';
import { findCheckoutReceipt } from '../order/checkout-outbox';
import { testControlIdentity } from './test-control';

/** [SCR-003 / SCR-004] Registered ONLY when `testControlEnabled()`; production never has these routes. */
export async function testControlRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  app.get('/test-control/identity', auth, async () => ({ success: true, data: await testControlIdentity(app.prisma) }));
  // [SCR-004] The read-only verifier: the caller's own checkout receipt for a key — exact order-set cardinality,
  // never a status code. A key with no receipt is 404, which is itself a verdict (no command was recorded).
  app.get<{ Params: { key: string } }>('/test-control/checkout/:key', auth, async (request, reply) => {
    const receipt = await findCheckoutReceipt(app.prisma, request.user.userId, request.params.key);
    if (!receipt) { reply.code(404); return { success: false, error: { code: 'NO_RECEIPT', message: 'no checkout command was recorded for this key' } }; }
    return { success: true, data: { requestHash: receipt.requestHash, orderIds: receipt.orderIds, orderCount: receipt.orderIds.length } };
  });
  // [FULL-LAUNCH] A journey suite reuses its accounts, so a rerun inside one clock hour would start at the order limit.
  // Its budget is cleared here, at suite start. The limit itself is not raised, and production has no such route.
  app.post('/test-control/order-place-budget/reset', auth, async () => {
    let cleared = 0;
    let cursor = '0';
    do {
      const [next, keys] = await app.redis.scan(cursor, 'MATCH', `vel:${ORDER_PLACE_ACTION}:*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) cleared += await app.redis.del(...keys);
    } while (cursor !== '0');
    return { success: true, data: { cleared } };
  });
}

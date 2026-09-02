import type { FastifyInstance } from 'fastify';
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
}

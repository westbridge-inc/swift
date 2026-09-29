import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { TERMINAL_ORDER_STATUSES } from '../order/order-status';
import { log } from '../../utils/logger';
import { dispatchMoverOfferKey, dispatchOfferKey } from './dispatch-generation-keys';

// ---------------------------------------------------------------------------
// [DISPATCH 1/3 · B4] THE ONE POINT WHERE A CLOSED ORDER LOSES ITS OFFER CARD.
//
// A cancellation committed the order to CANCELLED and left its live offer in
// Redis. The mover it rang kept a working card for the rest of the countdown,
// and their reverse pointer kept them from being offered anything else until
// the pair expired. The customer cancel was the case reported; every other
// cancellation left the same card behind: the courier sender, the store
// rejecting, an admin, the no-response auto-cancel, the taxi released for lack
// of drivers, the food-age cutoff.
//
// Every writer that commits an order to CANCELLED calls this AFTER its commit:
//   * the canonical transition seam (OrderService.transitionOrderAtomically,
//     for every operational cancellation it commits),
//   * the customer cancel (OrderService.cancelOrder, its own transaction),
//   * the two compare-and-set writers that bypass the seam: the taxi released
//     for lack of drivers (dispatch.service) and the food-age cutoff (rescue).
// offer-withdrawal-census.test.ts fails the build when a new CANCELLED writer
// skips it.
//
// PostgreSQL decides, never Redis: nothing is removed unless the order is
// terminal now, and only the exact pair read here (compare-and-delete) — a
// card written after a reopening is somebody else's to keep. Best-effort by
// design: the order has already committed, and an accept of a closed order is
// refused on its own (ORDER_CANCELLED) whether or not this ran.
// ---------------------------------------------------------------------------

export interface OfferWithdrawalDeps {
  prisma: Pick<PrismaClient, 'order'>;
  redis: Pick<Redis, 'get' | 'eval'>;
}

export async function withdrawOfferOfClosedOrder(deps: OfferWithdrawalDeps, orderId: string): Promise<boolean> {
  try {
    const order = await deps.prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
    if (!order || !TERMINAL_ORDER_STATUSES.includes(order.status)) return false;
    const forward = dispatchOfferKey(orderId);
    const live = await deps.redis.get(forward);
    if (!live) return false;
    // `<moverId>:<attemptId>`; a bare mover id is a card from before attempts.
    const colon = live.indexOf(':');
    const moverId = colon === -1 ? live : live.slice(0, colon);
    const reverseValue = colon === -1 ? orderId : `${orderId}:${live.slice(colon + 1)}`;
    const removed = await deps.redis.eval(
      `
        -- WITHDRAW_CLOSED_ORDER_OFFER: only the exact pair read above.
        if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
        redis.call('DEL', KEYS[1])
        if redis.call('GET', KEYS[2]) == ARGV[2] then
          redis.call('DEL', KEYS[2])
        end
        return 1
      `,
      2,
      forward,
      dispatchMoverOfferKey(moverId),
      live,
      reverseValue,
    );
    return Number(removed) === 1;
  } catch (err) {
    try {
      log().warn({ err, orderId }, 'dispatch: offer withdrawal after the order closed failed');
    } catch {
      // The order is closed either way; the card expires with its countdown.
    }
    return false;
  }
}

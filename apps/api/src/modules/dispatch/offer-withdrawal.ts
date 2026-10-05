import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { Server } from 'socket.io';
import { TERMINAL_ORDER_STATUSES } from '../order/order-status';
import { log } from '../../utils/logger';
import { dispatchMoverOfferKey, dispatchOfferKey, dispatchWithdrawnCardsKey, WITHDRAWN_CARD_SCREEN_SKEW_MS } from './dispatch-generation-keys';

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
//
// [AX299 F2] Freeing the mover at once means the next offer can ring a second
// later, while the withdrawn card is still on their screen. So the point also
//   * tells the mover's app which card went (`dispatch:offer_withdrawn`, keyed
//     by order AND attempt), and the app drops exactly that card;
//   * records when that card was withdrawn and until when it could still be
//     showing, should the event never arrive: an offer sent to the mover in
//     that interval is never charged as an ignored one
//     (DispatchService.shadowedByWithdrawnCard). [AX310] Recorded whenever the
//     reader could still match it: the card's deadline plus the screen skew is
//     ahead, even when its server deadline itself has passed (a late worker).
// ---------------------------------------------------------------------------

export interface OfferWithdrawalDeps {
  prisma: Pick<PrismaClient, 'order' | 'rider' | 'driver'>;
  redis: Pick<Redis, 'get' | 'eval'>;
  /** The mover's app is told which card went. Required: a withdrawal the app
   *  never hears about leaves the dead card on top of its queue. */
  io: Pick<Server, 'to'>;
}

/** The mover-app event that retires ONE card: its order and its attempt. */
export const OFFER_WITHDRAWN_EVENT = 'dispatch:offer_withdrawn';
export interface OfferWithdrawnPayload {
  orderId: string;
  offerAttemptId: string | null;
  reason: 'ORDER_CANCELLED' | 'ORDER_CLOSED';
}

/** The pair's TTL carries a ten-second worker grace tail beyond the card's own
 *  deadline (dispatch.service liveOfferDeadline); the screen never shows it. */
const CARD_GRACE_TAIL_MS = 10_000;
/** How long past the withdrawn card's deadline its record is kept: longer than
 *  any next card's window plus that grace tail, so its timeout still finds it. */
const WITHDRAWN_CARD_RETENTION_MS = 60_000;

export async function withdrawOfferOfClosedOrder(deps: OfferWithdrawalDeps, orderId: string): Promise<boolean> {
  try {
    const order = await deps.prisma.order.findUnique({ where: { id: orderId }, select: { status: true, orderType: true } });
    if (!order || !TERMINAL_ORDER_STATUSES.includes(order.status)) return false;
    const forward = dispatchOfferKey(orderId);
    const live = await deps.redis.get(forward);
    if (!live) return false;
    // `<moverId>:<attemptId>`; a bare mover id is a card from before attempts.
    const colon = live.indexOf(':');
    const moverId = colon === -1 ? live : live.slice(0, colon);
    const attemptId = colon === -1 ? null : live.slice(colon + 1);
    const reverseValue = colon === -1 ? orderId : `${orderId}:${attemptId}`;
    const removed = await deps.redis.eval(
      `
        -- WITHDRAW_CLOSED_ORDER_OFFER: only the exact pair read above.
        if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
        local ttl = redis.call('PTTL', KEYS[1])
        redis.call('DEL', KEYS[1])
        if redis.call('GET', KEYS[2]) == ARGV[2] then
          redis.call('DEL', KEYS[2])
        end
        -- [AX299 F2 · AX310] The withdrawn card's own server deadline (its
        -- remaining TTL less the grace tail), recorded with the moment it was
        -- withdrawn, whenever it could still be on screen by the reader's rule:
        -- deadline + skew still ahead. Old records are trimmed as it goes.
        if ttl > 0 then
          local now = tonumber(ARGV[3])
          local deadline = now + ttl - tonumber(ARGV[4])
          local skew = tonumber(ARGV[6])
          if deadline + skew > now then
            local retention = tonumber(ARGV[5])
            redis.call('ZADD', KEYS[3], deadline, ARGV[3] .. ':' .. ARGV[7])
            redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - skew - retention)
            local keep = deadline + skew + retention - now
            if redis.call('PTTL', KEYS[3]) < keep then
              redis.call('PEXPIRE', KEYS[3], keep)
            end
          end
        end
        return 1
      `,
      3,
      forward,
      dispatchMoverOfferKey(moverId),
      dispatchWithdrawnCardsKey(moverId),
      live,
      reverseValue,
      String(Date.now()),
      String(CARD_GRACE_TAIL_MS),
      String(WITHDRAWN_CARD_RETENTION_MS),
      String(WITHDRAWN_CARD_SCREEN_SKEW_MS),
      `${orderId}:${attemptId ?? ''}`,
    );
    if (Number(removed) !== 1) return false;
    await tellTheMover(deps, order, moverId, { orderId, offerAttemptId: attemptId, reason: order.status === 'CANCELLED' ? 'ORDER_CANCELLED' : 'ORDER_CLOSED' });
    return true;
  } catch (err) {
    try {
      log().warn({ err, orderId }, 'dispatch: offer withdrawal after the order closed failed');
    } catch {
      // The order is closed either way; the card expires with its countdown.
    }
    return false;
  }
}

/** The card is gone from Redis; the mover's app hears which one. Taxi cards
 *  ring drivers, every other card a rider (dispatch.service poolForOrder). A
 *  failure here leaves the marker above as the guard. */
async function tellTheMover(
  deps: OfferWithdrawalDeps,
  order: { orderType: string },
  moverId: string,
  payload: OfferWithdrawnPayload,
): Promise<void> {
  try {
    const mover = order.orderType === 'TAXI'
      ? await deps.prisma.driver.findUnique({ where: { id: moverId }, select: { userId: true } })
      : await deps.prisma.rider.findUnique({ where: { id: moverId }, select: { userId: true } });
    if (!mover) return;
    deps.io.to(`user:${mover.userId}`).emit(OFFER_WITHDRAWN_EVENT, payload);
  } catch (err) {
    try {
      log().warn({ err, orderId: payload.orderId, moverId }, 'dispatch: the withdrawn card could not be announced to the mover app');
    } catch {
      // The screen guard (the marker) still spares the next card.
    }
  }
}

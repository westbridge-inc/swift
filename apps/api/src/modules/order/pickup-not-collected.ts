import type { Order, Prisma, PrismaClient } from '@prisma/client';
import { ownerRlsBindEnabled } from '../../lib/owner-rls';
import { insertTicketFor, orderCaseExists } from '../../lib/owner-wall-tickets';
import { bindTenantTransaction } from '../../plugins/prisma';
import { AppError } from '../../utils/errors';
import { isPickupNotCollected, PICKUP_NOT_COLLECTED_AFTER_HOURS } from './cancel-policy';

// ---------------------------------------------------------------------------
// [BUG-HUNT-2 G20 · COORD 4 Nov 2026] A PICKUP NOBODY COLLECTED.
//
// A store marks a pickup ready and the customer never comes. Nothing closed it: the customer was told to contact the
// store, the store's reject refuses a ready order, and the only way off the board was a false "picked up". Nobody is
// stuck now, and the record is true:
//
//   - from 24 hours (cancel-policy isPickupNotCollected) the store records "Not collected";
//   - a CASH order closes through the one canonical cancel. No money was paid, so none moves; no fee, no strike;
//   - anything else (a paid MMG order) stays open and goes to Swift support, the store-refund close (mmg-store-close.ts):
//     Swift never decides on its own that money goes back, and the store's tap opens the one case that asks for it;
//   - the customer can cancel a cash one from 24 hours (cancel-policy);
//   - a sweep pages the store once at 24 hours and support once at 48 hours. It closes nothing itself.
// ---------------------------------------------------------------------------

/** When support is paged. */
export const PICKUP_SUPPORT_PAGE_AFTER_HOURS = 48;

/** The order's cancellation reason and its status-log note: a sentence, so every build shows it as written. */
export const NOT_COLLECTED_REASON = 'Not collected: the customer did not come for this pickup (recorded by the store).';

/** The support case's fixed subject: one per order. */
export const NOT_COLLECTED_CASE_SUBJECT = 'Paid MMG pickup not collected: close it as refund handled by the store';

export const PICKUP_UNCOLLECTED_TITLE = 'Pickup orders not collected';
export const PICKUP_UNCOLLECTED_KEY = 'ops_page:pickup-uncollected';
export const PICKUP_UNCOLLECTED_WINDOW_SECONDS = 6 * 3_600;

type PickupFacts = Pick<Order, 'status' | 'orderType' | 'fulfillment' | 'readyAt' | 'scheduledFor'>;
type MoneyFacts = Pick<Order, 'paymentMethod'>;

/** Only a cash order closes on the store's word. Any other way of paying is a person's to close. */
export function notCollectedGoesToSupport(order: MoneyFacts): boolean {
  return order.paymentMethod !== 'CASH';
}

/** Why the store may not record "Not collected" on this order now, or null when it may. */
export function notCollectedRefusal(order: PickupFacts, now: Date): AppError | null {
  if (order.fulfillment !== 'PICKUP' || order.status !== 'READY_FOR_PICKUP') {
    return new AppError(409, 'NOT_COLLECTED_NOT_OPEN', 'Only a pickup that is ready and waiting can be marked Not collected.');
  }
  if (!isPickupNotCollected(order, now)) {
    return new AppError(409, 'NOT_COLLECTED_TOO_EARLY', `You can mark a pickup Not collected ${PICKUP_NOT_COLLECTED_AFTER_HOURS} hours after it was ready.`);
  }
  return null;
}

/** The server's word for the store's screens: may "Not collected" be recorded now, and does it go to support. */
export function notCollectedView(order: PickupFacts & MoneyFacts, now: Date): { allowed: boolean; goesToSupport: boolean } {
  return { allowed: notCollectedRefusal(order, now) === null, goesToSupport: notCollectedGoesToSupport(order) };
}

/**
 * A paid order the store says nobody collected: one case for support, opened under the order lock, however often the
 * store taps. The order and its money stay exactly as they were. Null when the case was already open.
 */
export async function openNotCollectedCase(prisma: PrismaClient, orderId: string, userId: string, now: Date): Promise<{ ticketId: string; tenantId: string | null; orderNumber: string } | null> {
  return prisma.$transaction(async (tx) => {
    await bindTenantTransaction(tx);
    await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    const refusal = notCollectedRefusal(order, now);
    if (refusal) throw refusal;
    const open = ownerRlsBindEnabled()
      ? await orderCaseExists(tx, orderId, NOT_COLLECTED_CASE_SUBJECT)
      : await tx.supportTicket.findFirst({ where: { orderId, category: 'PAYMENT', subject: NOT_COLLECTED_CASE_SUBJECT }, select: { id: true } });
    if (open) return null;
    const ticket = await insertTicketFor(tx, {
      userId, orderId, category: 'PAYMENT', subject: NOT_COLLECTED_CASE_SUBJECT,
      message: `The store says order ${order.orderNumber} was never collected. It was paid by MMG, so the store refunds the customer directly. Check with both sides, then close it as refund handled by the store.`,
    });
    return { ticketId: ticket.id, tenantId: order.tenantId ?? null, orderNumber: order.orderNumber };
  });
}

/** The customer's notice: what happened and that it cost them nothing. No blame. */
export function notCollectedCustomerNotice(orderNumber: string, storeName: string) {
  return {
    title: 'Pickup not collected',
    body: `Your order ${orderNumber} was not collected, so ${storeName} closed it. No money moved and there is no fee. If that isn't right, contact Swift Support.`,
  };
}

/** The store's notice when the customer cancels it themselves. */
export function pickupCancelledStoreNotice(orderNumber: string) {
  return {
    title: 'Pickup cancelled by the customer',
    body: `The customer cancelled order ${orderNumber}, which had been waiting over a day. You don't need to keep it.`,
  };
}

/** The store's page at 24 hours. */
export function pickupUncollectedStoreNotice(order: { orderNumber: string } & MoneyFacts) {
  return {
    title: 'Pickup not collected',
    body: notCollectedGoesToSupport(order)
      ? `Order ${order.orderNumber} has been ready for a day and nobody came. If it was collected, mark it picked up. If not, tap Not collected and Swift support closes it with you, because it was paid by MMG.`
      : `Order ${order.orderNumber} has been ready for a day and nobody came. If it was collected, mark it picked up. If not, tap Not collected to close it. No money moves.`,
  };
}

/** The sweep's filter. Each row is judged again by the one predicate: a later slot moves the moment on. */
export function readyPickupsSince(before: Date): Prisma.OrderWhereInput {
  return { status: 'READY_FOR_PICKUP', fulfillment: 'PICKUP', orderType: { in: ['FOOD_DELIVERY', 'GROCERY_DELIVERY'] }, readyAt: { lte: before } };
}

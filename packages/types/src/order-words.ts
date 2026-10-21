/**
 * ONE plain-words map for what an order's system codes mean to a person
 * (UI sweep U14; COORD rulings 21 Oct 2026: web and phone never show a raw code).
 *
 * - Order statuses as a store reads them (the phone's store pill words).
 * - System cancellation reasons: the codes the server itself writes on an order
 *   (`cancellationReason`), in the server's own push wording for each reader
 *   (modules/dispatch/dispatch.service.ts, modules/dispatch/rescue.ts).
 *
 * Text a person typed (a store's reject reason, a sender's or an admin's note)
 * and the server's own sentences are kept as written. A code-shaped reason
 * (capitals, digits, underscores) never shows: a known code reads as words, an
 * unknown one as a neutral sentence.
 * Web, admin and phone all import this module from `@swift/types`.
 */
import type { OrderStatus } from './order';

type OrderStatusValue = `${OrderStatus}`;

/** A status this build has no words for. */
export const UNKNOWN_STATUS_WORDS = 'Status unavailable';

/** A cancelled order with no reason this build can put in words. */
export const ORDER_CANCELLED_WORDS = 'This order was cancelled.';

/** Every status as a store reads it. Typed by the enum: a new status without words fails to compile. */
export const STORE_ORDER_STATUS_WORDS: Readonly<Record<OrderStatusValue, string>> = {
  PENDING: 'New',
  ACCEPTED: 'Accepted',
  PREPARING: 'Preparing',
  READY_FOR_PICKUP: 'Ready',
  RIDER_ASSIGNED: 'Rider assigned',
  RIDER_EN_ROUTE_PICKUP: 'Rider en route',
  RIDER_ARRIVED_PICKUP: 'Rider at counter',
  PICKED_UP: 'Out for delivery',
  EN_ROUTE_DELIVERY: 'Out for delivery',
  ARRIVED: 'Out for delivery',
  DRIVER_ASSIGNED: 'Driver assigned',
  DRIVER_EN_ROUTE: 'Driver on the way',
  DRIVER_ARRIVED: 'Driver arrived',
  RIDE_IN_PROGRESS: 'Ride in progress',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
  FAILED: 'Could not continue',
  RETURNING: 'Returning',
  RETURNED: 'Returned',
};

/** Older spellings the store board has always accepted. */
const STORE_STATUS_ALIASES: Readonly<Record<string, OrderStatusValue>> = {
  PLACED: 'PENDING',
  CONFIRMED: 'ACCEPTED',
  READY: 'READY_FOR_PICKUP',
};

const own = (table: object, key: string) => Object.prototype.hasOwnProperty.call(table, key);

/** A status in a store's words; a status this build does not know is "Status unavailable", never the code. */
export function storeOrderStatusWords(status: unknown): string {
  const s = typeof status === 'string' ? status.trim().toUpperCase() : '';
  const key = own(STORE_STATUS_ALIASES, s) ? STORE_STATUS_ALIASES[s]! : s;
  return own(STORE_ORDER_STATUS_WORDS, key) ? STORE_ORDER_STATUS_WORDS[key as OrderStatusValue] : UNKNOWN_STATUS_WORDS;
}

export type CancellationReader = 'customer' | 'store';

/** The codes the server writes as an order's cancellation reason, per reader. */
export const SYSTEM_CANCELLATION_WORDS: Readonly<Record<string, Readonly<Record<CancellationReader, string>>>> = {
  // dispatch.service.ts: a ride request no driver took in time ("We couldn't find you a driver").
  NO_DRIVERS_AVAILABLE: {
    customer: 'No drivers came online in time, so your request was released. Nothing to pay.',
    store: 'No driver was found in time.',
  },
  // rescue.ts: ready food no rider could collect in time ("We couldn't find a rider in time").
  FOOD_TOO_OLD: {
    customer: 'Your order was ready but no rider could be found, so it was cancelled rather than delivered cold.',
    store: 'Too old to deliver: the order was ready but no rider could be found in time.',
  },
};

/** Neutral words for a code-shaped reason this build does not know (never the code). */
export const UNKNOWN_CANCELLATION_WORDS: Readonly<Record<CancellationReader, string>> = {
  customer: ORDER_CANCELLED_WORDS,
  store: 'No further details are available.',
};

/** Code-shaped: capitals, digits and underscores only ("NO_DRIVERS_AVAILABLE"). Never shown to a person. */
const SYSTEM_CODE = /^[A-Z0-9_]+$/;

/**
 * The cancellation reason in words for this reader. A known system code reads
 * as words, an unknown code-shaped reason as UNKNOWN_CANCELLATION_WORDS, and
 * any other text (typed by a store, a sender or an admin, or one of the
 * server's own sentences) is kept as written. Null only when there is no reason.
 */
export function cancellationReasonWords(reason: unknown, reader: CancellationReader): string | null {
  if (typeof reason !== 'string') return null;
  const text = reason.trim();
  if (!text) return null;
  if (own(SYSTEM_CANCELLATION_WORDS, text)) return SYSTEM_CANCELLATION_WORDS[text]![reader];
  return SYSTEM_CODE.test(text) ? UNKNOWN_CANCELLATION_WORDS[reader] : text;
}

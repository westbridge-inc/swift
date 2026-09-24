import type { Prisma } from '@prisma/client';
import { promiseView } from '../eta/promise';

/**
 * [G3-F2] The checkout command's ONE customer-facing answer.
 *
 * Before: the fresh checkout built its summary (`{ order, orders, grandTotal,
 * paymentAction, message }`) AFTER the transaction, while the durable receipt
 * written INSIDE it stored the raw created rows (`{ orders, paymentAction }`).
 * A same-key replay answered from the receipt therefore had a different shape
 * than the first answer — and exposed every internal order column
 * (`riskReason`, `subtotalBase`, `subtotalMarkup`, `customerId`, `tenantId`,
 * …) to the customer. The receipt is the source of truth whenever Redis
 * forgot, so the replay was wrong exactly when it mattered.
 *
 * Now: this module is the ONE place that shapes the answer. The checkout
 * transaction calls it with the created orders in their wire form (Decimals
 * as strings, Dates as ISO strings — the representation a JSON receipt holds)
 * and stores exactly what it returns (the receipt writer round-trips it to
 * JSON), so a replay is the first answer, field for field. A receipt written
 * BEFORE this fix held the raw rows; a replay projects that legacy result
 * through the same shaper instead of returning the rows.
 */

/** One order in wire form: exactly what the receipt column's JSON round-trip
 *  produces (`JSON.parse(JSON.stringify(created))`). All money is
 *  string-or-number, all timestamps are ISO strings or null. */
export interface CheckoutWireOrder {
  id: string;
  orderNumber: string;
  status: string;
  holdExpiresAt?: string | null;
  fulfillment: string;
  appointmentSlot?: string | null;
  pickupCode?: string | null;
  riskFlagged?: boolean;
  vendor?: { name: string } | null;
  items?: Array<{ name: string; quantity: number; totalCustomer: string | number }>;
  subtotalCustomer: string | number;
  deliveryFee: string | number;
  isExpress?: boolean;
  tipAmount: string | number;
  discount: string | number;
  totalAmount: string | number;
  paymentMethod: string;
  estimatedPrepTime?: number | null;
  estimatedDeliveryTime?: number | null;
  promisedAt?: string | null;
  promiseRevisedAt?: string | null;
  promiseRevisionReason?: string | null;
  promiseRevisions?: number | null;
  deliveryAddress: string | null;
  placedAt: string;
  scheduledFor?: string | null;
}

export interface CheckoutAnswerOrder {
  id: string;
  orderNumber: string;
  status: string;
  holdExpiresAt: string | null;
  fulfillment: string;
  appointmentSlot: string | null;
  pickupCode: string | null;
  riskFlagged: boolean;
  vendorName: string | null;
  items: Array<{ name: string; quantity: number; price: number }>;
  subtotal: number;
  deliveryFee: number;
  isExpress: boolean;
  tip: number;
  discount: number;
  total: number;
  paymentMethod: string;
  estimatedPrepTime: number | null;
  estimatedDeliveryTime: number | null;
  promise: ReturnType<typeof promiseView>;
  deliveryAddress: string | null;
  placedAt: string;
  scheduledFor: string | null;
}

export interface CheckoutAnswer {
  order: CheckoutAnswerOrder;
  orders: CheckoutAnswerOrder[];
  grandTotal: number;
  paymentAction: Prisma.JsonValue;
  message: string;
}

/**
 * Shape the answer from orders in wire form. `grandTotal` is the pricer's
 * basket total on the fresh path; a legacy receipt did not store it, so its
 * projection sums the stored order totals — the same arithmetic `priceBasket`
 * documents ("grandTotal … equal to the sum of perPlan[].total").
 */
export function shapeCheckoutAnswer(input: {
  orders: CheckoutWireOrder[];
  paymentAction: Prisma.JsonValue;
  grandTotal?: number;
  scheduledFor?: string | null;
}): CheckoutAnswer {
  const orders = input.orders.map((order) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    // The confirmation screen shows the free-cancel countdown off this.
    holdExpiresAt: order.holdExpiresAt ?? null,
    fulfillment: order.fulfillment,
    appointmentSlot: order.appointmentSlot ?? null,
    pickupCode: order.pickupCode ?? null,
    riskFlagged: order.riskFlagged ?? false,
    vendorName: order.vendor?.name ?? null,
    items: (order.items ?? []).map((i) => ({ name: i.name, quantity: i.quantity, price: Number(i.totalCustomer) })),
    subtotal: Number(order.subtotalCustomer),
    deliveryFee: Number(order.deliveryFee),
    isExpress: order.isExpress ?? false,
    tip: Number(order.tipAmount),
    discount: Number(order.discount),
    total: Number(order.totalAmount),
    paymentMethod: order.paymentMethod,
    estimatedPrepTime: order.estimatedPrepTime ?? null,
    estimatedDeliveryTime: order.estimatedDeliveryTime ?? null,
    // The promise's view is derived from the stored promise timestamps; wire
    // strings are rehydrated to Dates so the same `promiseView` both paths use
    // can derive the window (identical arithmetic on an identical instant).
    promise: promiseView({
      promisedAt: order.promisedAt ? new Date(order.promisedAt) : null,
      promiseRevisedAt: order.promiseRevisedAt ? new Date(order.promiseRevisedAt) : null,
      promiseRevisionReason: order.promiseRevisionReason ?? null,
      promiseRevisions: order.promiseRevisions ?? 0,
    }),
    deliveryAddress: order.deliveryAddress,
    placedAt: order.placedAt,
    scheduledFor: order.scheduledFor ?? null,
  }));
  const grandTotal = input.grandTotal ?? orders.reduce((sum, o) => sum + o.total, 0);
  const scheduled = input.scheduledFor ?? input.orders[0]?.scheduledFor;
  return {
    // Single-vendor callers keep their shape; multi-vendor callers get all.
    order: orders[0]!,
    orders,
    grandTotal,
    paymentAction: input.paymentAction,
    message: input.orders.length > 1
      ? `${input.orders.length} orders placed — each vendor will confirm shortly.`
      : scheduled
        ? `Order scheduled! ${input.orders[0]?.vendor?.name} will prepare it at the right time.`
        : `Order placed! ${input.orders[0]?.vendor?.name} will confirm shortly.`,
  };
}

/**
 * Project a stored receipt result to the shaped answer for a replay. A
 * receipt written by this fix already holds the shaped answer and passes
 * through untouched; a pre-fix receipt (raw `{ orders, paymentAction }`) is
 * projected through the SAME shaper, so a replay never returns internal
 * order columns. Anything that is neither shape is returned as it was.
 */
export function shapeStoredCheckoutResult(result: Prisma.JsonValue): Prisma.JsonValue {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if ('order' in record && 'grandTotal' in record && 'message' in record) return result;
  const orders = Array.isArray(record['orders']) ? (record['orders'] as CheckoutWireOrder[]) : [];
  if (orders.length === 0) return result;
  return JSON.parse(JSON.stringify(shapeCheckoutAnswer({
    orders,
    paymentAction: (record['paymentAction'] ?? null) as Prisma.JsonValue,
  }))) as Prisma.JsonValue;
}

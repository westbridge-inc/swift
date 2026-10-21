import { subscriptionWords } from '../../lib/weeklyFee';

// [UI-SWEEP U72] What the store's screens call an order status, a payment
// method, its weekly-fee subscription and its QR: the phone's words, never the
// server's code. The store home used to print "· MOBILE_MONEY" on an order
// card and "PAST DUE" / "ACTIVE" on its Billing and QR tiles, and an order
// status the pill had not been taught read as the code with spaces.

/** The store's word for each order status (pill and timeline). */
const STORE_STATUS: Record<string, string> = {
  PENDING: 'New',
  PLACED: 'New',
  ACCEPTED: 'Accepted',
  CONFIRMED: 'Accepted',
  PREPARING: 'Preparing',
  READY: 'Ready',
  READY_FOR_PICKUP: 'Ready',
  RIDER_ASSIGNED: 'Rider assigned',
  RIDER_EN_ROUTE_PICKUP: 'Rider en route',
  RIDER_ARRIVED_PICKUP: 'Rider at counter',
  PICKED_UP: 'Out for delivery',
  EN_ROUTE_DELIVERY: 'Out for delivery',
  ARRIVED: 'Out for delivery',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
  FAILED: 'Failed',
  RETURNING: 'Returning to you',
  RETURNED: 'Returned to you',
};

/** A status this file has not been taught reads "In progress", never the code. */
export function storeStatusWords(status: string | null | undefined): string {
  const s = String(status ?? '').trim().toUpperCase();
  return STORE_STATUS[s] ?? 'In progress';
}

/** The order's history: the same words, except a new order was "Placed". */
export function storeTimelineWords(status: string | null | undefined): string {
  const s = String(status ?? '').trim().toUpperCase();
  return s === 'PENDING' || s === 'PLACED' ? 'Placed' : storeStatusWords(s);
}

const PAYMENT: Record<string, string> = {
  CASH: 'Cash',
  MOBILE_MONEY: 'MMG',
  BANK_TRANSFER: 'Bank transfer',
  CARD: 'Card',
};

/** Short name of how the customer pays; null when the order names none. */
export function paymentMethodWords(method: string | null | undefined): string | null {
  const m = String(method ?? '').trim().toUpperCase();
  if (!m) return null;
  return PAYMENT[m] ?? 'Other payment';
}

/** The payment line on the store's order screen. */
export function orderPaymentLine(method: string | null | undefined): string {
  const m = String(method ?? '').trim().toUpperCase();
  if (m === 'CASH') return 'Cash on handover — you keep 100% of the goods total.';
  if (m === 'MOBILE_MONEY') return 'MMG — the customer pays your store’s MMG directly.';
  return paymentMethodWords(m) ?? 'Payment method not shown';
}

/** The Billing tile's pill: the weekly-fee words the Billing screen uses. */
export function subscriptionPillWords(status: string | null | undefined): string {
  return subscriptionWords(String(status ?? '').trim().toUpperCase());
}

const QR: Record<string, string> = { ACTIVE: 'Live', SUPERSEDED: 'Replaced', DEACTIVATED: 'Turned off' };

/** The QR tile's pill. */
export function qrStatusWords(status: string | null | undefined): string {
  return QR[String(status ?? '').trim().toUpperCase()] ?? 'Not live';
}

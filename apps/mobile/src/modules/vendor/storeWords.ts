import { subscriptionWords } from '../../lib/weeklyFee';

// [UI-SWEEP U72] What the store's screens call a payment method, its
// weekly-fee subscription and its QR: the phone's words, never the server's
// code. The store home used to print "· MOBILE_MONEY" on an order card and
// "PAST DUE" / "ACTIVE" on its Billing and QR tiles. Order statuses are not
// here: their words live in lib/orderStatus (storeStatusLabel), which reads
// the map the web store console shares (@swift/types order-words).

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
  // The web store console's words for the same line (lib/vendor-order-view orderPaymentLine).
  if (m === 'MOBILE_MONEY') return 'MMG — the customer pays your store’s MMG account.';
  return paymentMethodWords(m) ?? 'Payment method not shown';
}

/** The Billing tile's pill: the weekly-fee words the Billing screen uses. */
export function subscriptionPillWords(status: string | null | undefined): string {
  return subscriptionWords(String(status ?? '').trim().toUpperCase());
}

// The web store console's words for the same tile (#1615 orders-home
// qrStatusWords), so the phone and the console name a QR state the same way.
const QR: Record<string, string> = { ACTIVE: 'Active', SUPERSEDED: 'Replaced by a newer QR', DEACTIVATED: 'Turned off' };

/** The QR tile's pill; a state this build does not know is "Status unavailable", never the code. */
export function qrStatusWords(status: string | null | undefined): string {
  return QR[String(status ?? '').trim().toUpperCase()] ?? 'Status unavailable';
}

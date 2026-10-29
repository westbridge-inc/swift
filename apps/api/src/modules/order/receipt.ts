import { formatMoney } from '../../utils/currency-amount';
/**
 * Order receipt (marketplace-mechanics spec §12) — the artifact people keep.
 *
 * Server-rendered, print-ready HTML (the legal-pages pattern): no PDF
 * dependency, no object-storage copies to govern — the receipt is derived
 * from the order row on demand, so it is always exactly what the ledger
 * says. Money framing stays honest: the platform holds none of it — cash
 * goes to the mover at the door, MMG goes straight to the store.
 */
import { billableDistance } from '../../utils/billable-distance';

type ReceiptOrder = {
  orderNumber: string;
  placedAt: Date;
  status: string;
  orderType: string;
  fulfillment: string | null;
  paymentMethod: string | null;
  paymentStatus: string;
  subtotalCustomer: unknown;
  deliveryFee: unknown;
  /** [ALG-18] The frozen billable distance, when the order carries one. */
  billableKm?: unknown;
  billableKmSource?: string | null;
  taxiDistance?: unknown;
  tipAmount: unknown;
  discount: unknown;
  totalAmount: unknown;
  deliveryAddress: string | null;
  vendor: { name: string; addressLine1: string; city: string; phone: string } | null;
  /** [Triage row 248 · R3 · CAA s.70] Who sold: the store's seller block (verification/storefront-seller.ts), the same
   *  legal name, address and published phone its store page shows. Null = Swift holds none on file for it, and the
   *  receipt names the store by its trading name and address only (never a guess). */
  seller?: { legalName: string | null; address: string | null; phone: string | null } | null;
  customer: { firstName: string | null; lastName: string | null } | null;
  items: Array<{ name: string; quantity: number; totalCustomer: unknown; subStatus?: string | null; vatClass?: string | null }>;
  /** [STORE-VAT · owner O-5] The VAT frozen at checkout (store-vat/order-vat.ts). vatRateBps null = no VAT on this order,
   *  and the receipt is exactly what it was before VAT existed. */
  vatRateBps?: number | null;
  vatAmount?: unknown;
  vatStandardGoods?: unknown;
  vatZeroRatedGoods?: unknown;
  vatExemptGoods?: unknown;
  /** The standard-rated goods the VAT was taken from (after the store's OWN discount only). */
  vatBase?: unknown;
  vatSellerNumber?: string | null;
  vatSellerName?: string | null;
  /** [M-36] The currency every amount on the order is in; stamped at checkout. */
  currencyCode?: string | null;
  /** [TAXI waiting charge] A ride's frozen waiting, when it was charged one. */
  fareBreakdown?: { routeFare: number; waitingMinutes: number; waitingCharge: number; total: number } | null;
  /** [TAXI multi-stop 8/8] A ride's stops in order (absent for a ride without them). */
  stops?: Array<{ sequence: number; address: string; skipped: boolean }> | null;
  /** [L02 · row 34] The cash the rider stated at the door, and how far short a
   *  handover was made (the rider bore the difference). */
  doorCashCollectedAmount?: unknown;
  doorCashShortfallAmount?: unknown;
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "Sold by" — the seller's legal name, address and phone when on file; otherwise the store's own name and address. */
function soldBy(vendor: NonNullable<ReceiptOrder['vendor']>, seller: ReceiptOrder['seller'] | null): string {
  const name = seller?.legalName ?? vendor.name;
  const address = seller?.address ?? `${vendor.addressLine1}, ${vendor.city}`;
  const phone = seller?.phone ? ` · ${esc(seller.phone)}` : '';
  return `Sold by ${esc(name)} — ${esc(address)}${phone}`;
}

/** "14", "12.5": a rate in basis points as the percent people read. */
function ratePercentLabel(bps: number): string {
  return (bps / 100).toFixed(2).replace(/\.?0+$/, '');
}

/**
 * [STORE-VAT · owner O-5] The VAT a person-approved VAT store charged, inside the prices above (VAT Act s.90).
 * Swift is not the registered supplier: this receipt is never headed or called a tax invoice (s.28(3)-(4), an offence
 * otherwise, s.67(4)); it names the store as the one charging the VAT, with the number a person checked on its
 * certificate, and says the store issues its own tax invoice. Zero-rated and exempt goods get their own totals
 * (VAT Regulations reg. 10(d)). Swift's fees are never in it.
 *
 * [REVIEW-F #2085 S3-1] A SUMMARY UNDER the Total, never rows in the totals column: VAT is inside the prices, and a
 * row above the Total reads as added on top. [REVIEW-M S3-1 · REVIEW-F S4] It shows the amount the VAT was taken from
 * (vatBase: the standard-rated goods less the store's OWN discount; a Swift-funded discount does not lower it), so the
 * two figures reconcile. An order without VAT renders nothing here: its receipt is byte-identical to before VAT existed.
 */
function vatSummary(order: ReceiptOrder, money: (n: unknown) => string): string {
  if (order.vatRateBps == null || !order.vatSellerName || !order.vatSellerNumber) return '';
  const rate = ratePercentLabel(order.vatRateBps);
  const zero = Number(order.vatZeroRatedGoods ?? 0);
  const exempt = Number(order.vatExemptGoods ?? 0);
  const standard = Number(order.vatStandardGoods ?? 0);
  const base = order.vatBase == null ? standard : Number(order.vatBase);
  const name = esc(order.vatSellerName);
  const rows = [
    '<tr><td colspan="2"><strong>VAT summary</strong></td></tr>',
    `<tr><td>${base < standard ? 'Standard-rated goods, after the store’s own discount (incl. VAT)' : 'Standard-rated goods (incl. VAT)'}</td><td class="num">${money(base)}</td></tr>`,
    zero > 0 ? `<tr><td>Zero-rated goods (no VAT)</td><td class="num">${money(zero)}</td></tr>` : '',
    exempt > 0 ? `<tr><td>Exempt goods (no VAT)</td><td class="num">${money(exempt)}</td></tr>` : '',
    `<tr><td>VAT included (${rate}%)</td><td class="num">${money(order.vatAmount ?? 0)}</td></tr>`,
  ].filter(Boolean).join('\n    ');
  return `<table>
    ${rows}
  </table>
  <div class="foot">
    VAT charged by ${name} · VAT reg. no. ${esc(order.vatSellerNumber)}. The prices of the goods include VAT at ${rate}%. The VAT is worked out on the store’s price for its standard-rated goods, less any discount the store itself gave; delivery pay, tips and Swift’s fees carry no VAT. ${name} issues its own tax invoice for these goods.
  </div>`;
}

const VAT_CLASS_TAG: Readonly<Record<string, string>> = { ZERO_RATED: ' (zero-rated)', EXEMPT: ' (exempt)' };

export function renderReceiptHtml(order: ReceiptOrder): string {
  // [M-36] The order names its currency; the receipt renders it through the
  // registry (symbol, exponent, ISO code) — never a hard-coded "GYD".
  const currency = order.currencyCode ?? 'GYD';
  const money = (n: unknown) => formatMoney(n, currency, { code: true, whole: true }); // order money is MAJOR_WHOLE
  const customerName = [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ');
  // [SPS-F-0016] Never receipt money as PAID unless its capture is confirmed.
  // The fulfilment gate makes new DELIVERED/COMPLETED MMG orders CAPTURED by
  // construction; this guards the legacy rows that predate the gate.
  // [REPORT-006 F-006-07] The same honesty rule for CASH: a self-delivery or
  // legacy terminal can reach DELIVERED with paymentStatus still PENDING, and
  // "Paid in cash" there asserts a collection nobody recorded. Say what the
  // ledger can prove: captured → paid; otherwise → due.
  const cashCaptured = order.paymentStatus === 'CAPTURED';
  // [review S3-2] A delivery handed over short is CAPTURED with less cash than
  // the total: say the cash actually taken and what was not collected, never
  // "paid" in full. (The sale value stays the total; the rider bore the gap.)
  const shortfall = order.doorCashShortfallAmount == null ? 0 : Number(order.doorCashShortfallAmount);
  const shortCash = cashCaptured && order.paymentMethod !== 'MOBILE_MONEY' && Number.isFinite(shortfall) && shortfall > 0
    && order.doorCashCollectedAmount != null;
  const paidHow =
    order.paymentMethod === 'MOBILE_MONEY'
      ? (order.paymentStatus === 'CAPTURED'
        ? 'Paid by MMG — directly to the store'
        : order.paymentStatus === 'CLAIMED'
          ? 'MMG payment reported received by the store — not confirmed by the provider'
          : 'MMG payment to the store — confirmation pending')
      : order.fulfillment === 'PICKUP'
        ? (cashCaptured ? 'Paid in cash at the store' : 'Cash due at the store')
        : order.fulfillment === 'APPOINTMENT'
          ? (cashCaptured ? 'Paid at the appointment' : 'Due at the appointment')
          : shortCash
            ? `Paid ${formatMoney(order.doorCashCollectedAmount, currency, { whole: true })} in cash on delivery (${formatMoney(shortfall, currency, { whole: true })} not collected)`
            : (cashCaptured ? 'Paid in cash on delivery' : 'Cash due on delivery');
  // [SUBSTITUTION · owner 17 Oct] A line that came off the order (the store
  // removed it, the customer declined the swap, or nobody answered in time)
  // was never charged: the receipt says so and prices it at nothing, so the
  // rows add up to the Items total the order actually carries.
  const removed = (i: { subStatus?: string | null }) => i.subStatus === 'REFUNDED' || i.subStatus === 'REJECTED';
  const rows = order.items
    .map(
      (i) => `<tr>
        <td>${i.quantity}× ${esc(i.name)}${order.vatRateBps != null ? VAT_CLASS_TAG[i.vatClass ?? ''] ?? '' : ''}${removed(i) ? ' (removed, not charged)' : ''}</td>
        <td class="num">${money(removed(i) ? 0 : i.totalCustomer)}</td>
      </tr>`,
    )
    .join('\n');

  const discount = Number(order.discount ?? 0);
  const tip = Number(order.tipAmount ?? 0);
  const deliveryFee = Number(order.deliveryFee ?? 0);
  const distance = billableDistance(order);
  const waiting = order.fareBreakdown ?? null;
  const vat = vatSummary(order, money);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt ${esc(order.orderNumber)} — Swift</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; color: #111; margin: 0; background: #f6f6f6; }
  .sheet { max-width: 560px; margin: 24px auto; background: #fff; border-radius: 16px; padding: 32px; }
  .brand { color: #e8192c; font-weight: 800; font-size: 22px; }
  h1 { font-size: 16px; margin: 4px 0 0; font-weight: 600; color: #555; }
  .meta { margin: 16px 0; font-size: 14px; color: #555; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td { padding: 6px 0; border-bottom: 1px solid #eee; }
  .num { text-align: right; white-space: nowrap; }
  .totals td { border: none; padding: 3px 0; }
  .grand td { font-weight: 800; font-size: 16px; border-top: 2px solid #111; padding-top: 8px; }
  .foot { margin-top: 24px; font-size: 12px; color: #888; line-height: 1.6; }
  @media print { body { background: #fff; } .sheet { margin: 0; border-radius: 0; } }
</style>
</head>
<body>
<div class="sheet">
  <div class="brand">Swift</div>
  <h1>Receipt · ${esc(order.orderNumber)}</h1>
  <div class="meta">
    ${customerName ? `${esc(customerName)}<br>` : ''}
    ${order.vendor ? `${soldBy(order.vendor, order.seller ?? null)}<br>` : ''}
    ${new Date(order.placedAt).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })}<br>
    ${esc(paidHow)}
    ${order.stops && order.stops.length > 0 ? `<br>Stops: ${order.stops.map((st) => `${st.sequence}. ${esc(st.address)}${st.skipped ? ' (skipped)' : ''}`).join(' · ')}` : ''}
  </div>
  <table>
    ${rows}
    <tr class="totals"><td>Items</td><td class="num">${money(order.subtotalCustomer)}</td></tr>
    ${deliveryFee > 0 ? `<tr class="totals"><td>Delivery pay for your rider</td><td class="num">${money(deliveryFee)}</td></tr>` : ''}
    ${distance ? `<tr class="totals"><td>Distance (${esc(distance.sourceLabel)})</td><td class="num">${esc(distance.label)}</td></tr>` : ''}
    ${discount > 0 ? `<tr class="totals"><td>Discount</td><td class="num">−${money(discount)}</td></tr>` : ''}
    ${tip > 0 ? `<tr class="totals"><td>Rider tip</td><td class="num">${money(tip)}</td></tr>` : ''}
    ${waiting && waiting.waitingCharge > 0 ? `<tr class="totals"><td>Waiting (${waiting.waitingMinutes} min)</td><td class="num">${money(waiting.waitingCharge)}</td></tr>` : ''}
    <tr class="grand"><td>Total</td><td class="num">${money(order.totalAmount)}</td></tr>
  </table>
${vat ? `  ${vat}\n` : ''}  <div class="foot">
    Swift charges no commission and never takes custody of order money. Order payment and any
    delivery-pay handoff happen directly between the parties shown above. Questions? Support
    lives in the Swift app.
  </div>
</div>
</body>
</html>`;
}

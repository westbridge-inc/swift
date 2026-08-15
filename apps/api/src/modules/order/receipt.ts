/**
 * Order receipt (marketplace-mechanics spec §12) — the artifact people keep.
 *
 * Server-rendered, print-ready HTML (the legal-pages pattern): no PDF
 * dependency, no object-storage copies to govern — the receipt is derived
 * from the order row on demand, so it is always exactly what the ledger
 * says. Money framing stays honest: the platform holds none of it — cash
 * goes to the mover at the door, MMG goes straight to the store.
 */

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
  tipAmount: unknown;
  discount: unknown;
  totalAmount: unknown;
  deliveryAddress: string | null;
  vendor: { name: string; addressLine1: string; city: string; phone: string } | null;
  customer: { firstName: string | null; lastName: string | null } | null;
  items: Array<{ name: string; quantity: number; totalCustomer: unknown }>;
};

const money = (n: unknown) => `$${Math.round(Number(n ?? 0)).toLocaleString()} GYD`;
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderReceiptHtml(order: ReceiptOrder): string {
  const customerName = [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ');
  // [SPS-F-0016] Never receipt money as PAID unless its capture is confirmed.
  // The fulfilment gate makes new DELIVERED/COMPLETED MMG orders CAPTURED by
  // construction; this guards the legacy rows that predate the gate.
  // [REPORT-006 F-006-07] The same honesty rule for CASH: a self-delivery or
  // legacy terminal can reach DELIVERED with paymentStatus still PENDING, and
  // "Paid in cash" there asserts a collection nobody recorded. Say what the
  // ledger can prove: captured → paid; otherwise → due.
  const cashCaptured = order.paymentStatus === 'CAPTURED';
  const paidHow =
    order.paymentMethod === 'MOBILE_MONEY'
      ? (order.paymentStatus === 'CAPTURED'
        ? 'Paid by MMG — directly to the store'
        : 'MMG payment to the store — confirmation pending')
      : order.fulfillment === 'PICKUP'
        ? (cashCaptured ? 'Paid in cash at the store' : 'Cash due at the store')
        : order.fulfillment === 'APPOINTMENT'
          ? (cashCaptured ? 'Paid at the appointment' : 'Due at the appointment')
          : (cashCaptured ? 'Paid in cash on delivery' : 'Cash due on delivery');
  const rows = order.items
    .map(
      (i) => `<tr>
        <td>${i.quantity}× ${esc(i.name)}</td>
        <td class="num">${money(i.totalCustomer)}</td>
      </tr>`,
    )
    .join('\n');

  const discount = Number(order.discount ?? 0);
  const tip = Number(order.tipAmount ?? 0);
  const deliveryFee = Number(order.deliveryFee ?? 0);

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
    ${order.vendor ? `${esc(order.vendor.name)} — ${esc(order.vendor.addressLine1)}, ${esc(order.vendor.city)}<br>` : ''}
    ${new Date(order.placedAt).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })}<br>
    ${esc(paidHow)}
  </div>
  <table>
    ${rows}
    <tr class="totals"><td>Items</td><td class="num">${money(order.subtotalCustomer)}</td></tr>
    ${deliveryFee > 0 ? `<tr class="totals"><td>Delivery pay for your rider</td><td class="num">${money(deliveryFee)}</td></tr>` : ''}
    ${discount > 0 ? `<tr class="totals"><td>Discount</td><td class="num">−${money(discount)}</td></tr>` : ''}
    ${tip > 0 ? `<tr class="totals"><td>Rider tip</td><td class="num">${money(tip)}</td></tr>` : ''}
    <tr class="grand"><td>Total</td><td class="num">${money(order.totalAmount)}</td></tr>
  </table>
  <div class="foot">
    Swift charges no commission and never takes custody of order money. Order payment and any
    delivery-pay handoff happen directly between the parties shown above. Questions? Support
    lives in the Swift app.
  </div>
</div>
</body>
</html>`;
}

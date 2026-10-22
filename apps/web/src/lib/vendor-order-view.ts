// ---------------------------------------------------------------------------
// [UI-SWEEP U02 / U25 / U45] The store's order window, in the phone's words
// (apps/mobile/src/modules/vendor/shared.tsx OrderStatusPill,
// screens/VendorOrderDetailScreen.tsx). Pure, so it tests without a renderer.
// ---------------------------------------------------------------------------

import { formatAppointmentSlot } from './appointmentTime';
import { storeOrderStatusWords } from '@swift/types';
import type { VendorOrder } from './vendor-api';

/** The phone's pill words, from the one shared map (@swift/types order-words).
 *  A status this build does not know reads "Status unavailable", never the code. */
export function vendorStatusLabel(status: string | null | undefined): string {
  return storeOrderStatusWords(status);
}

/** The money card: recorded amounts only. Optional lines show only when the order carries them. */
export function orderMoneyRows(o: VendorOrder): Array<{ label: string; value: number | null; minus?: boolean; strong?: boolean }> {
  const rows: Array<{ label: string; value: number | null; minus?: boolean; strong?: boolean }> = [{ label: 'Items', value: o.subtotalBase ?? null }];
  if ((o.deliveryFee ?? 0) > 0) rows.push({ label: 'Delivery fee (rider’s)', value: o.deliveryFee ?? null });
  if ((o.tipAmount ?? 0) > 0) rows.push({ label: 'Tip', value: o.tipAmount ?? null });
  if ((o.discount ?? 0) > 0) rows.push({ label: 'Promo discount', value: o.discount ?? null, minus: true });
  rows.push({ label: 'Customer pays', value: o.totalAmount, strong: true });
  return rows;
}

/** The line under the money card: how this order is paid. A method with no
 *  line of its own gets none: a card order must never read as cash. */
export function orderPaymentLine(o: VendorOrder): string | null {
  if (o.paymentMethod === 'CASH') return 'Cash on handover — you keep 100% of the goods total.';
  if (o.paymentMethod === 'MOBILE_MONEY') return 'MMG — the customer pays your store’s MMG account.';
  return null;
}

/** The Customer card's lines: where the order goes (phone ContactCard lines). */
export function customerLines(o: VendorOrder): string[] {
  if (o.fulfillment === 'APPOINTMENT') {
    const travels = !!o.deliveryAddress && o.deliveryAddress !== o.pickupAddress;
    return [
      ...(o.appointmentSlot ? [formatAppointmentSlot(o.appointmentSlot)] : []),
      travels ? `You travel to: ${o.deliveryAddress}` : 'At your store',
    ];
  }
  if (o.fulfillment === 'PICKUP') return ['Collects at the counter'];
  return [o.deliveryAddress, o.deliveryInstructions].filter((l): l is string => typeof l === 'string' && l.trim() !== '');
}

/** A `tel:` target only for something that is a phone number. */
export function telHref(phone: string | null | undefined): string | null {
  const digits = typeof phone === 'string' ? phone.replace(/[^\d+]/g, '') : '';
  return /^\+?\d{5,}$/.test(digits) ? `tel:${digits}` : null;
}

/** "Quoted prep time: 20 min · actual 18 min (ready 1:05 PM)" — the phone's line. */
export function prepTimeLine(o: VendorOrder): string | null {
  if (!o.estimatedPrepTime) return null;
  const ready = o.readyAt ? Date.parse(o.readyAt) : NaN;
  const accepted = o.acceptedAt ? Date.parse(o.acceptedAt) : NaN;
  const actual = Number.isFinite(ready) && Number.isFinite(accepted)
    ? ` · actual ${Math.max(1, Math.round((ready - accepted) / 60000))} min (ready ${new Date(ready).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Guyana' })})`
    : '';
  return `Quoted prep time: ${o.estimatedPrepTime} min${actual}`;
}

/** "18 Oct, 1:05 PM" for the timeline and the cancellation line. */
export function whenLabel(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Guyana' });
}

export interface RecoveryView { caseId: string; state: string; open: boolean; headline: string; body: string }

/** [AF-MOB-006] The order's recovery case as the server wrote it; anything malformed is no card. */
export function recoveryView(raw: unknown): RecoveryView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const caseId = str(r['caseId']); const state = str(r['state']); const headline = str(r['headline']); const body = str(r['body']);
  if (!caseId || !state || !headline || !body) return null;
  const view = { caseId, state, open: r['open'] === true, headline, body };
  // A resolved DELIVERED or CLOSED case only repeats the order screen (phone partyCaseWorthShowing).
  return view.open || state === 'RETURNED' || state === 'TRANSFERRED' ? view : null;
}

/** The store's one recovery action: the returned goods are back (phone storeCanConfirmReturn). */
export function storeCanConfirmReturn(view: RecoveryView | null, o: VendorOrder): boolean {
  return !!view && view.state === 'RETURN_REQUIRED' && String(o.status).toUpperCase() === 'RETURNING' && o.orderType !== 'COURIER';
}

/** [PERF row 562] What a store tap's answer confirms about its order (status and its clocks). */
export const CONFIRMED_ORDER_FIELDS = ['status', 'acceptedAt', 'preparingAt', 'readyAt', 'estimatedPrepTime', 'deliveredAt', 'completedAt'] as const;

/** The fields the server just confirmed for order `id` in a step's answer (the bare updated row),
 *  or null when the answer is not that order's row. Nothing else is taken from it. */
export function confirmedOrderFields(answer: unknown, id: string): Partial<VendorOrder> | null {
  const row = (answer as { data?: Record<string, unknown> } | undefined)?.data;
  if (!row || row['id'] !== id || typeof row['status'] !== 'string') return null;
  return Object.fromEntries(CONFIRMED_ORDER_FIELDS.filter((key) => key in row).map((key) => [key, row[key]])) as Partial<VendorOrder>;
}

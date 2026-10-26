'use client';

// [PERF · UI-FIX-WEB note 05:18Z] The order window (and its shelf pick list) lives in its own chunk:
// it shows only after a tap, so the Orders page's first load no longer carries it. page.tsx fetches
// it in the background as soon as the page mounts (lib/preloaded-part), so the tap still opens at once.

import { useEffect, useRef, useState } from 'react';
import { rejectReasonsFor } from '@/lib/reject-reasons';
import { cancellationReasonWords } from '@swift/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mmgDisputePaused, MMG_DISPUTE_NOTICE } from '@/lib/mmg-dispute';
import { MutationNotice } from '@/components/mutation-notice';
import { CallPartyButton } from '@/components/call-party-button';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useFeedPollInterval } from '@/lib/store-live-feed';
import { acceptHeldForPayment, mmgMovedLabel, mmgMoneyMoved, mmgPayBlockedReason } from '@/lib/mmg-pay-words';
import { formatAppointmentSlot } from '@/lib/appointmentTime';
import {
  confirmedOrderFields, customerLines, orderMoneyRows, orderPaymentLine, prepTimeLine, recoveryView, storeCanConfirmReturn, vendorStatusLabel, whenLabel,
} from '@/lib/vendor-order-view';
import {
  acceptOrder, completePickup, confirmPayment, confirmReturnReceived, getItems, getOrder,
  markDelivered, markPreparing, markReady, money, proposeSubstitution, refundLine, rejectOrder,
  retryDispatch, setFulfillmentMode, setPicked, type OrderLine, type VendorOrder,
} from '@/lib/vendor-api';
import { statusChip, timeAgo } from './order-chip';
// The app's own O-4 rules and words (plain file, imported as is).
import { OUT_OF_STOCK_WORDS, canMarkOutOfStock, customerDeciding, lastLineStanding, lineStockWords, nothingToAccept } from '../../../../../mobile/src/modules/vendor/storeOrderRules';
import { HANDOVER_WORDS, canMarkHandedToRider, handoverNeedsNoCode, pickupCheckWords } from '../../../../../mobile/src/modules/vendor/storeHandover';
import { handedToRider } from '@/lib/store-handover-api';
import { RiderHandoverLine } from '@/components/rider-handover-line';

const COURIER_ACTIVE = ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'];

/** [STORE-DASH] The board's copy of one order (its `{ orders }` page), when the board holds it. */
export function boardOrder(board: unknown, id: string): VendorOrder | undefined {
  const rows = (board as { orders?: unknown } | null | undefined)?.orders;
  return Array.isArray(rows) ? (rows as VendorOrder[]).find((o) => o?.id === id) : undefined;
}
const PICKABLE_STATES = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', ...COURIER_ACTIVE];

/** Mirrors the mobile app's orderActions — one source of truth for what a
 *  vendor may do in each state (timestamps keep working after a rider claims). */
function actionsFor(o: VendorOrder) {
  const s = (o.status || '').toUpperCase();
  const isPickup = o.fulfillment === 'PICKUP';
  const isAppt = o.fulfillment === 'APPOINTMENT';
  const out: Array<{ label: string; kind: string; tone?: 'danger' }> = [];
  if (s === 'PENDING' || s === 'PLACED') {
    // [STORE-DASH · O-4] No Accept while the customer answers an "Out of stock" question, or once
    // every item came off (the server refuses both); Reject stays.
    if (!customerDeciding(o) && !nothingToAccept(o)) out.push({ label: 'Accept', kind: 'accept' });
    out.push({ label: isAppt ? 'Decline' : 'Reject', kind: 'reject', tone: 'danger' });
  } else if (isAppt && (s === 'ACCEPTED' || s === 'CONFIRMED')) {
    out.push({ label: 'Mark complete', kind: 'complete-appointment' });
  } else if (s === 'ACCEPTED' || s === 'CONFIRMED') {
    // [STORE-DASH · REVIEW-F S4-1 on #2024] An unpaid MMG order's one step is "Paid by MMG" (below);
    // the server refuses Start preparing for it (MMG_PAYMENT_PENDING).
    if (!(o.paymentMethod === 'MOBILE_MONEY' && !mmgMoneyMoved(o.paymentStatus))) out.push({ label: 'Start preparing', kind: 'preparing' });
  } else if (s === 'PREPARING') {
    out.push({ label: isPickup ? 'Ready for pickup' : 'Ready for delivery', kind: 'ready' });
  } else if (COURIER_ACTIVE.includes(s)) {
    if (!o.preparingAt) out.push({ label: 'Start preparing', kind: 'preparing' });
    else if (!o.readyAt) out.push({ label: 'Ready for delivery', kind: 'ready' });
    // [STORE-DASH · O-2] The rider is at the counter: one tap records the hand-over.
    else if (canMarkHandedToRider(o)) out.push({ label: 'Handed to rider', kind: 'handed-to-rider' });
  } else if ((s === 'READY' || s === 'READY_FOR_PICKUP') && isPickup) {
    // [STORE-DASH · O-2] With the store's pickup code off: one tap after checking the name and order number.
    out.push(handoverNeedsNoCode(o) ? { label: 'Handed to customer', kind: 'handed-to-customer' } : { label: 'Mark picked up', kind: 'complete-pickup' });
  } else if (canMarkHandedToRider(o)) {
    out.push({ label: 'Handed to rider', kind: 'handed-to-rider' });
  } else if (
    (s === 'READY' || s === 'READY_FOR_PICKUP')
    && o.fulfillment === 'DELIVERY'
    && o.fulfillmentMode === 'VENDOR_DELIVERY'
    && !o.riderId
  ) {
    out.push({ label: 'Confirm delivered', kind: 'delivered' });
  }
  // [Item 10] A disputed MMG order: only the decline survives (the server allows it).
  return mmgDisputePaused(o) ? out.filter((a) => a.kind === 'reject') : out;
}

function PickList({ order, onBusy }: { order: VendorOrder; onBusy: boolean }) {
  const queryClient = useQueryClient();
  const storeId = useStoreId();
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'order', order.id) });
    queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'orders') });
  };
  const items = useQuery({ queryKey: storeKey(storeId, 'items', 'all'), queryFn: () => getItems() });
  const [subFor, setSubFor] = useState<string | null>(null);

  const MMG_LINE_LOCK = 'MMG order — settle item changes with the customer directly.';
  const pickedMut = useMutation({
    mutationFn: (v: { lineId: string; picked: boolean }) => setPicked(order.id, v.lineId, v.picked),
    onSettled: refresh,
  });
  const subMut = useMutation({
    mutationFn: (v: { lineId: string; substituteItemId: string }) => proposeSubstitution(order.id, v.lineId, v.substituteItemId),
    onSettled: () => { setSubFor(null); refresh(); },
  });
  const refundMut = useMutation({
    mutationFn: (lineId: string) => refundLine(order.id, lineId),
    onSettled: () => { setSubFor(null); refresh(); },
  });

  /** Same substitutionGroup wins; otherwise same category; always in stock. */
  const candidates = (line: OrderLine) => {
    const all = items.data ?? [];
    const original = all.find((i) => i.id === line.itemId);
    const pool = all.filter((i) => i.id !== line.itemId && i.isAvailable !== false);
    const grouped = original?.substitutionGroup
      ? pool.filter((i) => i.substitutionGroup === original.substitutionGroup)
      : pool.filter((i) => original && i.category?.id === original.category?.id);
    return grouped.slice(0, 6);
  };

  // [W-28] Settled is not fulfilled. A refunded or rejected line has been
  // REMOVED from the order — the money came off and the stock went back — so
  // an order whose every line was refused is settled on every line and
  // contains nothing. Saying "All picked ✓" there sent a rider to collect an
  // empty bag; the server now refuses to mark it ready, and this screen says
  // what is actually true.
  const lineResolved = (l: OrderLine) => l.picked || l.subStatus === 'REFUNDED' || l.subStatus === 'REJECTED';
  const lineFulfilled = (l: OrderLine) => l.picked && l.subStatus !== 'REFUNDED' && l.subStatus !== 'REJECTED';
  const open = order.items.filter((l) => !lineResolved(l)).length;
  const waiting = order.items.filter((l) => !l.picked && l.subStatus === 'PENDING').length;
  const pickable = open - waiting;
  const fulfilled = order.items.filter(lineFulfilled).length;
  const removed = order.items.length - open - fulfilled;
  const pickingSummary =
    open > 0
      ? `Shelf picking — ${[pickable > 0 ? `${pickable} to pick` : '', waiting > 0 ? `${waiting} waiting on customer` : ''].filter(Boolean).join(', ')}`
      : fulfilled === 0
        ? 'Nothing left to hand over — cancel this order'
        : removed > 0
          ? `Picked ✓ — ${fulfilled} of ${order.items.length} lines, ${removed} removed`
          : 'All picked ✓';
  const busy = onBusy || pickedMut.isPending || subMut.isPending || refundMut.isPending;
  // [W-27] An MMG order's totals cannot change in-app — the server refuses with
  // MMG_ADJUSTMENT_UNAVAILABLE, because the money went straight to the store
  // and Swift never held it. Saying so beats letting the store click into a 409.
  const mmgLocked = order.paymentMethod === 'MOBILE_MONEY';

  return (
    <div className="mt-4 rounded-xl border border-[var(--swift-border)] bg-[var(--swift-subtle)] p-4">
      <p className={`text-sm font-bold${open === 0 && fulfilled === 0 ? ' text-[var(--swift-red)]' : ''}`}>{pickingSummary}</p>
      <MutationNotice errors={[pickedMut.error, subMut.error, refundMut.error]} className="mt-2" />
      <div className="mt-2 space-y-2">
        {order.items.map((it) => (
          <div key={it.id} className="rounded-lg bg-[var(--swift-card)] p-3">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={!!it.picked}
                disabled={busy || it.subStatus === 'PENDING' || it.subStatus === 'REFUNDED' || it.subStatus === 'REJECTED'}
                onChange={(e) => pickedMut.mutate({ lineId: it.id, picked: e.target.checked })}
                aria-label={`Picked: ${it.quantity}× ${it.name}`}
                className="h-4 w-4 accent-[var(--swift-red)]"
              />
              <span className="flex-1 text-sm">
                <b>{it.quantity}×</b> {it.name}
              </span>
              {it.subStatus === 'PENDING' && (
                <span className="text-xs font-semibold text-amber-600">Waiting on customer: {it.substituteName}</span>
              )}
              {/* [W-27] "Refunded" said money came back. On a cash order none
                  ever left: the line is removed and the bill is smaller at the
                  door. MMG line changes are refused outright by the server, so
                  there is no tender here on which a refund could be owed. */}
              {it.subStatus === 'REFUNDED' && <span className="text-xs font-semibold text-[var(--swift-muted)]">Removed — not charged</span>}
              {it.subStatus === 'REJECTED' && <span className="text-xs font-semibold text-[var(--swift-red)]">Sub declined</span>}
              {!it.picked && (it.subStatus === 'PENDING' || it.subStatus === 'APPROVED') && (
                <button
                  onClick={() => refundMut.mutate(it.id)}
                  disabled={busy || mmgLocked}
                  title={mmgLocked ? MMG_LINE_LOCK : undefined}
                  className="text-xs font-semibold text-[var(--swift-red)] disabled:opacity-50"
                >
                  Remove unavailable line
                </button>
              )}
              {!it.picked && it.subStatus === 'NONE' && (
                <button
                  onClick={() => setSubFor(subFor === it.id ? null : it.id)}
                  disabled={busy}
                  className="text-xs font-semibold text-[var(--swift-red)] hover:underline"
                >
                  Out of stock?
                </button>
              )}
            </div>
            {subFor === it.id && !it.picked && it.subStatus === 'NONE' && (
              <div className="mt-2 border-t border-[var(--swift-border)] pt-2">
                <p className="text-xs font-semibold text-[var(--swift-muted)]">Offer a substitute:</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {candidates(it).map((c) => (
                    <button
                      key={c.id}
                      onClick={() => subMut.mutate({ lineId: it.id, substituteItemId: c.id })}
                      disabled={busy}
                      className="rounded-full border border-[var(--swift-border)] px-2.5 py-1 text-xs hover:border-[var(--swift-red)]"
                    >
                      {c.name} · {money(c.basePrice)}
                    </button>
                  ))}
                  {/* [W-27] The store is not refunding anything — it is taking
                      the line off the order, and the customer pays less. An MMG
                      order cannot do this at all (the server refuses), so the
                      control says so instead of leading the store into a 409. */}
                  <button
                    onClick={() => refundMut.mutate(it.id)}
                    disabled={busy || mmgLocked}
                    title={mmgLocked ? MMG_LINE_LOCK : undefined}
                    className="rounded-full bg-black/5 px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
                  >
                    No substitute — remove line
                  </button>
                  {mmgLocked && (
                    <span className="text-xs text-[var(--swift-muted)]">{MMG_LINE_LOCK}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function OrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const storeId = useStoreId();
  // [PERF row 8] The store's live feed re-reads this order on its events; the poll is the fallback.
  const orderPoll = useFeedPollInterval(storeId, 10_000, 30_000);
  const order = useQuery({
    queryKey: storeKey(storeId, 'order', id), queryFn: () => getOrder(id), refetchInterval: orderPoll,
    // [STORE-DASH · as on the phone] The window opens at once from the board's own copy of the
    // order; the order's own read replaces it the moment it answers (isPlaceholderData).
    placeholderData: () => boardOrder(queryClient.getQueryData(storeKey(storeId, 'orders')), id),
  });
  const [prepTime, setPrepTime] = useState(20);
  const [pickupCode, setPickupCode] = useState('');
  // [W-25] The store's attestation carries the provider reference from its own
  // wallet message. Without one there is nothing to reconcile against later.
  const [mmgRef, setMmgRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelivered, setConfirmDelivered] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  // [REVIEW-F S3-2 on #2048] The last item out of stock = Reject (out of stock), asked once.
  const [lastOut, setLastOut] = useState(false);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'order', id) });
    queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'orders') });
  };
  const act = useMutation({
    mutationFn: async (kind: string) => {
      setError(null);
      if (mmgDisputePaused(order.data)) throw new Error(MMG_DISPUTE_NOTICE.body);
      if (kind === 'accept') return acceptOrder(id, order.data?.fulfillment === 'APPOINTMENT' ? undefined : prepTime);
      if (kind === 'preparing') return markPreparing(id);
      if (kind === 'ready') return markReady(id);
      if (kind === 'delivered') return markDelivered(id);
      if (kind === 'complete-pickup') return completePickup(id, pickupCode.trim());
      if (kind === 'handed-to-customer') return completePickup(id);
      if (kind === 'handed-to-rider') return handedToRider(id);
      if (kind === 'complete-appointment') {
        const { apiFetch } = await import('@/lib/auth');
        return apiFetch(`/api/v1/vendor/orders/${id}/complete-appointment`, { method: 'PUT', body: '{}' });
      }
      if (kind === 'confirm-payment') return confirmPayment(id, mmgRef.trim());
      if (kind === 'retry-dispatch') return retryDispatch(id);
      if (kind === 'return-received') return confirmReturnReceived(id);
      if (kind === 'vendor-delivery') return setFulfillmentMode(id, 'VENDOR_DELIVERY');
      if (kind === 'platform-rider') return setFulfillmentMode(id, 'PLATFORM_RIDER');
      throw new Error(`Unknown action ${kind}`);
    },
    // [PERF row 562] The server's confirmed answer lands at once. The order used to keep its old
    // status (and its old button: a second Accept was a 409) until a re-read came back, one more
    // round trip abroad. Only what the server just confirmed is taken from its answer; the page is
    // still re-read. Nothing shows before the answer: dispatch and money never show success early.
    onSuccess: (answer) => {
      const confirmed = confirmedOrderFields(answer, id);
      if (!confirmed) return;
      // A read already on its way holds the old status: onSettled's re-read cancels it (cancelRefetch).
      queryClient.setQueryData<VendorOrder>(storeKey(storeId, 'order', id), (o) => (o ? { ...o, ...confirmed } : o));
    },
    onError: (e) => setError((e as Error).message),
    onSettled: refresh,
  });
  // [E10] The API requires a reason on every rejection, so reject is its own
  // mutation keyed on the chosen preset — it never flows through `act` with no
  // reason. Same three presets the mobile app offers.
  // [STORE-DASH · O-4] "Out of stock" on a waiting order: one tap asks the customer (continue
  // without it, or cancel); the server recalculates the total only after the answer.
  const outOfStock = useMutation({
    mutationFn: (lineId: string) => refundLine(id, lineId),
    onError: (e) => setError((e as Error).message),
    onSettled: refresh,
  });
  const reject = useMutation({
    mutationFn: (why: string) => rejectOrder(id, why),
    onError: (e) => setError((e as Error).message),
    onSettled: () => {
      setConfirmReject(false);
      refresh();
    },
  });

  // `preparingAt` / `readyAt` / `paymentStatus` are declared on VendorOrder now
  // (the detail route returns the whole Order row) — no local re-declaration.
  const o = order.data;
  const closeRef = useRef<HTMLButtonElement>(null);
  const loaded = Boolean(o);
  // The loading view and the loaded view are different trees, so the close
  // button focused on open is replaced when the order arrives. Keep focus in
  // the window instead of letting it fall to the page behind.
  useEffect(() => {
    if (!document.activeElement || document.activeElement === document.body) closeRef.current?.focus();
  }, [loaded]);
  const closeButton = (
    <button ref={closeRef} onClick={onClose} aria-label="Close order detail" className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-xl text-[var(--swift-muted)] hover:text-[var(--swift-ink)]">✕</button>
  );
  if (!o) return (
    <div className="sw-card p-6 text-sm text-[var(--swift-muted)]">
      <div className="flex items-center justify-between gap-3">
        <p className="font-semibold text-[var(--swift-ink)]">Order detail</p>
        {closeButton}
      </div>
      {order.isError ? (
        <div className="mt-3" role="alert">
          <p>Could not load this order. Try again.</p>
          <button onClick={() => void order.refetch()} aria-label="Retry order detail" className="mt-3 min-h-11 rounded-lg border border-[var(--swift-border)] px-4 font-semibold text-[var(--swift-ink)]">Retry</button>
        </div>
      ) : <p className="mt-3">Loading…</p>}
    </div>
  );

  const s = (o.status || '').toUpperCase();
  const paused = mmgDisputePaused(o);
  // Payment-first, the same rule as the card (lib/mmg-pay-words): an MMG order
  // is accepted only once its money has moved (CAPTURED or CLAIMED). Until then
  // the window offers the store's confirmation, or says why it cannot.
  // (A disputed order keeps only Reject: actionsFor.)
  const actions = actionsFor(o).filter((a) => !(a.kind === 'accept' && acceptHeldForPayment(o)));
  const pickable = !paused && ['SUPERMARKET', 'STORE'].includes(o.vendor?.vendorType ?? '') && PICKABLE_STATES.includes(s);
  const isMmg = o.paymentMethod === 'MOBILE_MONEY';
  // [W-25] The old predicate was "not captured and not cancelled", so a
  // FAILED, REFUNDED or UNRESOLVED payment offered a one-tap "received" — a
  // tap on a reversed payment recaptured a refund. A store may attest only
  // where money plausibly landed and nothing has reversed or resolved it; the
  // server enforces the same matrix and refuses the rest by name.
  const ATTESTABLE_PAYMENT = ['PENDING', 'AUTHORIZED'];
  const attestablePay =
    !paused && isMmg && ATTESTABLE_PAYMENT.includes(String(o.paymentStatus ?? '')) && !['CANCELLED', 'REFUNDED', 'FAILED'].includes(s);
  // Row 52: only the owner or a manager of THIS order's store may confirm; the
  // server says which per order (and refuses staff regardless).
  const showConfirmPay = attestablePay && o.canConfirmPayment === true;
  const confirmPayNeedsManager = attestablePay && o.canConfirmPayment !== true;
  // and when it is NOT attestable, the screen says why rather than going quiet
  const payBlockedReason = !paused && isMmg && !attestablePay && o.paymentStatus !== 'CAPTURED' ? mmgPayBlockedReason(o.paymentStatus) : null;
  const customer = [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ') || 'Customer';
  const riderName = o.rider?.user ? [o.rider.user.firstName, o.rider.user.lastName].filter(Boolean).join(' ') : '';
  const recovery = recoveryView(o.custodyRecovery);
  const timeline = [...(o.statusHistory ?? [])].reverse();
  const prepLine = prepTimeLine(o);
  const fulfilmentWord = { DELIVERY: 'Delivery', PICKUP: 'Pickup', APPOINTMENT: 'Appointment' }[String(o.fulfillment ?? '')] ?? null;
  const riderAssigned = Boolean(o.riderId || o.rider);
  const isDelivery = o.fulfillment === 'DELIVERY';
  const selfDelivery = o.fulfillmentMode === 'VENDOR_DELIVERY';
  const activeDelivery = isDelivery && !['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'].includes(s);
  const mayChangeDeliveryOwner = !paused && activeDelivery && !riderAssigned
    && ['ACCEPTED', 'CONFIRMED', 'PREPARING', 'READY', 'READY_FOR_PICKUP'].includes(s);
  const canChooseVendorDelivery = mayChangeDeliveryOwner && o.vendor?.selfDeliveryEnabled === true && !selfDelivery;
  // A store-wide preference changing later must not strand an existing
  // VENDOR_DELIVERY order without a way back to platform dispatch.
  const canChoosePlatformRider = mayChangeDeliveryOwner && selfDelivery;
  const deliveryOwnerTitle = selfDelivery
    ? 'Your store delivers this order'
    : riderAssigned
      ? 'A Swift rider delivers this order'
      : o.fulfillmentMode === 'PLATFORM_RIDER'
        ? 'Platform rider delivery selected'
        : 'Delivery owner not chosen yet';
  const deliveryOwnerDescription = selfDelivery
    ? 'No Swift rider will be sent for this order.'
    : riderAssigned
      ? 'The assigned rider is responsible for delivery.'
      : o.fulfillmentMode === 'PLATFORM_RIDER'
        ? 'No rider is assigned yet.'
        : 'No delivery owner has been recorded yet.';

  return (
    <div className="sw-card p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="sw-heading">#{o.orderNumber}</p>
          <p className="mt-0.5 text-sm text-[var(--swift-muted)]">
            {[customer, timeAgo(o.placedAt), fulfilmentWord].filter(Boolean).join(' · ')}
          </p>
          {o.fulfillment === 'APPOINTMENT' && o.appointmentSlot ? <p className="mt-1 text-sm font-semibold">Appointment: {formatAppointmentSlot(o.appointmentSlot)}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {statusChip(s, paused)}
          {closeButton}
        </div>
      </div>

      {paused && <p role="status" className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{MMG_DISPUTE_NOTICE.body}</p>}

      <div className="mt-4 space-y-1.5">
        {o.items.map((it) => {
          const stock = s === 'PENDING' ? lineStockWords(it) : null;
          return (
            <div key={it.id} className="text-sm">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="min-w-0 break-words"><b>{it.quantity}×</b> {it.name}{it.specialInstructions ? <i className="text-[var(--swift-muted)]"> — {it.specialInstructions}</i> : null}</span>
                {/* [BUG-GUARDS C8] The row wraps at 360px: the item, then its step and price. */}
                <span className="flex flex-wrap items-center justify-end gap-2">
                  {!paused && lastLineStanding(o, it) && !lastOut && (
                    <button
                      type="button"
                      onClick={() => setLastOut(true)}
                      disabled={act.isPending || reject.isPending}
                      className="min-h-9 rounded-lg border border-[var(--swift-red)]/30 px-3 text-xs font-bold text-[var(--swift-red)] hover:bg-[var(--swift-red)]/5 disabled:opacity-50"
                    >
                      {OUT_OF_STOCK_WORDS.lastButton}
                    </button>
                  )}
                  {!paused && canMarkOutOfStock(o, it) && !lastLineStanding(o, it) && (
                    <button
                      type="button"
                      onClick={() => outOfStock.mutate(it.id)}
                      disabled={outOfStock.isPending || act.isPending || reject.isPending}
                      aria-label={`${OUT_OF_STOCK_WORDS.button}: ${it.name}`}
                      className="min-h-9 rounded-lg border border-[var(--swift-red)]/30 px-3 text-xs font-bold text-[var(--swift-red)] hover:bg-[var(--swift-red)]/5 disabled:opacity-50"
                    >
                      {OUT_OF_STOCK_WORDS.button}
                    </button>
                  )}
                  <span className="font-medium">{money(it.totalCustomer)}</span>
                </span>
              </div>
              {stock && <p className="mt-0.5 text-xs font-semibold text-amber-700">{stock}</p>}
              {lastOut && lastLineStanding(o, it) && (
                <div role="group" aria-label="Reject the order as out of stock" className="mt-2 rounded-lg bg-[var(--swift-red)]/5 p-3">
                  <p className="text-sm font-semibold text-[var(--swift-red)]">{OUT_OF_STOCK_WORDS.lastAsk}</p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" disabled={reject.isPending} onClick={() => { setLastOut(false); reject.mutate(OUT_OF_STOCK_WORDS.lastReason); }} className="min-h-11 rounded-lg bg-[var(--swift-red)] px-4 text-sm font-semibold text-white disabled:opacity-50">{OUT_OF_STOCK_WORDS.lastYes}</button>
                    <button type="button" disabled={reject.isPending} onClick={() => setLastOut(false)} className="min-h-11 rounded-lg border border-[var(--swift-border)] px-4 text-sm font-semibold disabled:opacity-50">{OUT_OF_STOCK_WORDS.lastKeep}</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {isMmg && mmgMoneyMoved(o.paymentStatus) && <p className="mt-2 text-sm font-semibold text-[var(--swift-success)]">{mmgMovedLabel(o.paymentStatus)}</p>}

      {/* [U25] The money card, as on the phone: recorded amounts only. */}
      <section aria-label="Payment" className="mt-4 space-y-1 rounded-lg bg-[var(--swift-subtle)] p-3 text-sm">
        {orderMoneyRows(o).map((row) => (
          <div key={row.label} className={`flex justify-between gap-3 ${row.strong ? 'border-t border-[var(--swift-border)] pt-2 font-bold' : ''}`}>
            <span>{row.label}</span>
            <span>{row.minus && row.value !== null ? `-${money(row.value)}` : money(row.value)}</span>
          </div>
        ))}
        {orderPaymentLine(o) && <p className="pt-1 text-xs font-semibold text-[var(--swift-muted)]">{orderPaymentLine(o)}</p>}
      </section>

      {s === 'CANCELLED' && (
        <section aria-label="Cancellation" className="mt-3 rounded-lg bg-[var(--swift-red)]/5 p-3 text-sm">
          <p className="font-semibold text-[var(--swift-red)]">Cancelled{whenLabel(o.cancelledAt) ? ` ${whenLabel(o.cancelledAt)}` : ''}</p>
          {/* [UI-SWEEP U14] A code reads as words; a code this build does not know never shows. */}
          {cancellationReasonWords(o.cancellationReason, 'store') && <p className="mt-1 text-[var(--swift-muted)]">{cancellationReasonWords(o.cancellationReason, 'store')}</p>}
        </section>
      )}

      {/* [U02] A store that delivers itself must find and call the customer: the
          phone's Customer card. The server withholds the phone and address once
          the order is closed, so they simply are not there then. */}
      <section aria-label="Customer" className="mt-3 rounded-lg border border-[var(--swift-border)] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wide text-[var(--swift-muted)]">Customer</p>
            <p className="break-words text-sm font-semibold">{customer}</p>
          </div>
          {/* [O-1] Bridge off: today's tel: link. Bridge on: "Call via Swift" (no number on this page). */}
          <CallPartyButton orderId={o.id} target="customer" phone={o.customer?.phone} label="Call" icon={false} ariaLabel={`Call ${customer}`} className="inline-flex min-h-11 shrink-0 items-center rounded-lg border border-[var(--swift-border)] px-4 text-sm font-semibold hover:bg-[var(--swift-subtle)]" noteClassName="w-full text-xs text-[var(--swift-muted)]" />
        </div>
        {[...customerLines(o), ...(o.fulfillment === 'PICKUP' && o.deliveryInstructions ? [o.deliveryInstructions] : [])].map((line, i) => (
          <p key={i} className="mt-1.5 break-words text-sm text-[var(--swift-muted)]">{line}</p>
        ))}
      </section>

      {riderAssigned && (
        <section aria-label="Rider" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--swift-border)] p-3">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wide text-[var(--swift-muted)]">Rider</p>
            <p className="break-words text-sm font-semibold">{riderName || 'Swift rider'}</p>
          </div>
          <CallPartyButton orderId={o.id} target="rider" phone={o.rider?.user?.phone} label="Call" icon={false} ariaLabel={`Call ${riderName || 'the rider'}`} className="inline-flex min-h-11 shrink-0 items-center rounded-lg border border-[var(--swift-border)] px-4 text-sm font-semibold hover:bg-[var(--swift-subtle)]" noteClassName="w-full text-xs text-[var(--swift-muted)]" />
          {/* [STORE-DASH · O-2] The rider's photo, first name and vehicle, checked before "Handed to rider"; then that it went. */}
          {/* [REVIEW-F S3-1/S4-1 on #2054] Only beside "Handed to rider" (never before ready, never while paused), as on the phone. */}
          {actions.some((a) => a.kind === 'handed-to-rider') && <div className="w-full"><RiderHandoverLine rider={o.rider} /></div>}
          {o.handedToRiderAt && <p className="w-full text-sm font-semibold text-[var(--swift-muted)]">{HANDOVER_WORDS.handedToRider}</p>}
        </section>
      )}

      {/* [AF-MOB-006 · U25] A delivery that went wrong after pickup: the server's
          words, and the store's one action once the goods are on their way back. */}
      {recovery && (
        <section aria-label="Delivery recovery" className={`mt-3 rounded-lg p-3 text-sm ${recovery.open ? 'bg-amber-50' : 'bg-[var(--swift-subtle)]'}`}>
          <p className="font-bold">{recovery.headline}</p>
          <p className="mt-1 text-[var(--swift-muted)]">{recovery.body}</p>
          {storeCanConfirmReturn(recovery, o) && (
            <button
              onClick={() => act.mutate('return-received')}
              disabled={act.isPending}
              className="mt-3 min-h-11 rounded-lg bg-[var(--swift-red)] px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              {act.isPending && act.variables === 'return-received' ? 'Confirming…' : 'The order is back with us'}
            </button>
          )}
        </section>
      )}
      {activeDelivery && (
        <section className="mt-3 rounded-lg bg-[var(--swift-subtle)] p-3" aria-label="Delivery owner">
          <p className="text-sm font-semibold">
            {deliveryOwnerTitle}
          </p>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">
            {deliveryOwnerDescription}
          </p>
          {(canChooseVendorDelivery || canChoosePlatformRider) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {canChooseVendorDelivery && (
                <button
                  onClick={() => act.mutate('vendor-delivery')}
                  disabled={act.isPending}
                  className="rounded-lg border border-[var(--swift-border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--swift-card)] disabled:opacity-50"
                >
                  We’ll deliver
                </button>
              )}
              {canChoosePlatformRider && (
                <button
                  onClick={() => act.mutate('platform-rider')}
                  disabled={act.isPending}
                  className="rounded-lg border border-[var(--swift-border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--swift-card)] disabled:opacity-50"
                >
                  Get a Swift rider
                </button>
              )}
            </div>
          )}
        </section>
      )}
      {/* HND-003: the vendor VERIFIES the pickup code, it never READS it — both
          vendor routes strip the column, so this hint used to be gated on a
          field that can never arrive and therefore never rendered. Driven now
          by `fulfillment`, which the API does send; every PICKUP order is
          issued a code at creation (order.service.ts). The code itself stays
          off this screen. */}
      {/* [REVIEW-F S4-3 on #2054] Not on a closed order; with the code off, the name and order-number
          check (never a hand-over prompt while paused — storeHandover.pickupCheckWords). */}
      {o.fulfillment === 'PICKUP' && !['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'].includes(s) && (
        <p className="mt-3 text-sm text-[var(--swift-muted)]">{pickupCheckWords(o, paused) ?? 'Customer collects with a pickup code.'}</p>
      )}

      {/* [STORE-DASH] The lines are ticked on the order's own state, never on the board's copy. */}
      {pickable && !order.isPlaceholderData && <PickList order={o} onBusy={act.isPending} />}

      {/* [STORE-DASH] Payment and rider notes stay with the order; its next step is the bar at the bottom. */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {payBlockedReason && (
          <p className="w-full text-sm text-[var(--swift-muted)]">{payBlockedReason}</p>
        )}
        {confirmPayNeedsManager && (
          <p className="w-full text-sm text-[var(--swift-muted)]">Only the owner or a manager can confirm MMG payments.</p>
        )}
        {showConfirmPay && (
          <input
            value={mmgRef}
            onChange={(e) => setMmgRef(e.target.value)}
            placeholder="MMG transaction reference"
            aria-label="MMG transaction reference"
            className="rounded-lg border border-[var(--swift-border)] px-3 py-2 text-sm"
          />
        )}
        {/* [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] One plainly worded button: the store taps it when
            it sees the money in its own MMG account. Swift never checks the money itself. */}
        {showConfirmPay && (
          <p className="w-full text-sm text-[var(--swift-muted)]">Tap when {money(o.totalAmount)} is in your MMG account.</p>
        )}
        {/* [owner 18 Oct 2026] Not marked "Paid by MMG" within 30 minutes of acceptance = cancelled. */}
        {showConfirmPay && typeof o.mmgPayByLine === 'string' && o.mmgPayByLine.trim() !== '' && (
          <p className="w-full text-sm font-semibold">{o.mmgPayByLine}</p>
        )}
        {showConfirmPay && (
          <button
            onClick={() => act.mutate('confirm-payment')}
            disabled={act.isPending || mmgRef.trim().length < 4}
            className="rounded-lg border border-green-600/30 px-4 py-2 text-sm font-semibold text-green-700 hover:bg-green-50 disabled:opacity-50"
          >
            Paid by MMG
          </button>
        )}
        {/* [S4 · phone VendorOrderDetailScreen "No rider yet"] The same states and
            words as the phone; the server no-ops while an offer is live. */}
        {!paused && isDelivery && !selfDelivery && !riderAssigned && ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(s) && (
          <section aria-label="No rider yet" className="w-full rounded-lg bg-[var(--swift-subtle)] p-3">
            <p className="text-sm font-semibold">No rider yet</p>
            <p className="mt-1 text-sm text-[var(--swift-muted)]">Swift searches nearby movers automatically — retry if nobody took it.</p>
            <button
              onClick={() => act.mutate('retry-dispatch')}
              disabled={act.isPending}
              className="mt-3 min-h-11 rounded-lg border border-[var(--swift-border)] px-4 text-sm font-semibold hover:bg-[var(--swift-card)] disabled:opacity-50"
            >
              Find a rider
            </button>
          </section>
        )}
      </div>

      {/* [U25] The immutable status log, oldest first, and the quoted prep time — as on the phone. */}
      {timeline.length > 0 && (
        <section aria-label="Timeline" className="mt-5 border-t border-[var(--swift-border)] pt-4">
          <h3 className="text-sm font-bold">Timeline</h3>
          <ol className="mt-2 space-y-2">
            {timeline.map((entry, i) => (
              <li key={i} className="text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-semibold">{vendorStatusLabel(entry.status)}</span>
                  <span className="text-xs text-[var(--swift-muted)]">{whenLabel(entry.createdAt)}</span>
                </div>
                {entry.note && <p className="break-words text-xs text-[var(--swift-muted)]">{entry.note}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}
      {prepLine && <p className="mt-3 text-xs text-[var(--swift-muted)]">{prepLine}</p>}
      {/* [STORE-DASH · owner 22 Oct "fast taps"] The next step is a big button in a bar that stays at the
          bottom of the window while it scrolls, as on the phone (VendorOrderDetailScreen action bar). */}
      {(actions.length > 0 || confirmDelivered || confirmReject || error) && (
        <div data-testid="order-action-bar" className="sticky bottom-0 z-10 -mx-6 -mb-6 mt-5 flex flex-wrap items-center gap-2 border-t border-[var(--swift-border)] bg-[var(--swift-card)] px-6 py-4">
          {!paused && customerDeciding(o) && <p role="status" className="w-full text-sm font-semibold text-amber-800">{OUT_OF_STOCK_WORDS.deciding}</p>}
          {!paused && nothingToAccept(o) && <p role="status" className="w-full text-sm font-semibold text-[var(--swift-red)]">{OUT_OF_STOCK_WORDS.nothing}</p>}
          {actions.map((a) => (
            <span key={a.kind} className="flex min-w-0 flex-1 items-center gap-2">
              {a.kind === 'accept' && o.fulfillment !== 'APPOINTMENT' && (
                <select
                  value={prepTime}
                  onChange={(e) => setPrepTime(Number(e.target.value))}
                  aria-label="Preparation time"
                  className="rounded-lg border border-[var(--swift-border)] px-2 py-2 text-sm"
                >
                  {[10, 15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m} min prep</option>)}
                </select>
              )}
              {a.kind === 'complete-pickup' && (
                <input
                  value={pickupCode}
                  onChange={(e) => setPickupCode(e.target.value)}
                  placeholder="Pickup code"
                  aria-label="Pickup code"
                  className="w-32 rounded-lg border border-[var(--swift-border)] px-2 py-2 text-sm"
                />
              )}
              <button
                onClick={() =>
                  a.kind === 'delivered'
                    ? setConfirmDelivered(true)
                    : a.kind === 'reject'
                      ? setConfirmReject(true)
                      : act.mutate(a.kind)}
                aria-busy={act.isPending && act.variables === a.kind}
                disabled={act.isPending || reject.isPending || (a.kind === 'complete-pickup' && pickupCode.trim().length < 4)}
                className={`min-h-12 flex-1 rounded-xl px-5 py-3 text-base font-bold disabled:opacity-50 ${
                  a.tone === 'danger'
                    ? 'border border-[var(--swift-red)]/30 text-[var(--swift-red)] hover:bg-[var(--swift-red)]/5'
                    : 'bg-[var(--swift-red)] text-white hover:bg-[var(--swift-red-600)]'
                }`}
              >
                {a.label}
              </button>
            </span>
          ))}
          {confirmDelivered && !paused && (
            <div role="dialog" aria-label="Confirm store delivery" className="w-full rounded-xl border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-950">Did your store hand this order to the customer?</p>
              <p className="mt-1 text-sm text-amber-900">Only confirm after the handoff. This closes the order as delivered.</p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => {
                    setConfirmDelivered(false);
                    act.mutate('delivered');
                  }}
                  disabled={act.isPending}
                  className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  Yes, delivered
                </button>
                <button
                  onClick={() => setConfirmDelivered(false)}
                  disabled={act.isPending}
                  className="rounded-lg border border-[var(--swift-border)] px-4 py-2 text-sm font-semibold disabled:opacity-50"
                >
                  Not yet
                </button>
              </div>
            </div>
          )}
          {confirmReject && (
            <div role="dialog" aria-label={order.data?.fulfillment === 'APPOINTMENT' ? 'Confirm booking decline' : 'Confirm order rejection'} className="w-full rounded-xl border border-[var(--swift-red)]/30 bg-[var(--swift-red)]/5 p-4">
              <p className="text-sm font-semibold text-[var(--swift-red)]">{order.data?.fulfillment === 'APPOINTMENT' ? 'Decline this booking?' : 'Reject this order?'}</p>
              <p className="mt-1 text-sm text-[var(--swift-muted)]">The customer is told right away — pick what happened. This can’t be undone.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {rejectReasonsFor(order.data?.fulfillment).map((why) => (
                  <button
                    key={why}
                    onClick={() => reject.mutate(why)}
                    disabled={reject.isPending}
                    className="rounded-lg border border-[var(--swift-red)]/30 px-4 py-2 text-sm font-semibold text-[var(--swift-red)] hover:bg-[var(--swift-red)]/5 disabled:opacity-50"
                  >
                    {why}
                  </button>
                ))}
                <button
                  onClick={() => setConfirmReject(false)}
                  disabled={reject.isPending}
                  className="rounded-lg border border-[var(--swift-border)] px-4 py-2 text-sm font-semibold disabled:opacity-50"
                >
                  Keep it
                </button>
              </div>
            </div>
          )}
          {error && <p role="alert" className="w-full text-sm text-[var(--swift-red)]">{error}</p>}
        </div>
      )}
    </div>
  );
}

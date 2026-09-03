'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import NewOrderTakeover from '@/components/NewOrderTakeover';
import { MutationNotice } from '@/components/mutation-notice';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { BUCKETS, type BucketKey, completeness, groupOrders } from '@/lib/order-buckets';
import { DataUnavailable } from '@/components/data-unavailable';
import {
  acceptOrder, completePickup, confirmPayment, getItems, getOrder, getOrders,
  markPreparing, markReady, money, proposeSubstitution, refundLine, rejectOrder,
  retryDispatch, setPicked, type OrderLine, type VendorOrder,
} from '@/lib/vendor-api';

// Board buckets — same lanes the kitchen thinks in.

const COURIER_ACTIVE = ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'];
const PICKABLE_STATES = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', ...COURIER_ACTIVE];

function timeAgo(iso?: string) {
  if (!iso) return '';
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

function statusChip(s: string) {
  const done = ['DELIVERED', 'COMPLETED'].includes(s);
  const dead = s === 'CANCELLED';
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
        done ? 'bg-green-100 text-green-700' : dead ? 'bg-black/5 text-[var(--swift-muted)]' : 'bg-[var(--swift-red)]/10 text-[var(--swift-red)]'
      }`}
    >
      {s.replaceAll('_', ' ')}
    </span>
  );
}

/** Mirrors the mobile app's orderActions — one source of truth for what a
 *  vendor may do in each state (timestamps keep working after a rider claims). */
function actionsFor(o: VendorOrder) {
  const s = (o.status || '').toUpperCase();
  const isPickup = o.fulfillment === 'PICKUP';
  const isAppt = o.fulfillment === 'APPOINTMENT';
  const out: Array<{ label: string; kind: string; tone?: 'danger' }> = [];
  if (s === 'PENDING' || s === 'PLACED') {
    out.push({ label: 'Accept', kind: 'accept' }, { label: isAppt ? 'Decline' : 'Reject', kind: 'reject', tone: 'danger' });
  } else if (isAppt && (s === 'ACCEPTED' || s === 'CONFIRMED')) {
    out.push({ label: 'Mark complete', kind: 'complete-appointment' });
  } else if (s === 'ACCEPTED' || s === 'CONFIRMED') {
    out.push({ label: 'Start preparing', kind: 'preparing' });
  } else if (s === 'PREPARING') {
    out.push({ label: isPickup ? 'Ready for pickup' : 'Mark ready', kind: 'ready' });
  } else if (COURIER_ACTIVE.includes(s)) {
    if (!o.preparingAt) out.push({ label: 'Start preparing', kind: 'preparing' });
    else if (!o.readyAt) out.push({ label: 'Mark ready', kind: 'ready' });
  } else if ((s === 'READY' || s === 'READY_FOR_PICKUP') && isPickup) {
    out.push({ label: 'Mark picked up', kind: 'complete-pickup' });
  }
  return out;
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
  const fulfilled = order.items.filter(lineFulfilled).length;
  const removed = order.items.length - open - fulfilled;
  const pickingSummary =
    open > 0
      ? `Shelf picking — ${open} to pick`
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
    <div className="mt-4 rounded-xl border border-black/5 bg-[var(--swift-subtle)] p-4">
      <p className={`text-sm font-bold${open === 0 && fulfilled === 0 ? ' text-[var(--swift-red)]' : ''}`}>{pickingSummary}</p>
      <MutationNotice errors={[pickedMut.error, subMut.error, refundMut.error]} className="mt-2" />
      <div className="mt-2 space-y-2">
        {order.items.map((it) => (
          <div key={it.id} className="rounded-lg bg-white p-3">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={!!it.picked}
                disabled={busy || it.subStatus === 'PROPOSED' || it.subStatus === 'REFUNDED'}
                onChange={(e) => pickedMut.mutate({ lineId: it.id, picked: e.target.checked })}
                className="h-4 w-4 accent-[var(--swift-red)]"
              />
              <span className="flex-1 text-sm">
                <b>{it.quantity}×</b> {it.name}
              </span>
              {it.subStatus === 'PROPOSED' && (
                <span className="text-xs font-semibold text-amber-600">Waiting on customer: {it.substituteName}</span>
              )}
              {/* [W-27] "Refunded" said money came back. On a cash order none
                  ever left: the line is removed and the bill is smaller at the
                  door. MMG line changes are refused outright by the server, so
                  there is no tender here on which a refund could be owed. */}
              {it.subStatus === 'REFUNDED' && <span className="text-xs font-semibold text-[var(--swift-muted)]">Removed — not charged</span>}
              {it.subStatus === 'REJECTED' && <span className="text-xs font-semibold text-[var(--swift-red)]">Sub declined</span>}
              {!it.picked && !it.subStatus?.match(/PROPOSED|REFUNDED/) && (
                <button
                  onClick={() => setSubFor(subFor === it.id ? null : it.id)}
                  disabled={busy}
                  className="text-xs font-semibold text-[var(--swift-red)] hover:underline"
                >
                  Out of stock?
                </button>
              )}
            </div>
            {subFor === it.id && (
              <div className="mt-2 border-t border-black/5 pt-2">
                <p className="text-xs font-semibold text-[var(--swift-muted)]">Offer a substitute:</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {candidates(it).map((c) => (
                    <button
                      key={c.id}
                      onClick={() => subMut.mutate({ lineId: it.id, substituteItemId: c.id })}
                      disabled={busy}
                      className="rounded-full border border-black/10 px-2.5 py-1 text-xs hover:border-[var(--swift-red)]"
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

function OrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const storeId = useStoreId();
  const order = useQuery({ queryKey: storeKey(storeId, 'order', id), queryFn: () => getOrder(id), refetchInterval: 10_000 });
  const [prepTime, setPrepTime] = useState(20);
  const [pickupCode, setPickupCode] = useState('');
  // [W-25] The store's attestation carries the provider reference from its own
  // wallet message. Without one there is nothing to reconcile against later.
  const [mmgRef, setMmgRef] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'order', id) });
    queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'orders') });
  };
  const act = useMutation({
    mutationFn: async (kind: string) => {
      setError(null);
      if (kind === 'accept') return acceptOrder(id, prepTime);
      if (kind === 'reject') return rejectOrder(id);
      if (kind === 'preparing') return markPreparing(id);
      if (kind === 'ready') return markReady(id);
      if (kind === 'complete-pickup') return completePickup(id, pickupCode.trim());
      if (kind === 'complete-appointment') {
        const { apiFetch } = await import('@/lib/auth');
        return apiFetch(`/api/v1/vendor/orders/${id}/complete-appointment`, { method: 'PUT', body: '{}' });
      }
      if (kind === 'confirm-payment') return confirmPayment(id, mmgRef.trim());
      if (kind === 'retry-dispatch') return retryDispatch(id);
      throw new Error(`Unknown action ${kind}`);
    },
    onError: (e) => setError((e as Error).message),
    onSettled: refresh,
  });

  // `preparingAt` / `readyAt` / `paymentStatus` are declared on VendorOrder now
  // (the detail route returns the whole Order row) — no local re-declaration.
  const o = order.data;
  if (!o) return <div className="rounded-2xl border border-black/5 bg-white p-6 text-sm text-[var(--swift-muted)]">Loading…</div>;

  const s = (o.status || '').toUpperCase();
  const actions = actionsFor(o);
  const pickable = ['SUPERMARKET', 'STORE'].includes(o.vendor?.vendorType ?? '') && PICKABLE_STATES.includes(s);
  const isMmg = o.paymentMethod === 'MOBILE_MONEY';
  // [W-25] The old predicate was "not captured and not cancelled", so a
  // FAILED, REFUNDED or UNRESOLVED payment offered a one-tap "received" — a
  // tap on a reversed payment recaptured a refund. A store may attest only
  // where money plausibly landed and nothing has reversed or resolved it; the
  // server enforces the same matrix and refuses the rest by name.
  const ATTESTABLE_PAYMENT = ['PENDING', 'AUTHORIZED'];
  const showConfirmPay =
    isMmg && ATTESTABLE_PAYMENT.includes(String(o.paymentStatus ?? '')) && !['CANCELLED', 'REFUNDED', 'FAILED'].includes(s);
  // and when it is NOT attestable, the screen says why rather than going quiet
  const payBlockedReason =
    isMmg && !showConfirmPay && o.paymentStatus !== 'CAPTURED'
      ? {
          REFUNDED: 'This payment was refunded — a new payment is a new transaction.',
          PARTIALLY_REFUNDED: 'This payment was partly refunded — support settles the balance.',
          FAILED: 'MMG reports this payment as failed. Contact support with the reference if money did reach you.',
          EXPIRED: 'The payment window closed — ask the customer to pay again.',
          UNKNOWN: 'This payment is unresolved with MMG. Support settles it; it cannot be marked received here.',
          CANCELLED: 'This payment was superseded.',
        }[String(o.paymentStatus ?? '')] ?? null
      : null;
  const customer = [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ') || 'Customer';
  const rider = o.rider?.user ? [o.rider.user.firstName, o.rider.user.lastName].filter(Boolean).join(' ') : null;

  return (
    <div className="rounded-2xl border border-black/5 bg-white p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-extrabold">#{o.orderNumber}</p>
          <p className="mt-0.5 text-sm text-[var(--swift-muted)]">
            {customer} · {timeAgo(o.placedAt)} · {o.fulfillment ?? o.orderType}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {statusChip(s)}
          <button onClick={onClose} className="text-sm text-[var(--swift-muted)] hover:text-[var(--swift-ink)]">✕</button>
        </div>
      </div>

      <div className="mt-4 space-y-1.5">
        {o.items.map((it) => (
          <div key={it.id} className="flex justify-between text-sm">
            <span><b>{it.quantity}×</b> {it.name}{it.specialInstructions ? <i className="text-[var(--swift-muted)]"> — {it.specialInstructions}</i> : null}</span>
            <span className="font-medium">{money(it.totalCustomer)}</span>
          </div>
        ))}
        <div className="flex justify-between border-t border-black/5 pt-2 text-sm font-bold">
          <span>Total ({o.paymentMethod === 'MOBILE_MONEY' ? 'MMG' : 'Cash'})</span>
          <span>{money(o.totalAmount)}</span>
        </div>
      </div>

      {o.deliveryInstructions && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Note: {o.deliveryInstructions}</p>}
      {rider && <p className="mt-3 text-sm text-[var(--swift-muted)]">Rider: <b className="text-[var(--swift-ink)]">{rider}</b> {o.rider?.user?.phone}</p>}
      {/* HND-003: the vendor VERIFIES the pickup code, it never READS it — both
          vendor routes strip the column, so this hint used to be gated on a
          field that can never arrive and therefore never rendered. Driven now
          by `fulfillment`, which the API does send; every PICKUP order is
          issued a code at creation (order.service.ts). The code itself stays
          off this screen. */}
      {o.fulfillment === 'PICKUP' && s !== 'COMPLETED' && (
        <p className="mt-3 text-sm text-[var(--swift-muted)]">Customer collects with a pickup code.</p>
      )}

      {pickable && <PickList order={o} onBusy={act.isPending} />}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {actions.map((a) => (
          <span key={a.kind} className="flex items-center gap-2">
            {a.kind === 'accept' && (
              <select
                value={prepTime}
                onChange={(e) => setPrepTime(Number(e.target.value))}
                className="rounded-lg border border-black/10 px-2 py-2 text-sm"
              >
                {[10, 15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m} min prep</option>)}
              </select>
            )}
            {a.kind === 'complete-pickup' && (
              <input
                value={pickupCode}
                onChange={(e) => setPickupCode(e.target.value)}
                placeholder="Pickup code"
                className="w-32 rounded-lg border border-black/10 px-2 py-2 text-sm"
              />
            )}
            <button
              onClick={() => act.mutate(a.kind)}
              disabled={act.isPending || (a.kind === 'complete-pickup' && pickupCode.trim().length < 4)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50 ${
                a.tone === 'danger'
                  ? 'border border-[var(--swift-red)]/30 text-[var(--swift-red)] hover:bg-[var(--swift-red)]/5'
                  : 'bg-[var(--swift-red)] text-white hover:bg-[var(--swift-red-600)]'
              }`}
            >
              {a.label}
            </button>
          </span>
        ))}
        {payBlockedReason && (
          <p className="w-full text-sm text-[var(--swift-muted)]">{payBlockedReason}</p>
        )}
        {showConfirmPay && (
          <input
            value={mmgRef}
            onChange={(e) => setMmgRef(e.target.value)}
            placeholder="MMG transaction reference"
            aria-label="MMG transaction reference"
            className="rounded-lg border border-black/10 px-3 py-2 text-sm"
          />
        )}
        {showConfirmPay && (
          <button
            onClick={() => act.mutate('confirm-payment')}
            disabled={act.isPending || mmgRef.trim().length < 4}
            className="rounded-lg border border-green-600/30 px-4 py-2 text-sm font-semibold text-green-700 hover:bg-green-50 disabled:opacity-50"
          >
            {money(o.totalAmount)} received in my MMG
          </button>
        )}
        {s === 'READY_FOR_PICKUP' && o.fulfillment !== 'PICKUP' && !rider && (
          <button
            onClick={() => act.mutate('retry-dispatch')}
            disabled={act.isPending}
            className="rounded-lg border border-black/10 px-4 py-2 text-sm font-semibold hover:bg-[var(--swift-subtle)] disabled:opacity-50"
          >
            Search for a rider again
          </button>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-[var(--swift-red)]">{error}</p>}
    </div>
  );
}

export default function OrdersPage() {
  const storeId = useStoreId();
  const [bucket, setBucket] = useState<BucketKey>('new');
  const [selected, setSelected] = useState<string | null>(null);

  // One poll feeds every lane — the queue is the live surface, keep it fresh.
  const orders = useQuery({
    queryKey: storeKey(storeId, 'orders'),
    queryFn: () => getOrders({ limit: 100 }),
    refetchInterval: 10_000,
  });

  const all = useMemo(() => orders.data?.orders ?? [], [orders.data]);
  // [W-11] Exhaustive: every order lands in exactly one lane, including an
  // `unknown` lane for a status this build does not recognise. The old loop
  // pushed only on a match and silently dropped everything else.
  const byBucket = useMemo(() => groupOrders(all), [all]);
  const shown = useMemo(() => completeness(all.length, orders.data?.meta), [all.length, orders.data?.meta]);

  const list = byBucket.get(bucket) ?? [];

  return (
    <div className="space-y-5">
      <NewOrderTakeover orders={all} />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-extrabold">Orders</h1>
        <button
          onClick={() => orders.refetch()}
          className="flex items-center gap-2 rounded-lg border border-black/10 bg-white px-3 py-2 text-sm font-medium hover:bg-[var(--swift-subtle)]"
        >
          <RefreshCw className={`h-4 w-4 ${orders.isFetching ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {BUCKETS.map((b) => {
          const n = byBucket.get(b.key)?.length ?? 0;
          // the exception lanes appear the moment they hold anything
          if ((b.key === 'unknown' || b.key === 'attention') && n === 0) return null;
          return (
            <button
              key={b.key}
              onClick={() => setBucket(b.key)}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                bucket === b.key ? 'bg-[var(--swift-red)] text-white' : 'border border-black/10 bg-white hover:bg-[var(--swift-subtle)]'
              }`}
            >
              {b.label}{n > 0 ? ` · ${n}` : ''}
            </button>
          );
        })}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_1.2fr]">
        <div className="space-y-2">
          {orders.isLoading && <p className="text-sm text-[var(--swift-muted)]">Loading…</p>}
          {/* [W-11] A failed read used to render the same calm "Nothing in New"
              as a genuinely empty queue, so an outage looked like a clear board
              while orders piled up against the response SLA. */}
          {orders.isError && (
            <DataUnavailable what="your orders" error={orders.error} onRetry={() => void orders.refetch()} />
          )}
          {/* [W-11] The board asks for 100 and used to ignore `meta` entirely,
              so a vendor with more than that silently never saw the rest. */}
          {!orders.isError && !orders.isLoading && shown.missing > 0 && (
            <p role="status" className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
              Showing {shown.shown} of {shown.total} orders — {shown.missing} not shown on this page.
            </p>
          )}
          {!orders.isLoading && !orders.isError && list.length === 0 && (
            <p className="rounded-2xl border border-dashed border-black/10 p-8 text-center text-sm text-[var(--swift-muted)]">
              Nothing in “{BUCKETS.find((b) => b.key === bucket)?.label}”.
            </p>
          )}
          {list.map((o) => (
            <button
              key={o.id}
              onClick={() => setSelected(o.id)}
              className={`block w-full rounded-2xl border bg-white p-4 text-left transition-colors ${
                selected === o.id ? 'border-[var(--swift-red)]' : 'border-black/5 hover:border-black/15'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-bold">#{o.orderNumber}</p>
                {statusChip((o.status || '').toUpperCase())}
              </div>
              <p className="mt-1 text-sm text-[var(--swift-muted)]">
                {[o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ')} · {o.items.length}{' '}
                {o.items.length === 1 ? 'item' : 'items'} · {money(o.totalAmount)} · {timeAgo(o.placedAt)}
              </p>
              {o.vendor?.name && <p className="mt-0.5 text-xs text-[var(--swift-muted)]">{o.vendor.name}</p>}
            </button>
          ))}
        </div>
        <div className="xl:sticky xl:top-6 xl:self-start">
          {selected ? (
            <OrderDetail id={selected} onClose={() => setSelected(null)} />
          ) : (
            <p className="rounded-2xl border border-dashed border-black/10 p-8 text-center text-sm text-[var(--swift-muted)]">
              Select an order to work it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

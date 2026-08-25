'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import NewOrderTakeover from '@/components/NewOrderTakeover';
import { MutationNotice } from '@/components/mutation-notice';
import {
  acceptOrder, completePickup, confirmPayment, getItems, getOrder, getOrders,
  markPreparing, markReady, money, proposeSubstitution, refundLine, rejectOrder,
  retryDispatch, setPicked, type OrderLine, type VendorOrder,
} from '@/lib/vendor-api';

// Board buckets — same lanes the kitchen thinks in.
const BUCKETS = [
  { key: 'new', label: 'New', match: (s: string) => s === 'PENDING' || s === 'PLACED' },
  { key: 'kitchen', label: 'In progress', match: (s: string) => ['ACCEPTED', 'CONFIRMED', 'PREPARING'].includes(s) },
  {
    key: 'handoff', label: 'Ready / handoff',
    match: (s: string) => ['READY', 'READY_FOR_PICKUP', 'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'].includes(s),
  },
  { key: 'moving', label: 'Out for delivery', match: (s: string) => ['PICKED_UP', 'RIDER_EN_ROUTE_DROPOFF'].includes(s) },
  { key: 'done', label: 'Done', match: (s: string) => ['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(s) },
] as const;

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
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['order', order.id] });
    queryClient.invalidateQueries({ queryKey: ['orders'] });
  };
  const items = useQuery({ queryKey: ['items', 'all'], queryFn: () => getItems() });
  const [subFor, setSubFor] = useState<string | null>(null);

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

  const lineResolved = (l: OrderLine) => l.picked || l.subStatus === 'REFUNDED' || l.subStatus === 'REJECTED';
  const open = order.items.filter((l) => !lineResolved(l)).length;
  const busy = onBusy || pickedMut.isPending || subMut.isPending || refundMut.isPending;

  return (
    <div className="mt-4 rounded-xl border border-black/5 bg-[var(--swift-subtle)] p-4">
      <p className="text-sm font-bold">{open === 0 ? 'All picked ✓' : `Shelf picking — ${open} to pick`}</p>
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
              {it.subStatus === 'REFUNDED' && <span className="text-xs font-semibold text-[var(--swift-muted)]">Refunded</span>}
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
                  <button
                    onClick={() => refundMut.mutate(it.id)}
                    disabled={busy}
                    className="rounded-full bg-black/5 px-2.5 py-1 text-xs font-semibold"
                  >
                    No substitute — refund line
                  </button>
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
  const order = useQuery({ queryKey: ['order', id], queryFn: () => getOrder(id), refetchInterval: 10_000 });
  const [prepTime, setPrepTime] = useState(20);
  const [pickupCode, setPickupCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['order', id] });
    queryClient.invalidateQueries({ queryKey: ['orders'] });
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
      if (kind === 'confirm-payment') return confirmPayment(id);
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
  const showConfirmPay = isMmg && o.paymentStatus !== 'CAPTURED' && !['CANCELLED'].includes(s);
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
        {showConfirmPay && (
          <button
            onClick={() => act.mutate('confirm-payment')}
            disabled={act.isPending}
            className="rounded-lg border border-green-600/30 px-4 py-2 text-sm font-semibold text-green-700 hover:bg-green-50 disabled:opacity-50"
          >
            MMG payment received
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
  const [bucket, setBucket] = useState<(typeof BUCKETS)[number]['key']>('new');
  const [selected, setSelected] = useState<string | null>(null);

  // One poll feeds every lane — the queue is the live surface, keep it fresh.
  const orders = useQuery({
    queryKey: ['orders'],
    queryFn: () => getOrders({ limit: 100 }),
    refetchInterval: 10_000,
  });

  const all = useMemo(() => orders.data?.orders ?? [], [orders.data]);
  const byBucket = useMemo(() => {
    const map = new Map<string, VendorOrder[]>();
    for (const b of BUCKETS) map.set(b.key, []);
    for (const o of all) {
      const b = BUCKETS.find((x) => x.match((o.status || '').toUpperCase()));
      if (b) map.get(b.key)!.push(o);
    }
    return map;
  }, [all]);

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
          {!orders.isLoading && list.length === 0 && (
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

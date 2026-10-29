'use client';

import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchDashboard, fetchDeliveryPause, fetchSlaBreaches, setDeliveryPause, type DeliveryPause, type SlaBreach } from '@/lib/api';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { label } from '@/lib/labels';
import { gyTime } from '@/lib/dates';

// ---------------------------------------------------------------------------
// [RIDER-SAFE 5/6 · COORD rulings 29 Oct 2026] Delivery when riders run short.
//
//   · Riders now: free riders (online, empty hands) beside the orders waiting
//     for one — the same two figures as Today.
//   · Swift's pause switch: stop NEW delivery orders platform-wide or in the
//     chosen zones. Pickup stays open and placed orders carry on. A reason is
//     required and every change is a version in the record (C3). The switch
//     shows what the SERVER holds; nothing is shown as changed before it says so.
//   · Late orders: live delivery orders past a stage's time, worst first, each
//     opening its order.
// ---------------------------------------------------------------------------

const STAGE_WORDS: Record<NonNullable<SlaBreach['openStage']>, string> = {
  ACCEPT: 'Waiting for the store to accept',
  PREP: 'Being prepared',
  PICKUP_WAIT: 'Ready, waiting for a rider',
  DELIVERY: 'On the way to the customer',
};

function minutesLate(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m === 1 ? '1 min over' : `${m} min over`;
}

export default function DeliveryPage() {
  return (
    <div className="mc-page">
      <p className="mc-muted text-sm mb-6 max-w-3xl">
        When riders run short, delivery is protected in three ways: checkout tells customers the honest wait (or offers
        pickup), a store with orders waiting for riders pauses its new delivery orders by itself, and Swift can pause
        delivery here. Pickup always stays open.
      </p>
      <RidersNow />
      <PauseSwitch />
      <LateOrders />
    </div>
  );
}

function RidersNow() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['dashboard'], queryFn: fetchDashboard, refetchInterval: 30_000 });
  const supply = data?.data?.riderSupply;
  return (
    <section className="mb-8">
      <h2 className="mc-section-title">Riders now</h2>
      {error ? (
        <QueryFailed error={error} what="the rider figures" onRetry={() => void refetch()} retrying={isFetching} />
      ) : isLoading ? (
        <p className="mc-muted">Loading…</p>
      ) : supply ? (
        <p className="text-sm">
          <span className="mc-numbers font-semibold">{supply.freeRiders}</span> free {supply.freeRiders === 1 ? 'rider' : 'riders'} ·{' '}
          <span className="mc-numbers font-semibold">{supply.waitingForRider}</span> {supply.waitingForRider === 1 ? 'order' : 'orders'} waiting for a rider
        </p>
      ) : (
        <p className="mc-muted text-sm">This server does not report the rider figures yet.</p>
      )}
    </section>
  );
}

function PauseSwitch() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['delivery-pause'], queryFn: fetchDeliveryPause });
  const pause = data?.data;
  const actions = useActionRunner(() => void qc.invalidateQueries({ queryKey: ['delivery-pause'] }));

  const change = (next: { platform: boolean; zoneIds: string[] }, current: DeliveryPause, what: string) => void actions.run({
    title: what,
    body: <p>New delivery orders are refused while it is paused; customers are offered pickup, and orders already placed carry on.</p>,
    confirmLabel: what,
    submit: ({ reason }) => setDeliveryPause({ ...next, expectedVersion: current.version }, reason),
    success: () => (next.platform || next.zoneIds.length > 0 ? 'Delivery is paused. Customers are offered pickup from now.' : 'Delivery is open again.'),
  });

  return (
    <section className="mb-8">
      <h2 className="mc-section-title">Pause delivery</h2>
      {actions.banner}
      {error ? (
        <QueryFailed error={error} what="the delivery pause" onRetry={() => void refetch()} retrying={isFetching} />
      ) : isLoading || !pause ? (
        <p className="mc-muted">Loading…</p>
      ) : (
        <div className="mc-card p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              {pause.platform
                ? <strong>Delivery is paused everywhere.</strong>
                : pause.zoneIds.length > 0
                  ? <strong>Delivery is paused in {pause.zoneIds.map((id) => pause.zones.find((z) => z.id === id)?.name ?? 'a zone that no longer exists').join(', ')}.</strong>
                  : 'Delivery is open.'}
              {pause.updatedAt ? <span className="mc-muted"> Last changed {gyTime(pause.updatedAt)}.</span> : null}
            </p>
            <button
              type="button"
              className={pause.platform ? 'mc-btn mc-btn-primary' : 'mc-btn'}
              onClick={() => change({ platform: !pause.platform, zoneIds: pause.zoneIds }, pause, pause.platform ? 'Open delivery everywhere' : 'Pause delivery everywhere')}
            >
              {pause.platform ? 'Open delivery everywhere' : 'Pause delivery everywhere'}
            </button>
          </div>
          <ZoneChoices pause={pause} onChange={(zoneIds, what) => change({ platform: pause.platform, zoneIds }, pause, what)} />
        </div>
      )}
    </section>
  );
}

function ZoneChoices({ pause, onChange }: { pause: DeliveryPause; onChange: (_zoneIds: string[], _what: string) => void }) {
  if (pause.zones.length === 0) return <p className="mc-muted text-sm">No zones are set up, so delivery can only be paused everywhere.</p>;
  return (
    <div>
      <p className="mc-label mb-2">By zone</p>
      <ul className="space-y-2">
        {pause.zones.map((z) => {
          const paused = pause.zoneIds.includes(z.id);
          return (
            <li key={z.id} className="flex items-center justify-between gap-3 text-sm">
              <span>{z.name} <span className="mc-muted">— {paused ? 'paused' : 'open'}</span></span>
              <button
                type="button"
                className="mc-btn"
                aria-label={paused ? `Open delivery in ${z.name}` : `Pause delivery in ${z.name}`}
                onClick={() => { onChange(paused ? pause.zoneIds.filter((id) => id !== z.id) : [...pause.zoneIds, z.id], paused ? `Open delivery in ${z.name}` : `Pause delivery in ${z.name}`); }}
              >
                {paused ? 'Open' : 'Pause'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LateOrders() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['sla-breaches'], queryFn: fetchSlaBreaches, refetchInterval: 60_000 });
  const rows = data?.data ?? [];
  return (
    <section>
      <h2 className="mc-section-title">Late delivery orders</h2>
      {/* [BUG-GUARDS C3] A failed read is never "nothing late": the table renders only once the read answered. */}
      {error ? (
        <QueryFailed error={error} what="the late orders" onRetry={() => void refetch()} retrying={isFetching} />
      ) : (
        <div className="mc-table-wrap overflow-x-auto">
          <table className="mc-table mc-table-auto">
            <thead>
              <tr>
                <th className="mc-label text-left">Order</th>
                <th className="mc-label text-left">Now</th>
                <th className="mc-label text-left">Stage running</th>
                <th className="mc-label text-right">Late by</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={4} className="mc-table-empty">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={4} className="mc-table-empty">No delivery order is past its time.</td></tr>
              ) : rows.map((r) => (
                <tr key={r.orderId}>
                  <td className="p-4"><Link href={`/orders/${encodeURIComponent(r.orderId)}`} className="mc-link">#{r.orderNumber}</Link></td>
                  <td className="p-4">{label('OrderStatus', r.status)}</td>
                  <td className="p-4">{r.openStage ? STAGE_WORDS[r.openStage] : 'Finished'}</td>
                  <td className="p-4 text-right">{minutesLate(r.worstOverMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data?.truncated ? <p className="mc-muted text-xs mt-2">Only the oldest {data.scanned} live orders were checked.</p> : null}
        </div>
      )}
    </section>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createSequence, freshness, mapEmbedUrl, mapLinkUrl, validPoint } from '@/lib/live-tracking';
import { BROWSER_API_ORIGIN as API_URL } from '@/lib/browser-api-origin';

// The polling client for the public parcel page [B9]. Renders exactly what
// the server said, marks how fresh it is, and degrades honestly: an unknown
// token is a clear "not active", a network blip keeps the last-good view and
// keeps retrying — never a spinner forever, never a dressed-up guess.

const POLL_MS = 5000;

interface ParcelView {
  orderNumber: string;
  status: string;
  courierRecipientName: string | null;
  pickupAddress: string | null;
  deliveryAddress: string | null;
  estimatedDeliveryTime: number | null;
  /** [W-47] `lastLocationUpdate` is the POSITION's own timestamp: the page shows how old the
   *  point is, not how recently it happened to fetch. */
  rider: { currentLat: number | null; currentLng: number | null; lastLocationUpdate?: string | null; user: { firstName: string | null } | null } | null;
}

/** The recipient's words for the courier state machine — a sentence, not an
 *  enum. Unknown states fall through to the raw value rather than lying. */
const STATUS_LABEL: Record<string, string> = {
  READY_FOR_PICKUP: 'Finding a courier',
  RIDER_ASSIGNED: 'Courier assigned',
  RIDER_EN_ROUTE_PICKUP: 'Courier heading to pickup',
  RIDER_ARRIVED_PICKUP: 'Courier at the pickup point',
  PICKED_UP: 'Parcel picked up',
  EN_ROUTE_DELIVERY: 'On the way to you',
  ARRIVED: 'Courier has arrived',
  DELIVERED: 'Delivered',
  COMPLETED: 'Delivered',
  CANCELLED: 'This delivery was cancelled',
};

const TERMINAL = new Set(['DELIVERED', 'COMPLETED', 'CANCELLED']);

export function TrackClient({ token }: { token: string }) {
  const [view, setView] = useState<ParcelView | null>(null);
  const [gone, setGone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [positionAt, setPositionAt] = useState<number | null>(null);
  const [serverTimed, setServerTimed] = useState(false);
  // [W-47] An INDEPENDENT clock. The age used to be derived during render from
  // a value that only changed on a SUCCESSFUL poll, so an outage froze
  // "Updated 4s ago" on screen for as long as it lasted. This ticks regardless.
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const sequence = useRef(createSequence());

  const load = useCallback(async () => {
    // [W-47] Every request takes a number and only the newest applies, so a
    // slow response landing after a newer one cannot move the courier backwards.
    const seq = sequence.current.next();
    try {
      const res = await fetch(`${API_URL}/api/v1/courier/track/${encodeURIComponent(token)}`, { cache: 'no-store' });
      if (res.status === 404) {
        if (!sequence.current.accept(seq)) return;
        setGone(true);
        setView(null);
        if (timer.current) clearInterval(timer.current);
        return;
      }
      const body = await res.json();
      if (body?.success && body.data) {
        if (!sequence.current.accept(seq)) return;
        const data = body.data as ParcelView;
        setView(data);
        // [W-47] The POSITION's own timestamp when the server sends one; the
        // arrival time only as a fallback, and the page says which it means.
        const serverAt = data.rider?.lastLocationUpdate ? Date.parse(data.rider.lastLocationUpdate) : NaN;
        const hasServerAt = Number.isFinite(serverAt);
        setServerTimed(hasServerAt);
        setPositionAt(hasServerAt ? serverAt : Date.now());
        setNow(Date.now());
        if (TERMINAL.has(data.status) && timer.current) clearInterval(timer.current);
      }
    } catch {
      // Network blip: keep the last-good view on screen. The freshness line
      // below keeps ageing it, so it stops claiming to be current.
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
    timer.current = setInterval(() => void load(), POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  // the clock that makes an outage visible
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const age = freshness(positionAt, now);
  const live = view ? !TERMINAL.has(view.status) : false;
  // [W-47] An unvalidated point rendered a map of wherever the numbers landed.
  const loc = validPoint(view?.rider?.currentLat, view?.rider?.currentLng);
  // and a position too old to trust is not shown as a live map at all
  const showMap = loc !== null && age.kind !== 'lost';
  const freshnessLabel = age.kind === 'none' ? null : serverTimed ? age.label : age.label.replace('Updated', 'Received');

  return (
    <main className="min-h-screen bg-[var(--swift-canvas)] text-[var(--swift-ink)]">
      <header className="bg-[var(--swift-red)] px-5 py-4">
        <p className="text-lg font-bold text-white">Swift — parcel tracking</p>
        {view ? (
          <p className="mt-0.5 text-sm text-white/85">
            Parcel {view.orderNumber}
            {view.courierRecipientName ? ` · for ${view.courierRecipientName}` : ''}
          </p>
        ) : null}
      </header>

      <div className="mx-auto max-w-md px-4 pb-12">
        {loading ? (
          <p className="pt-16 text-center text-sm text-[#786C6C]">Loading parcel…</p>
        ) : gone ? (
          <div className="pt-16 text-center">
            <p className="text-lg font-semibold">This tracking link isn&apos;t active</p>
            <p className="mt-2 text-sm text-[#786C6C]">
              Check the link with the sender — or the parcel may have been cancelled.
            </p>
          </div>
        ) : !view ? (
          // [WR-012] Only a real 404 proves the link is dead. A failed FIRST
          // load is a connectivity problem — say that, keep polling (the
          // interval is still running), never dress it as "not found".
          <div className="pt-16 text-center">
            <p className="text-lg font-semibold">Can&apos;t reach this parcel right now</p>
            <p className="mt-2 text-sm text-[#786C6C]">
              Check your connection — this page keeps retrying on its own.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
              <p className="text-base font-semibold">{STATUS_LABEL[view.status] ?? view.status}</p>
              {/* [W-47] aria-live so a screen reader hears the position age change,
                  and red once it stops being current — the page used to look
                  identical whether it was polling or had silently stopped. */}
              {freshnessLabel && live ? (
                <p
                  aria-live="polite"
                  className={`mt-0.5 text-xs ${age.kind === 'fresh' ? 'text-[#786C6C]' : 'font-semibold text-[var(--swift-red)]'}`}
                >
                  {freshnessLabel}
                </p>
              ) : null}
              {view.estimatedDeliveryTime != null && live ? (
                <p className="mt-1 text-sm text-[#786C6C]">About {view.estimatedDeliveryTime} min door to door</p>
              ) : null}
            </div>

            {view.rider?.user?.firstName && live ? (
              <div className="mt-3 flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--swift-red-50)] text-lg font-bold text-[var(--swift-red)]">
                  {view.rider.user.firstName.slice(0, 1)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{view.rider.user.firstName}</p>
                  <p className="truncate text-sm text-[#786C6C]">Your Swift courier</p>
                </div>
              </div>
            ) : null}

            {showMap && loc ? (
              <div className="mt-3 overflow-hidden rounded-2xl bg-white shadow-sm">
                {/* [W-47] The point is COARSENED to about 110 m before it leaves for
                    a third party, and no referer goes with it — every map load used
                    to disclose a live person's precise position and which tracking
                    token was watching. A first-party tile proxy is the real answer
                    and is stated as deferred in the register. */}
                <iframe
                  title="Courier location, approximate"
                  className="h-64 w-full border-0"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  src={mapEmbedUrl(loc)}
                />
                <a
                  className="block px-4 py-3 text-sm font-semibold text-[var(--swift-red)]"
                  href={mapLinkUrl(loc)}
                  target="_blank"
                  rel="noreferrer"
                  referrerPolicy="no-referrer"
                >
                  Open approximate map ↗
                </a>
              </div>
            ) : live ? (
              <div className="mt-3 rounded-2xl bg-white p-4 text-sm text-[#786C6C] shadow-sm">
                Live position appears once a courier is on the job.
              </div>
            ) : null}

            <div className="mt-3 rounded-2xl bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#786C6C]">From</p>
              <p className="mt-0.5 text-sm">{view.pickupAddress ?? '—'}</p>
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-[#786C6C]">To</p>
              <p className="mt-0.5 text-sm">{view.deliveryAddress ?? '—'}</p>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

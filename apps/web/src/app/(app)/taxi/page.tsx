'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MapPin } from 'lucide-react';
import { rideAvailability, rideEstimate, requestRide, activeRide, watchRide, money } from '@/lib/customer';
import { LocationField } from '@/components/location-field';
import { submittablePlace, type PickedPlace } from '@/lib/place';
import { currentCoords } from '@/lib/geolocate';

type Pt = { lat: number; lng: number; label: string };

export default function TaxiPage() {
  const router = useRouter();
  const [pickup, setPickup] = useState<Pt | null>(null);
  // [W-18] The text the passenger sees and the point we would dispatch to are
  // ONE thing. They used to be two: editing the box left `dropoff` holding the
  // previously chosen coordinates, and the request submitted those — a driver
  // sent to the address the passenger had just replaced, while the screen
  // showed the new one and the confirmation named it.
  const [dropText, setDropText] = useState('');
  const [dropPlace, setDropPlace] = useState<PickedPlace | null>(null);
  const [avail, setAvail] = useState<{ level: string; gate?: boolean; nearestEtaMinutes?: number | null } | null>(null);
  const [fare, setFare] = useState<any>(null);
  /** [W-17] The two dependency failures that used to be swallowed. */
  const [fareFailed, setFareFailed] = useState(false);
  const [availFailed, setAvailFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** [F-027-02] Why there is no pickup. Without this the page just sits with
   *  a dead "Request" button and no explanation. */
  const [pickupError, setPickupError] = useState<string | null>(null);

  // [F-027-02] Pickup = device location, or NO pickup.
  //
  // This fell back to the Georgetown city centre and labelled it "Current
  // location", then submitted it to dispatch. That sends a real driver to a
  // kerb the passenger is not standing on, starts a fare from the wrong
  // place, and tells them it was their current location. Of the three
  // fabricated-coordinate paths this was the worst, because it reaches a
  // human being who then drives somewhere.
  //
  // With no fallback, a denied prompt means no pickup and therefore no ride
  // from the web app — a real gap, and the honest one. The message says so.
  // (A manual pickup search belongs to MAP-EX-1; it is a feature, not a fix.)
  useEffect(() => {
    currentCoords('set your pickup')
      .then(({ lat, lng }) => { setPickup({ lat, lng, label: 'Current location' }); setPickupError(null); })
      .catch((e: Error) => { setPickup(null); setPickupError(e.message); });
    activeRide().then((r) => { if (r?.id) router.push(`/orders/${r.id}`); }).catch(() => {});
  }, [router]);

  // [W-17] Availability at the pickup — and when the read FAILS, say so. It
  // used to be swallowed, so an outage rendered exactly like a healthy market:
  // no warning, no queue offer, and a live Request button.
  useEffect(() => {
    if (!pickup) return;
    setAvailFailed(false);
    rideAvailability(pickup.lat, pickup.lng)
      .then((a) => { setAvail(a); setAvailFailed(false); })
      .catch(() => { setAvail(null); setAvailFailed(true); });
  }, [pickup]);

  // [W-18] THE destination: the chosen place, but only while the box still
  // names it. Everything downstream — the fare, the button, the request —
  // reads this and never the raw selection.
  const dropoff = useMemo(() => submittablePlace(dropPlace, dropText), [dropPlace, dropText]);

  // Fare estimate once both ends are set. Editing the destination invalidates
  // it, so a price can never belong to a route the passenger has moved on from.
  useEffect(() => {
    if (!pickup || !dropoff) { setFare(null); setFareFailed(false); return; }
    setFareFailed(false);
    rideEstimate({ pickup, dropoff })
      .then((f) => { setFare(f); setFareFailed(false); })
      // [W-17] A failed estimate used to hide the price block and leave the
      // Request button live, so a ride could be ordered with no price ever
      // shown. It is stated now, and it blocks.
      .catch(() => { setFare(null); setFareFailed(true); });
  }, [pickup, dropoff]);

  // [W-17] NO PRICE, NO RIDE — the same law the courier form got in W-20. The
  // fare belongs to THIS route: changing the destination clears it above, so
  // this can never be a price for a journey the passenger has moved on from.
  const quotedFare = fare?.tiers?.find((t: { rideClass?: string }) => t.rideClass === 'ECONOMY') ?? fare?.tiers?.[0] ?? null;
  const readyToRequest = Boolean(pickup && dropoff && quotedFare);

  async function request() {
    // [W-17] The guard, not just the disabled attribute: a price the passenger
    // never saw is not a price they agreed to.
    if (!pickup || !dropoff || !quotedFare) return;
    setBusy(true); setError(null);
    try {
      const r = await requestRide({ pickup, dropoff, pickupAddress: pickup.label, dropoffAddress: dropoff.label, passengerCount: 1, rideClass: 'ECONOMY' });
      const rid = r?.id ?? r?.ride?.id;
      router.push(rid ? `/orders/${rid}` : '/orders');
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  const noDrivers = avail?.gate && avail.level === 'NONE';

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <h1 className="text-2xl font-extrabold">Get a ride</h1>

      <div className="rounded-2xl border border-black/5 bg-white p-4">
        <div className="flex items-center gap-2 border-b border-black/5 pb-3">
          <MapPin className="h-4 w-4 text-[var(--swift-red)]" />
          <span className="text-sm text-[var(--swift-muted)]">Pickup</span>
          <span className="ml-auto font-semibold">{pickup?.label ?? (pickupError ? 'Not set' : 'Locating…')}</span>
        </div>
        {/* [F-027-02] Say why there is no pickup. The alternative this
            replaces was labelling a hardcoded city-centre point "Current
            location" and dispatching a driver to it. */}
        {pickupError && (
          <p role="alert" className="pt-3 text-sm font-semibold text-[var(--swift-red)]">
            {pickupError} Without it we can’t send a driver to the right place.
          </p>
        )}
        <div className="pt-3">
          {/* [W-18] The SAME field the courier form uses. Typing invalidates
              the selection, so the box and the pin cannot disagree. */}
          <LocationField
            label="Where to?"
            text={dropText}
            place={dropPlace}
            onChange={(text, place) => { setDropText(text); setDropPlace(place); }}
            near={pickup ? { label: pickup.label, lat: pickup.lat, lng: pickup.lng, placeId: '' } : null}
          />
        </div>
      </div>

      {/* [W-17] A failed estimate is SAID, not hidden. Hiding it left the
          Request button live with no price anywhere on screen. */}
      {fareFailed && dropoff && (
        <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">
          We couldn&apos;t price this trip just now, so we can&apos;t send a driver for it yet — try again in a moment.
        </p>
      )}

      {fare && dropoff && (
        <div className="rounded-2xl border border-black/5 bg-white p-4">
          <div className="flex items-center justify-between">
            <div><p className="font-bold">Economy</p><p className="text-sm text-[var(--swift-muted)]">~{fare.durationMin ?? '—'} min · {fare.distanceKm?.toFixed?.(1) ?? fare.distanceKm} km</p></div>
            <p className="text-lg font-extrabold">{money((fare.tiers?.find((t: any) => t.rideClass === 'ECONOMY') ?? fare.tiers?.[0])?.fare ?? 0)}</p>
          </div>
          <p className="mt-1 text-xs text-[var(--swift-muted)]">Cash on arrival — you pay the driver directly.</p>
        </div>
      )}

      {/* [W-17] A failed availability read is not a healthy market. It used to
          be swallowed, so an outage looked identical to drivers being nearby. */}
      {availFailed && (
        <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">
          We can&apos;t tell how many drivers are nearby right now — this is our problem, not a quiet night.
        </p>
      )}

      {error && <p className="text-sm font-semibold text-[var(--swift-red)]">{error}</p>}

      {noDrivers ? (
        <div className="space-y-2 text-center">
          <button
            // [WR-011] "We'll ping you" is a promise — only make it when the
            // watch actually exists server-side; a failure shows the reason.
            onClick={async () => {
              if (!pickup) return;
              try {
                await watchRide(pickup);
                setWatching(true);
                setError(null);
              } catch (e: any) {
                setError(e?.message || "Couldn't set the alert — try again.");
              }
            }}
            disabled={watching}
            className="w-full rounded-full bg-[var(--swift-red)] py-3.5 font-bold text-white disabled:opacity-70">
            {watching ? 'We’ll ping you — watching for drivers' : 'Notify me when a driver is available'}
          </button>
          <p className="text-sm text-[var(--swift-muted)]">No drivers are available near you right now — we’re sorry.</p>
          <button onClick={request} disabled={!readyToRequest || busy} className="text-sm font-semibold text-[var(--swift-muted)] underline disabled:opacity-50">Try anyway — some drivers come online mid-search</button>
        </div>
      ) : (
        <button onClick={request} disabled={!readyToRequest || busy} className="w-full rounded-full bg-[var(--swift-red)] py-3.5 font-bold text-white disabled:opacity-50">
          {busy ? 'Requesting…' : !dropoff ? 'Set your destination' : !quotedFare ? 'Waiting for a price…' : 'Request ride'}
        </button>
      )}
    </div>
  );
}

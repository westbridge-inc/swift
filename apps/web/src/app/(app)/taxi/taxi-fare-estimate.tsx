'use client';

import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Pictogram } from '@/components/glyphs';
import { LocationField } from '@/components/location-field';
import { useCustomerSession } from '@/components/customer-session';
import { money } from '@/lib/customer';
import { rideEstimate } from '@/lib/customer-rides';
import { signInPath, signUpPath } from '@/lib/customer-routes';
import type { PickedPlace } from '@/lib/place';
import { FARE_UNAVAILABLE, TAXI_TIER_META, readTaxiEstimate, taxiEstimateRefusal, type TaxiEstimate } from '@/lib/taxi-fare';

// [WEB-PIN] Either end may be pinned on the map, as on the courier page. The
// map's code loads only when a pin is asked for.
const PlacePinPanel = lazy(() => import('@/components/pin-picker/place-pin-panel').then((module) => ({ default: module.PlacePinPanel })));

// ---------------------------------------------------------------------------
// [Row 117 · owner 16 Oct 2026] A REAL taxi fare estimate on the website.
//
// The fare is the server's (POST /rides/estimate — the phone's own engine), for
// the two places the customer CHOSE: the shared LocationField's rule holds, so
// the words in a box and the point priced are one place. A quote belongs to
// one exact pair of places; change either and it is gone in the same render.
// Booking stays in the Swift app: nothing here can request a ride.
// ---------------------------------------------------------------------------

type Quote =
  | { state: 'pricing'; pickup: PickedPlace; dropoff: PickedPlace }
  | { state: 'priced'; pickup: PickedPlace; dropoff: PickedPlace; estimate: TaxiEstimate }
  | { state: 'refused'; pickup: PickedPlace; dropoff: PickedPlace; message: string; retry: boolean };

export function TaxiFareEstimate() {
  const session = useCustomerSession();
  // Address search and fares are account calls: nothing is asked of the
  // server until the shell knows who this is.
  if (session.status === 'checking') {
    return <p role="status" className="sw-caption">Opening fare estimates…</p>;
  }
  if (session.status === 'guest') return <GuestFareDoor />;
  // A different person after sign-out or a restored session starts afresh.
  return <FareForm key={session.epoch} />;
}

/** The phone's taxi door for a visitor (TaxiSignedOut), for an estimate. */
function GuestFareDoor() {
  return (
    <section aria-labelledby="taxi-fare-door" className="flex flex-col gap-2 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] p-5">
      <h2 id="taxi-fare-door" className="sw-heading">Sign in to see a fare estimate</h2>
      <p className="sw-caption text-[15px] leading-[22px]">
        Address search and fares work from your Swift account, the same way they do in the app.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Link href={signInPath('/taxi')} className="sw-btn sw-btn-md">Sign in</Link>
        <Link href={signUpPath('/taxi')} className="sw-btn sw-btn-outline sw-btn-md">Create an account</Link>
      </div>
    </section>
  );
}

function FareForm() {
  const [pickupText, setPickupText] = useState('');
  const [pickup, setPickup] = useState<PickedPlace | null>(null);
  const [dropoffText, setDropoffText] = useState('');
  const [dropoff, setDropoff] = useState<PickedPlace | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [round, setRound] = useState(0);
  const [pinning, setPinning] = useState<'pickup' | 'dropoff' | null>(null);
  // Where focus returns when the map closes: the button that opened it.
  const pinButtons = { pickup: useRef<HTMLButtonElement>(null), dropoff: useRef<HTMLButtonElement>(null) };
  const returnFocus = useRef<'pickup' | 'dropoff' | null>(null);
  useEffect(() => {
    if (pinning || !returnFocus.current) return;
    pinButtons[returnFocus.current].current?.focus();
    returnFocus.current = null;
  });
  function closePin(end: 'pickup' | 'dropoff') { returnFocus.current = end; setPinning(null); }

  useEffect(() => {
    if (!pickup || !dropoff) return;
    let live = true;
    setQuote({ state: 'pricing', pickup, dropoff });
    rideEstimate({ pickup: { lat: pickup.lat, lng: pickup.lng }, dropoff: { lat: dropoff.lat, lng: dropoff.lng } })
      .then((raw) => {
        if (!live) return;
        const estimate = readTaxiEstimate(raw);
        setQuote(estimate
          ? { state: 'priced', pickup, dropoff, estimate }
          : { state: 'refused', pickup, dropoff, message: FARE_UNAVAILABLE, retry: false });
      })
      .catch((error: unknown) => { if (live) setQuote({ state: 'refused', pickup, dropoff, ...taxiEstimateRefusal(error) }); });
    return () => { live = false; };
  }, [pickup, dropoff, round]);

  // [W-18] The quote on screen is only ever the one for THESE two places.
  const current = quote && pickup && dropoff && quote.pickup === pickup && quote.dropoff === dropoff ? quote : null;

  return (
    <div className="grid grid-cols-1 items-start gap-x-12 gap-y-6 split:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-w-0 flex-col gap-3">
        <LocationField label="Pick up from" text={pickupText} place={pickup} near={pickup}
          onChange={(t, p) => { setPickupText(t); setPickup(p); }} />
        {pinning === 'pickup' ? (
          <Suspense fallback={<p role="status" className="sw-caption">Opening the map…</p>}>
            <PlacePinPanel
              title="Pin the pickup"
              mapLabel="Pickup pin map"
              start={pickup ? { latitude: pickup.lat, longitude: pickup.lng } : null}
              onUse={(place) => { setPickupText(place.label); setPickup(place); closePin('pickup'); }}
              onCancel={() => closePin('pickup')}
            />
          </Suspense>
        ) : (
          <button ref={pinButtons.pickup} type="button" className="sw-btn sw-btn-outline sw-btn-md self-start" onClick={() => setPinning('pickup')}>Pin pickup on the map</button>
        )}

        <LocationField label="Going to" text={dropoffText} place={dropoff} near={pickup}
          onChange={(t, p) => { setDropoffText(t); setDropoff(p); }} />
        {pinning === 'dropoff' ? (
          <Suspense fallback={<p role="status" className="sw-caption">Opening the map…</p>}>
            <PlacePinPanel
              title="Pin the destination"
              mapLabel="Destination pin map"
              start={dropoff ? { latitude: dropoff.lat, longitude: dropoff.lng } : null}
              onUse={(place) => { setDropoffText(place.label); setDropoff(place); closePin('dropoff'); }}
              onCancel={() => closePin('dropoff')}
            />
          </Suspense>
        ) : (
          <button ref={pinButtons.dropoff} type="button" className="sw-btn sw-btn-outline sw-btn-md self-start" onClick={() => setPinning('dropoff')}>Pin destination on the map</button>
        )}
      </div>

      <aside className="flex flex-col gap-3 split:sticky split:top-4" aria-live="polite">
        <span className="sw-eyebrow">Fare estimate</span>
        {!current ? (
          <p className="sw-caption text-[15px] leading-[22px]">Set your pickup and destination to see the fare.</p>
        ) : current.state === 'pricing' ? (
          <p role="status" className="sw-caption text-[15px] leading-[22px]">Working out the fare…</p>
        ) : current.state === 'refused' ? (
          <div role="alert" className="sw-note sw-note-error flex-col items-start gap-2">
            <p>{current.message}</p>
            {current.retry && (
              <button type="button" className="sw-btn sw-btn-outline sw-btn-md" onClick={() => setRound((n) => n + 1)}>Try again</button>
            )}
          </div>
        ) : (
          <FareTiers estimate={current.estimate} />
        )}
      </aside>
    </div>
  );
}

function FareTiers({ estimate }: { estimate: TaxiEstimate }) {
  return (
    <>
      <ul className="flex flex-col gap-2" aria-label="Fare estimates by ride type">
        {estimate.tiers.map((tier) => {
          const meta = TAXI_TIER_META[tier.rideClass];
          return (
            <li key={tier.rideClass} className="flex items-center gap-3 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] px-4 py-3">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--swift-sunken)]"><Pictogram name={meta.pictogram} size={30} /></span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15px] font-semibold leading-5">{meta.label}</span>
                <span className="text-[13px] leading-[18px] text-[var(--swift-muted)]">{tier.capacity} seats · {meta.blurb}</span>
              </span>
              <span className="text-[17px] font-semibold leading-6 tabular-nums">{money(tier.fare)}</span>
            </li>
          );
        })}
      </ul>
      {/* The phone's own line (TaxiScreen), then what an estimate means here. */}
      <p className="sw-caption">
        Fare estimate · pay the driver cash or MMG at drop-off{estimate.durationMin != null ? ` · ~${estimate.durationMin} min trip` : ''}.
      </p>
      {estimate.waitingText && <p className="sw-caption">{estimate.waitingText}</p>}
      <p className="sw-caption">The Swift app shows the fare again before you book. You pay the driver directly; Swift never holds your money.</p>
    </>
  );
}

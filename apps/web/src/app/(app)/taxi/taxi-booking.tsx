'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Pictogram } from '@/components/glyphs';
import { money } from '@/lib/customer';
import { requestRide, type WebRideRequest } from '@/lib/customer-rides';
import type { PickedPlace } from '@/lib/place';
import { bookingProblem, newBookingKey, type BookingProblem } from '@/lib/taxi-booking';
import { TAXI_TIER_META, type TaxiEstimate, type TaxiRideClass } from '@/lib/taxi-fare';

// ---------------------------------------------------------------------------
// [Row 117 · owner 16 Oct 2026] Booking a taxi from the website — shown ONLY
// while the server says web booking is on (the taxi page asks GET
// /rides/capabilities). The phone's flow: choose a ride type from the
// server's fares, request at the fare on the button (the server books only at
// it), then the trip page carries the ride code and SOS.
//
// One booking intent, one Idempotency-Key: a press that may have reached the
// server (no answer, or an unknown outcome) is retried under the same key and
// is answered with the first answer — never a second ride.
// ---------------------------------------------------------------------------

export function TaxiBooking({ estimate, pickup, dropoff, activeRideId, onFareChanged, onBookingOff }: {
  estimate: TaxiEstimate;
  pickup: PickedPlace;
  dropoff: PickedPlace;
  /** A ride already in progress: the page links to it instead of booking another. */
  activeRideId: string | null;
  /** The fare moved (the server refused the old one): the page prices the route again and says why. */
  onFareChanged: (_message: string) => void;
  /** The switch went off while the page was open: the page drops booking and says why. */
  onBookingOff: (_message: string) => void;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<TaxiRideClass>(estimate.tiers[0].rideClass);
  const tier = estimate.tiers.find((t) => t.rideClass === chosen) ?? estimate.tiers[0];
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<BookingProblem | null>(null);
  const attempt = useRef<{ intent: string; key: string } | null>(null);

  async function book() {
    if (busy || activeRideId) return;
    const body: WebRideRequest = {
      pickup: { lat: pickup.lat, lng: pickup.lng },
      dropoff: { lat: dropoff.lat, lng: dropoff.lng },
      // The words the customer chose: the box shows them, the driver reads them.
      pickupAddress: pickup.label,
      dropoffAddress: dropoff.label,
      passengerCount: 1,
      rideClass: tier.rideClass,
      expectedFare: tier.fare,
    };
    const intent = JSON.stringify(body);
    if (attempt.current?.intent !== intent) attempt.current = { intent, key: newBookingKey() };
    setBusy(true);
    setProblem(null);
    try {
      const answer = await requestRide(body, attempt.current.key);
      const id = answer?.ride?.id ?? answer?.order?.id ?? null;
      attempt.current = null;
      router.push(typeof id === 'string' && id ? `/orders/${encodeURIComponent(id)}` : '/orders');
    } catch (error) {
      const next = bookingProblem(error);
      if (!next.keepKey) attempt.current = null;
      // The page says these two itself: it re-prices the route, or drops booking.
      if (next.kind === 'fare-changed') onFareChanged(next.message);
      else if (next.kind === 'booking-off') onBookingOff(next.message);
      else setProblem(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div role="radiogroup" aria-label="Choose your ride" className="flex flex-col gap-2">
        {estimate.tiers.map((option) => {
          const meta = TAXI_TIER_META[option.rideClass];
          const selected = option.rideClass === tier.rideClass;
          return (
            <button key={option.rideClass} type="button" role="radio" aria-checked={selected} onClick={() => setChosen(option.rideClass)}
              className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-left ${selected ? 'border-[var(--swift-red)] bg-[var(--swift-red-50)]' : 'border-[var(--swift-border)] bg-[var(--swift-card)]'}`}>
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--swift-sunken)]"><Pictogram name={meta.pictogram} size={30} /></span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15px] font-semibold leading-5">{meta.label}</span>
                <span className="text-[13px] leading-[18px] text-[var(--swift-muted)]">{option.capacity} seats · {meta.blurb}</span>
              </span>
              <span className="text-[17px] font-semibold leading-6 tabular-nums">{money(option.fare)}</span>
            </button>
          );
        })}
      </div>
      <p className="sw-caption">
        Fare estimate · pay the driver cash or MMG at drop-off{estimate.durationMin != null ? ` · ~${estimate.durationMin} min trip` : ''}.
      </p>
      {estimate.waitingText && <p className="sw-caption">{estimate.waitingText}</p>}
      <p className="sw-caption">Your driver asks for the six-digit ride code on your trip page before the ride starts. SOS is on the trip page too.</p>

      {problem && (
        <div role="alert" className="sw-note sw-note-error flex-col items-start gap-1">
          <p>{problem.message}</p>
          {problem.kind === 'unconfirmed' && <Link href="/orders" className="sw-link-btn">Open my orders</Link>}
        </div>
      )}

      {activeRideId ? (
        <div className="flex flex-col gap-2">
          <p className="sw-caption">You already have a ride in progress.</p>
          <Link href={`/orders/${encodeURIComponent(activeRideId)}`} className="sw-btn sw-btn-block">Open your ride</Link>
        </div>
      ) : (
        <button type="button" onClick={book} disabled={busy} className="sw-btn sw-btn-block mt-1">
          {busy ? 'Requesting…' : `Request ${TAXI_TIER_META[tier.rideClass].label} · ${money(tier.fare)}`}
        </button>
      )}
    </>
  );
}

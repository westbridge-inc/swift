'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pictogram } from '@/components/glyphs';
import { courierEstimate, requestCourier, money } from '@/lib/customer';
import { currentCoords } from '@/lib/geolocate';
import { submittablePlace, type PickedPlace } from '@/lib/place';
// [W-18] The field moved to components/location-field.tsx and the TAXI form
// now uses the same one — it had the identical defect and its own copy of the
// search box. A shared field is why there cannot be a third.
import { LocationField } from '@/components/location-field';

// [W-19] The text in the box IS the place, or there is no place. This form used
// to keep the two apart — pick "42 Lamaha Street", edit the box to "9 Camp
// Road" without tapping a suggestion, and it still submitted Lamaha's
// coordinates AND Lamaha's label. The parcel went to the address the sender
// believed they had replaced, and the confirmation named it, so nothing on
// screen revealed the swap.
//
// [W-20] And the fee: a failed estimate simply hid the price block while the
// request button stayed live, so a parcel could be sent with no price ever
// shown. The request now requires a current estimate for the exact route and
// size being sent.

const SIZES = [
  { k: 'SMALL', l: 'Small', d: 'Envelope / phone' },
  { k: 'MEDIUM', l: 'Medium', d: 'Shoebox' },
  { k: 'LARGE', l: 'Large', d: 'Backpack' },
  { k: 'EXTRA_LARGE', l: 'X-Large', d: 'Suitcase' },
];


export default function CourierPage() {
  const router = useRouter();
  const [pickupText, setPickupText] = useState('');
  const [pickup, setPickup] = useState<PickedPlace | null>(null);
  const [pickupError, setPickupError] = useState<string | null>(null);
  const [dropoffText, setDropoffText] = useState('');
  const [dropoff, setDropoff] = useState<PickedPlace | null>(null);
  const [size, setSize] = useState('SMALL');
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [estimate, setEstimate] = useState<{ totalFee?: number; fare?: number } | null>(null);
  const [estimateFailed, setEstimateFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // [F-027-02] This one never fabricated a coordinate — it just failed
    // SILENTLY, leaving "Locating…" on screen forever with no way to know the
    // prompt had been denied. Fail closed AND say so.
    currentCoords('set your pickup')
      .then(({ lat, lng }) => {
        setPickup({ lat, lng, label: 'Current location', placeId: 'device' });
        setPickupText('Current location');
        setPickupError(null);
      })
      .catch((e: Error) => { setPickup(null); setPickupError(e.message); });
  }, []);

  // [W-20] The estimate belongs to one exact route and size. Any change clears
  // it, so the price on screen can never describe a different parcel.
  useEffect(() => {
    setEstimate(null);
    setEstimateFailed(false);
    if (!pickup || !dropoff) return;
    let live = true;
    courierEstimate({ pickup, dropoff, packageSize: size })
      .then((r) => { if (live) { setEstimate(r); setEstimateFailed(false); } })
      .catch(() => { if (live) { setEstimate(null); setEstimateFailed(true); } });
    return () => { live = false; };
  }, [pickup, dropoff, size]);

  const fee = estimate ? (estimate.totalFee ?? estimate.fare ?? null) : null;
  // Both halves of every address agree, and there is a price for THIS parcel.
  const readyToSend = pickup !== null && dropoff !== null && fee !== null && !busy;

  async function send() {
    const from = submittablePlace(pickup, pickupText);
    const to = submittablePlace(dropoff, dropoffText);
    if (!from || !to || fee === null) return;
    setBusy(true); setError(null);
    try {
      const r = await requestCourier({
        pickup: { lat: from.lat, lng: from.lng },
        dropoff: { lat: to.lat, lng: to.lng },
        // the label submitted is the one that was CHOSEN, and the box shows it
        pickupAddress: from.label,
        dropoffAddress: to.label,
        packageSize: size,
        ...(recipientName.trim() && { recipientName: recipientName.trim() }),
        ...(recipientPhone.trim() && { recipientPhone: recipientPhone.trim() }),
        ...(notes.trim() && { notes: notes.trim() }),
      });
      const id = r?.orderId ?? r?.order?.id ?? r?.id;
      router.push(id ? `/orders/${id}` : '/orders');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col">
      <span className="sw-eyebrow">Send</span>
      <h1 className="sw-title mt-1">A parcel across town</h1>
      <div className="mt-5 grid grid-cols-1 items-start gap-x-12 gap-y-6 split:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-3">
          <LocationField
            label="Pick up from"
            text={pickupText}
            place={pickup}
            onChange={(t, p) => { setPickupText(t); setPickup(p); }}
            near={pickup}
          />
          {pickupError && !pickup && (
            <p role="alert" className="sw-note sw-note-error">{pickupError} You can search for it above instead.</p>
          )}

          <LocationField
            label="Deliver to"
            text={dropoffText}
            place={dropoff}
            onChange={(t, p) => { setDropoffText(t); setDropoff(p); }}
            near={pickup}
          />

          <h2 className="sw-heading mt-3">What are you sending?</h2>
          <div className="grid grid-cols-2 gap-2 wide:grid-cols-4">
            {SIZES.map((s) => (
              <button key={s.k} type="button" aria-pressed={size === s.k} onClick={() => setSize(s.k)}
                className={`flex cursor-pointer flex-col items-start gap-2 rounded-2xl border p-3.5 text-left text-[var(--swift-ink)] transition-colors ${size === s.k ? 'border-[var(--swift-red)] bg-[var(--swift-red-50)]' : 'border-[var(--swift-border)] bg-[var(--swift-card)]'}`}>
                <Pictogram name="send" size={28} />
                <span className="flex flex-col"><span className="text-[15px] font-semibold leading-5">{s.l}</span><span className="text-[13px] leading-[18px] text-[var(--swift-muted)]">{s.d}</span></span>
              </button>
            ))}
          </div>

          {/* [W-20] Who receives it. The API has always accepted these; the form
              never asked, so a rider arrived with a parcel and no one to ask for. */}
          <h2 className="sw-heading mt-3">Who’s receiving it?</h2>
          <div className="grid grid-cols-1 gap-2 wide:grid-cols-2">
            <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder="Recipient name (optional)" aria-label="Recipient name (optional)" className="sw-input" />
            <input value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)} placeholder="Recipient phone (optional)" aria-label="Recipient phone (optional)" type="tel" className="sw-input" />
          </div>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes for the rider (optional)" aria-label="Notes for the rider (optional)" className="sw-input" />
        </div>

        <aside className="flex flex-col gap-3 split:sticky split:top-4">
          <span className="sw-eyebrow">Fee · cash on delivery</span>
          {fee !== null ? (
            <>
              <p className="sw-money-xl">{money(fee)}</p>
              <p className="sw-caption">Paid in cash to your rider. Swift never holds your money.</p>
            </>
          ) : !estimateFailed ? (
            <p className="sw-caption text-[15px] leading-[22px]">{!pickup || !dropoff ? 'Set both addresses to see the fee.' : 'Pricing this delivery…'}</p>
          ) : null}
          {/* [W-20] A failed estimate used to hide this block and leave the button
              live, so a parcel could be sent with no price ever shown. */}
          {estimateFailed && (
            <div role="alert" className="sw-note sw-note-error flex-col gap-1">
              <p className="font-semibold">We couldn&apos;t price this delivery.</p>
              <p>You can&apos;t send it without a price — try again in a moment.</p>
            </div>
          )}

          {error && <p role="alert" className="sw-note sw-note-error">{error}</p>}

          <button type="button" onClick={send} disabled={!readyToSend} className="sw-btn sw-btn-block mt-1">
            {busy ? 'Requesting…' : !pickup || !dropoff ? 'Set both addresses' : fee === null ? 'Waiting for a price…' : `Request courier · ${money(fee)}`}
          </button>
        </aside>
      </div>
    </div>
  );
}

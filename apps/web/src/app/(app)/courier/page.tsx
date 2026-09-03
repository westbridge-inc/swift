'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Package } from 'lucide-react';
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
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="flex items-center gap-2 text-2xl font-extrabold"><Package className="h-6 w-6 text-[var(--swift-red)]" /> Send a package</h1>

      <LocationField
        label="Pick up from"
        text={pickupText}
        place={pickup}
        onChange={(t, p) => { setPickupText(t); setPickup(p); }}
        near={pickup}
      />
      {pickupError && !pickup && (
        <p role="alert" className="-mt-2 text-sm font-semibold text-[var(--swift-red)]">{pickupError} You can search for it above instead.</p>
      )}

      <LocationField
        label="Deliver to"
        text={dropoffText}
        place={dropoff}
        onChange={(t, p) => { setDropoffText(t); setDropoff(p); }}
        near={pickup}
      />

      <div>
        <p className="mb-2 font-bold">Package size</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SIZES.map((s) => (
            <button key={s.k} onClick={() => setSize(s.k)} className={`rounded-2xl border p-3 text-left ${size === s.k ? 'border-[var(--swift-red)] bg-[var(--swift-red-50)]' : 'border-black/10 bg-white'}`}>
              <span className="block font-bold">{s.l}</span><span className="block text-xs text-[var(--swift-muted)]">{s.d}</span>
            </button>
          ))}
        </div>
      </div>

      {/* [W-20] Who receives it. The API has always accepted these; the form
          never asked, so a rider arrived with a parcel and no one to ask for. */}
      <div className="space-y-2 rounded-2xl border border-black/5 bg-white p-3">
        <p className="font-bold">Who is receiving it?</p>
        <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder="Recipient name (optional)" className="w-full rounded-xl border border-black/10 px-3 py-2" />
        <input value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)} placeholder="Recipient phone (optional)" className="w-full rounded-xl border border-black/10 px-3 py-2" />
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes for the rider (optional)" className="w-full rounded-xl border border-black/10 px-3 py-2" />
      </div>

      {fee !== null && (
        <div className="rounded-2xl border border-black/5 bg-white p-4">
          <div className="flex justify-between"><span className="text-[var(--swift-muted)]">Estimated fee</span><span className="text-lg font-extrabold">{money(fee)}</span></div>
          <p className="mt-1 text-xs text-[var(--swift-muted)]">Cash on delivery — paid to your rider.</p>
        </div>
      )}
      {/* [W-20] A failed estimate used to hide this block and leave the button
          live, so a parcel could be sent with no price ever shown. */}
      {estimateFailed && (
        <div role="alert" className="rounded-2xl border border-[var(--swift-red)]/30 bg-[var(--swift-red)]/5 p-4">
          <p className="text-sm font-bold text-[var(--swift-red)]">We couldn&apos;t price this delivery.</p>
          <p className="mt-1 text-sm">You can&apos;t send it without a price — try again in a moment.</p>
        </div>
      )}

      {error && <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">{error}</p>}

      <button
        onClick={send}
        disabled={!readyToSend}
        className="w-full rounded-full bg-[var(--swift-red)] py-3.5 font-bold text-white disabled:opacity-50"
      >
        {busy ? 'Requesting…' : !pickup || !dropoff ? 'Set both addresses' : fee === null ? 'Waiting for a price…' : `Request courier · ${money(fee)}`}
      </button>
    </div>
  );
}

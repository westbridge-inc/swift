'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Package } from 'lucide-react';
import { placesAutocomplete, placeDetails, courierEstimate, requestCourier, money, type Place } from '@/lib/customer';
import { currentCoords } from '@/lib/geolocate';

type Pt = { lat: number; lng: number; label: string };
const SIZES = [{ k: 'SMALL', l: 'Small', d: 'Envelope / phone' }, { k: 'MEDIUM', l: 'Medium', d: 'Shoebox' }, { k: 'LARGE', l: 'Large', d: 'Backpack' }, { k: 'EXTRA_LARGE', l: 'X-Large', d: 'Suitcase' }];

function LocationField({ label, value, onPick, near }: { label: string; value: Pt | null; onPick: (_pt: Pt) => void; near?: Pt | null }) {
  const [q, setQ] = useState('');
  const [sugg, setSugg] = useState<Place[]>([]);
  const debounce = useRef<any>(null);
  function onChange(v: string) {
    setQ(v); clearTimeout(debounce.current);
    if (v.trim().length < 3) { setSugg([]); return; }
    debounce.current = setTimeout(() => placesAutocomplete(v.trim(), near ?? undefined).then(setSugg).catch(() => setSugg([])), 250);
  }
  async function pick(p: Place) {
    setQ(p.primary); setSugg([]);
    const d = p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : await placeDetails(p.placeId);
    onPick({ lat: d.lat, lng: d.lng, label: p.primary });
  }
  return (
    <div className="relative rounded-2xl border border-black/5 bg-white p-3">
      <p className="text-xs font-semibold text-[var(--swift-muted)]">{label}</p>
      <div className="flex items-center gap-2"><Search className="h-4 w-4 text-[var(--swift-muted)]" /><input value={q || value?.label || ''} onChange={(e) => onChange(e.target.value)} placeholder="Search address…" className="w-full py-1 outline-none" /></div>
      {sugg.length > 0 && (
        <ul className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-black/10 bg-white shadow-lg">
          {sugg.map((s) => <li key={s.placeId}><button onClick={() => pick(s)} className="w-full px-3 py-2.5 text-left hover:bg-[var(--swift-subtle)]">{s.primary}{s.secondary && <span className="block text-xs text-[var(--swift-muted)]">{s.secondary}</span>}</button></li>)}
        </ul>
      )}
    </div>
  );
}

export default function CourierPage() {
  const router = useRouter();
  const [pickup, setPickup] = useState<Pt | null>(null);
  const [pickupError, setPickupError] = useState<string | null>(null);
  const [dropoff, setDropoff] = useState<Pt | null>(null);
  const [size, setSize] = useState('SMALL');
  const [estimate, setEstimate] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // [F-027-02] This one never fabricated a coordinate — it just failed
    // SILENTLY, leaving "Locating…" on screen forever with no way to know the
    // prompt had been denied. Fail closed AND say so.
    currentCoords('set your pickup')
      .then(({ lat, lng }) => { setPickup({ lat, lng, label: 'Current location' }); setPickupError(null); })
      .catch((e: Error) => { setPickup(null); setPickupError(e.message); });
  }, []);
  useEffect(() => { if (pickup && dropoff) courierEstimate({ pickup, dropoff, packageSize: size }).then(setEstimate).catch(() => setEstimate(null)); }, [pickup, dropoff, size]);

  async function send() {
    if (!pickup || !dropoff) return;
    setBusy(true); setError(null);
    try {
      const r = await requestCourier({ pickup, dropoff, pickupAddress: pickup.label, dropoffAddress: dropoff.label, packageSize: size });
      const id = r?.orderId ?? r?.order?.id ?? r?.id;
      router.push(id ? `/orders/${id}` : '/orders');
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="flex items-center gap-2 text-2xl font-extrabold"><Package className="h-6 w-6 text-[var(--swift-red)]" /> Send a package</h1>
      <LocationField label="Pick up from" value={pickup} onPick={setPickup} near={pickup} />
      {pickupError && !pickup && (
        <p role="alert" className="-mt-2 text-sm font-semibold text-[var(--swift-red)]">{pickupError} You can search for it above instead.</p>
      )}
      <LocationField label="Deliver to" value={dropoff} onPick={setDropoff} near={pickup} />
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
      {estimate && <div className="rounded-2xl border border-black/5 bg-white p-4"><div className="flex justify-between"><span className="text-[var(--swift-muted)]">Estimated fee</span><span className="text-lg font-extrabold">{money(estimate.totalFee ?? estimate.fare ?? 0)}</span></div><p className="mt-1 text-xs text-[var(--swift-muted)]">Cash on delivery — paid to your rider.</p></div>}
      {error && <p className="text-sm font-semibold text-[var(--swift-red)]">{error}</p>}
      <button onClick={send} disabled={!pickup || !dropoff || busy} className="w-full rounded-full bg-[var(--swift-red)] py-3.5 font-bold text-white disabled:opacity-50">{busy ? 'Requesting…' : dropoff ? 'Request courier' : 'Set a destination'}</button>
    </div>
  );
}

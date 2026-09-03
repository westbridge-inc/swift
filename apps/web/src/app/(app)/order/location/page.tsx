'use client';

import { useEffect, useState } from 'react';
import { MapPin, Plus, Crosshair } from 'lucide-react';
import { getAddresses, addAddress } from '@/lib/customer';
import { currentFix } from '@/lib/geolocate';
import { DataUnavailable } from '@/components/data-unavailable';
import { acceptFix, addressKey, canSave, placeMatches, type SelectedPlace } from '@/lib/place';

// [W-08] A saved address is a CLAIM that the words and the coordinates describe
// the same place. This page used to make that claim without checking it: it
// took whatever text was in the form and paired it with wherever the phone
// happened to be at the moment Save was pressed. Add your home address from the
// office and the order goes to the office.
//
// So the location is now captured DELIBERATELY, for one exact address string,
// and any edit to that string voids it — the clause's "every address edit
// invalidates coordinates". Save is impossible without a fix bound to the text
// being saved.

const EMPTY_FORM = { label: 'Home', addressLine1: '', city: 'Georgetown', region: 'Demerara-Mahaica' };

export default function LocationPage() {
  const [addresses, setAddresses] = useState<Record<string, unknown>[] | null>(null);
  const [listError, setListError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [place, setPlace] = useState<SelectedPlace | null>(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setAddresses(await getAddresses());
      setListError(null);
    } catch (e) {
      // [W-08] `.catch(() => [])` rendered a failed read as "you have no
      // addresses" — and then `isDefault: addresses.length === 0` made the next
      // address DEFAULT because the list looked empty. An outage silently
      // repointed the customer's deliveries.
      setAddresses(null);
      setListError(e);
    }
  }
  useEffect(() => { void refresh(); }, []);

  /** Edit the address and the captured location no longer describes it. */
  function edit(patch: Partial<typeof form>) {
    const next = { ...form, ...patch };
    setForm(next);
    if (place && !placeMatches(place, next)) setPlace(null);
    setError(null);
  }

  async function locate() {
    setLocating(true); setError(null);
    try {
      const fix = await currentFix('put this address on the map');
      const result = acceptFix({
        key: addressKey(form),
        lat: fix.lat,
        lng: fix.lng,
        accuracyM: fix.accuracyM,
        timestamp: fix.timestamp,
        now: Date.now(),
      });
      if (!result.ok) { setPlace(null); setError(result.message); return; }
      setPlace(result.place);
    } catch (e) {
      setPlace(null);
      setError((e as Error).message);
    } finally {
      setLocating(false);
    }
  }

  async function save() {
    if (!canSave(place, form)) return;
    setBusy(true); setError(null);
    try {
      await addAddress({
        label: form.label,
        addressLine1: form.addressLine1,
        city: form.city,
        region: form.region,
        latitude: place!.lat,
        longitude: place!.lng,
        // Only claim "this is your first address" when the list actually loaded.
        isDefault: addresses !== null && addresses.length === 0,
      });
      setAdding(false); setForm(EMPTY_FORM); setPlace(null);
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const ready = canSave(place, form);
  const rows = addresses ?? [];

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-extrabold">Delivery addresses</h1>

      {listError !== null && (
        <DataUnavailable what="your saved addresses" error={listError} onRetry={() => void refresh()} />
      )}

      {rows.map((a) => (
        <div key={String(a['id'])} className="flex items-center gap-3 rounded-2xl border border-black/5 bg-white p-4">
          <MapPin className="h-5 w-5 text-[var(--swift-red)]" />
          <div>
            <p className="font-bold">
              {String(a['label'] ?? '')}{' '}
              {Boolean(a['isDefault']) && (
                <span className="ml-1 rounded-full bg-[var(--swift-red-50)] px-2 py-0.5 text-xs font-bold text-[var(--swift-red)]">Default</span>
              )}
            </p>
            <p className="text-sm text-[var(--swift-muted)]">{String(a['addressLine1'] ?? '')}, {String(a['city'] ?? '')}</p>
          </div>
        </div>
      ))}

      {adding ? (
        <div className="space-y-2 rounded-2xl border border-black/5 bg-white p-4">
          <input placeholder="Label (Home, Work…)" value={form.label} onChange={(e) => edit({ label: e.target.value })} className="w-full rounded-xl border border-black/10 px-3 py-2" />
          <input placeholder="Street + number" value={form.addressLine1} onChange={(e) => edit({ addressLine1: e.target.value })} className="w-full rounded-xl border border-black/10 px-3 py-2" />
          <input placeholder="City" value={form.city} onChange={(e) => edit({ city: e.target.value })} className="w-full rounded-xl border border-black/10 px-3 py-2" />
          <input placeholder="Region" value={form.region} onChange={(e) => edit({ region: e.target.value })} className="w-full rounded-xl border border-black/10 px-3 py-2" />

          {/* [W-08] Capturing the location is its own deliberate step, and it is
              captured FOR the address above. Editing the address clears it. */}
          <button
            onClick={locate}
            disabled={locating || !form.addressLine1.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--swift-red)] py-2.5 font-bold text-[var(--swift-red)] disabled:opacity-60"
          >
            <Crosshair className="h-4 w-4" />
            {locating ? 'Getting your location…' : place ? 'Update the pin' : 'I am at this address — set the pin'}
          </button>

          {place ? (
            <p role="status" className="rounded-xl bg-green-50 px-3 py-2 text-sm font-semibold text-green-800">
              Pinned to about {Math.round(place.accuracyM)} m for “{form.addressLine1}, {form.city}”.
            </p>
          ) : (
            <p className="px-1 text-xs text-[var(--swift-muted)]">
              Stand at the address and set the pin. We save where you are, not where you typed — so the two must match.
            </p>
          )}

          {error && <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">{error}</p>}

          <button
            onClick={save}
            disabled={busy || !ready}
            className="w-full rounded-full bg-[var(--swift-red)] py-2.5 font-bold text-white disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save address'}
          </button>
        </div>
      ) : (
        <button onClick={() => { setAdding(true); setPlace(null); }} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--swift-red)] py-3 font-bold text-[var(--swift-red)]">
          <Plus className="h-4 w-4" /> Add an address
        </button>
      )}
    </div>
  );
}

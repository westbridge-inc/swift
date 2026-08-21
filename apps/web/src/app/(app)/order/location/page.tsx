'use client';

import { useEffect, useState } from 'react';
import { MapPin, Plus } from 'lucide-react';
import { getAddresses, addAddress } from '@/lib/customer';
import { currentCoords } from '@/lib/geolocate';

export default function LocationPage() {
  const [addresses, setAddresses] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ label: 'Home', addressLine1: '', city: 'Georgetown' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() { setAddresses(await getAddresses().catch(() => [])); }
  useEffect(() => { refresh(); }, []);

  async function save() {
    setBusy(true); setError(null);
    try {
      // A saved address IS its coordinates: the delivery fee, the rider's
      // route and the courier's destination all come from them. Falling back
      // to a city-centre guess when the browser refuses would save an address
      // that quietly points somewhere else — so we refuse instead of guessing.
      // [F-027-02] Was an inline copy of this logic; three other pages kept
      // their own copies WITH the fallback, and fixing this one did not fix
      // them. One implementation now.
      const coords = await currentCoords('place this address on the map');
      await addAddress({ ...form, region: 'Demerara-Mahaica', latitude: coords.lat, longitude: coords.lng, isDefault: addresses.length === 0 });
      setAdding(false); setForm({ label: 'Home', addressLine1: '', city: 'Georgetown' }); refresh();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-extrabold">Delivery addresses</h1>
      {addresses.map((a) => (
        <div key={a.id} className="flex items-center gap-3 rounded-2xl border border-black/5 bg-white p-4">
          <MapPin className="h-5 w-5 text-[var(--swift-red)]" />
          <div><p className="font-bold">{a.label} {a.isDefault && <span className="ml-1 rounded-full bg-[var(--swift-red-50)] px-2 py-0.5 text-xs font-bold text-[var(--swift-red)]">Default</span>}</p><p className="text-sm text-[var(--swift-muted)]">{a.addressLine1}, {a.city}</p></div>
        </div>
      ))}
      {adding ? (
        <div className="space-y-2 rounded-2xl border border-black/5 bg-white p-4">
          <input placeholder="Label (Home, Work…)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} className="w-full rounded-xl border border-black/10 px-3 py-2" />
          <input placeholder="Street + number" value={form.addressLine1} onChange={(e) => setForm({ ...form, addressLine1: e.target.value })} className="w-full rounded-xl border border-black/10 px-3 py-2" />
          <input placeholder="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="w-full rounded-xl border border-black/10 px-3 py-2" />
          {error && <p className="text-sm font-semibold text-[var(--swift-red)]">{error}</p>}
          <button onClick={save} disabled={busy || !form.addressLine1} className="w-full rounded-full bg-[var(--swift-red)] py-2.5 font-bold text-white disabled:opacity-60">{busy ? 'Getting your location…' : 'Save with my current location'}</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--swift-red)] py-3 font-bold text-[var(--swift-red)]"><Plus className="h-4 w-4" /> Add an address</button>
      )}
    </div>
  );
}

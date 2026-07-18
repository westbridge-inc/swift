'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Trash2, MapPin } from 'lucide-react';
import { getCart, updateCartLine, removeCartLine, getAddresses, addAddress, setCartAddress, checkout, money, type Cart } from '@/lib/customer';

const TIPS = [0, 200, 500, 1000];

export default function CartPage() {
  const router = useRouter();
  const [cart, setCart] = useState<Cart | null>(null);
  const [addresses, setAddresses] = useState<any[]>([]);
  const [addrId, setAddrId] = useState<string | null>(null);
  const [tip, setTip] = useState(500);
  const [pay, setPay] = useState<'CASH' | 'MOBILE_MONEY'>('CASH');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noRiders, setNoRiders] = useState(false);
  const [addingAddr, setAddingAddr] = useState(false);
  const [newAddr, setNewAddr] = useState({ label: 'Home', addressLine1: '', city: 'Georgetown' });

  async function refresh() {
    const [c, a] = await Promise.all([getCart(), getAddresses().catch(() => [])]);
    setCart(c); setAddresses(a);
    const def = a.find((x: any) => x.isDefault) ?? a[0];
    if (def) setAddrId(def.id);
  }
  useEffect(() => { refresh().catch((e) => setError(e.message)); }, []);

  const subtotal = (cart?.items ?? []).reduce((s, l) => s + l.unitPrice * l.quantity, 0);

  async function saveAddress() {
    setBusy(true); setError(null);
    try {
      const coords = await new Promise<{ lat: number; lng: number }>((res) => {
        if (!navigator.geolocation) return res({ lat: 6.8013, lng: -58.1551 });
        navigator.geolocation.getCurrentPosition(
          (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
          () => res({ lat: 6.8013, lng: -58.1551 }), // Georgetown fallback
          { timeout: 5000 },
        );
      });
      const a = await addAddress({ ...newAddr, region: 'Demerara-Mahaica', latitude: coords.lat, longitude: coords.lng, isDefault: addresses.length === 0 });
      setAddingAddr(false);
      await refresh();
      setAddrId(a.id ?? addrId);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function placeOrder(asPickup = false) {
    if (!cart?.items?.length) return;
    setBusy(true); setError(null); setNoRiders(false);
    try {
      if (addrId) await setCartAddress(addrId).catch(() => {});
      const body: any = { paymentMethod: pay, tipAmount: tip };
      if (asPickup && cart.items[0]) {
        body.fulfillmentSelections = Object.fromEntries([...new Set(cart.items.map((l) => l.vendorId))].map((v) => [v, 'PICKUP']));
      }
      const res = await checkout(body);
      const oid = res.order?.id ?? res.orders?.[0]?.id;
      router.push(oid ? `/orders/${oid}` : '/orders');
    } catch (e: any) {
      if (String(e.message).includes('No delivery riders') || String(e.message).includes('NO_RIDERS')) setNoRiders(true);
      else setError(e.message);
    } finally { setBusy(false); }
  }

  if (!cart) return <div className="h-64 animate-pulse rounded-2xl bg-[var(--swift-subtle)]" />;
  if (!cart.items?.length) return (
    <div className="py-20 text-center">
      <p className="text-lg font-bold">Your cart is empty</p>
      <Link href="/order" className="mt-3 inline-block rounded-full bg-[var(--swift-red)] px-5 py-2.5 font-bold text-white">Browse Swift</Link>
    </div>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <h1 className="text-2xl font-extrabold">Your cart</h1>
        {cart.items.map((l) => (
          <div key={l.id} className="flex items-center gap-3 rounded-2xl border border-black/5 bg-white p-3">
            <div className="min-w-0 flex-1">
              <p className="font-bold">{l.name}</p>
              {l.vendorName && <p className="text-xs text-[var(--swift-muted)]">{l.vendorName}</p>}
              <p className="mt-0.5 font-semibold text-[var(--swift-red)]">{money(l.unitPrice)}</p>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-black/10 px-2 py-1">
              <button onClick={async () => { l.quantity <= 1 ? await removeCartLine(l.id) : await updateCartLine(l.id, l.quantity - 1); refresh(); }} className="px-2 font-bold">−</button>
              <span className="w-5 text-center font-bold">{l.quantity}</span>
              <button onClick={async () => { await updateCartLine(l.id, l.quantity + 1); refresh(); }} className="px-2 font-bold">+</button>
            </div>
            <button onClick={async () => { await removeCartLine(l.id); refresh(); }} aria-label="Remove" className="grid h-8 w-8 place-items-center rounded-full text-[var(--swift-red)] hover:bg-[var(--swift-red-50)]"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
      </div>

      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <div className="rounded-2xl border border-black/5 bg-white p-4">
          <p className="mb-2 flex items-center gap-1.5 font-bold"><MapPin className="h-4 w-4 text-[var(--swift-red)]" /> Deliver to</p>
          {addresses.length > 0 ? (
            <select value={addrId ?? ''} onChange={(e) => setAddrId(e.target.value)} className="w-full rounded-xl border border-black/10 px-3 py-2">
              {addresses.map((a) => <option key={a.id} value={a.id}>{a.label} — {a.addressLine1}, {a.city}</option>)}
            </select>
          ) : addingAddr ? (
            <div className="space-y-2">
              <input placeholder="Street + number" value={newAddr.addressLine1} onChange={(e) => setNewAddr({ ...newAddr, addressLine1: e.target.value })} className="w-full rounded-xl border border-black/10 px-3 py-2" />
              <input placeholder="City" value={newAddr.city} onChange={(e) => setNewAddr({ ...newAddr, city: e.target.value })} className="w-full rounded-xl border border-black/10 px-3 py-2" />
              <button onClick={saveAddress} disabled={busy || !newAddr.addressLine1} className="w-full rounded-full bg-[var(--swift-red)] py-2 font-bold text-white disabled:opacity-60">{busy ? 'Saving…' : 'Save address (uses your location)'}</button>
            </div>
          ) : (
            <button onClick={() => setAddingAddr(true)} className="w-full rounded-full border border-[var(--swift-red)] py-2 font-bold text-[var(--swift-red)]">Add a delivery address</button>
          )}
        </div>

        <div className="rounded-2xl border border-black/5 bg-white p-4">
          <p className="mb-2 font-bold">Tip your rider</p>
          <div className="flex flex-wrap gap-2">
            {TIPS.map((t) => (
              <button key={t} onClick={() => setTip(t)} className={`rounded-full px-3.5 py-1.5 text-sm font-semibold ${tip === t ? 'bg-[var(--swift-red)] text-white' : 'border border-black/10'}`}>{t === 0 ? 'No tip' : money(t)}</button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-black/5 bg-white p-4">
          <p className="mb-2 font-bold">Payment</p>
          {(['CASH', 'MOBILE_MONEY'] as const).map((m) => (
            <label key={m} className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-black/10 px-3 py-2.5 mb-2 has-[:checked]:border-[var(--swift-red)] has-[:checked]:bg-[var(--swift-red-50)]">
              <input type="radio" name="pay" checked={pay === m} onChange={() => setPay(m)} className="accent-[var(--swift-red)]" />
              <span>{m === 'CASH' ? 'Cash on delivery' : 'Pay with MMG'}</span>
            </label>
          ))}
          <p className="text-xs text-[var(--swift-muted)]">Swift never holds your order money — you pay the business or rider directly.</p>
        </div>

        <div className="rounded-2xl border border-black/5 bg-white p-4">
          <div className="flex justify-between text-sm"><span className="text-[var(--swift-muted)]">Items</span><span className="font-semibold">{money(subtotal)}</span></div>
          <div className="mt-1 flex justify-between text-sm"><span className="text-[var(--swift-muted)]">Rider tip</span><span className="font-semibold">{money(tip)}</span></div>
          <div className="mt-2 flex justify-between border-t border-black/5 pt-2 text-lg font-extrabold"><span>Total</span><span>{money(subtotal + tip)}</span><span className="text-xs font-normal text-[var(--swift-muted)]">+ delivery</span></div>
          {error && <p className="mt-2 text-sm font-semibold text-[var(--swift-red)]">{error}</p>}
          {noRiders ? (
            <div className="mt-3 space-y-2">
              <p className="text-sm font-semibold text-[var(--swift-red)]">No delivery riders are online right now.</p>
              <button onClick={() => placeOrder(true)} disabled={busy} className="w-full rounded-full bg-[var(--swift-red)] py-3 font-bold text-white disabled:opacity-60">Order for pickup instead</button>
            </div>
          ) : (
            <button onClick={() => placeOrder(false)} disabled={busy} className="mt-3 w-full rounded-full bg-[var(--swift-red)] py-3.5 font-bold text-white disabled:opacity-60">{busy ? 'Placing…' : 'Order now'}</button>
          )}
        </div>
      </aside>
    </div>
  );
}

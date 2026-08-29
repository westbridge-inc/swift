'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useParams } from 'next/navigation';
import { Star, Clock, Plus, X, Minus } from 'lucide-react';
import { getVendor, addToCart, getItemSlots, savePendingAppointment, money, type VendorDetail, type MenuItem } from '@/lib/customer';

function nextDays(n: number) {
  const out: { key: string; label: string }[] = [];
  const base = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(base); d.setDate(base.getDate() + i);
    out.push({ key: d.toISOString().slice(0, 10), label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) });
  }
  return out;
}

function itemPrice(item: MenuItem, sel: Record<string, string>) {
  let p = item.customerPrice ?? item.basePrice;
  for (const g of item.optionGroups ?? []) {
    const opt = g.options.find((o) => o.id === sel[g.id]);
    if (opt) p += Number(opt.additionalPrice || 0);
  }
  return p;
}

export default function VendorPage() {
  const { id } = useParams<{ id: string }>();
  const [v, setV] = useState<VendorDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<MenuItem | null>(null);
  const [sel, setSel] = useState<Record<string, string>>({});
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [added, setAdded] = useState(0);
  // Service booking (fulfillment=APPOINTMENT)
  const [book, setBook] = useState<MenuItem | null>(null);
  const [bday, setBday] = useState(() => new Date().toISOString().slice(0, 10));
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slot, setSlot] = useState<string | null>(null);

  useEffect(() => { getVendor(id).then(setV).catch((e) => setError(e.message)); }, [id]);
  useEffect(() => {
    if (!book) return;
    setSlots(null); setSlot(null);
    getItemSlots(book.id, bday).then((r) => setSlots(r.slots ?? [])).catch(() => setSlots([]));
  }, [book, bday]);

  async function confirmBook() {
    if (!book || !v || !slot) return;
    setBusy(true);
    try {
      await addToCart({ vendorId: v.id, itemId: book.id, quantity: 1 });
      savePendingAppointment({ itemId: book.id, slotStart: slot, label: `${book.name} — ${new Date(slot).toLocaleString()}` });
      setAdded((n) => n + 1); setBook(null); setToast('Booking added to your cart');
      setTimeout(() => setToast(null), 2500);
    } catch (e: any) { setToast(e.message || 'Could not book'); }
    finally { setBusy(false); }
  }

  function openItem(item: MenuItem) {
    if (!item.isAvailable) return;
    if (item.fulfillment === 'APPOINTMENT') { setBday(new Date().toISOString().slice(0, 10)); setBook(item); return; }
    const defaults: Record<string, string> = {};
    for (const g of item.optionGroups ?? []) {
      const d = g.options.find((o) => o.isDefault) ?? g.options[0];
      if (g.isRequired && d) defaults[g.id] = d.id;
    }
    setSel(defaults); setQty(1); setModal(item);
  }

  async function confirmAdd() {
    if (!modal || !v) return;
    for (const g of modal.optionGroups ?? []) {
      if (g.isRequired && !sel[g.id]) { setToast(`Choose an option for “${g.name}”.`); return; }
    }
    setBusy(true);
    try {
      await addToCart({ vendorId: v.id, itemId: modal.id, quantity: qty, selectedOptions: sel });
      setAdded((n) => n + qty); setModal(null); setToast('Added to your cart');
      setTimeout(() => setToast(null), 2500);
    } catch (e: any) { setToast(e.message || 'Could not add item'); }
    finally { setBusy(false); }
  }

  if (error) return <p className="rounded-2xl border border-dashed border-black/10 p-10 text-center text-[var(--swift-muted)]">Couldn’t load this store — {error}</p>;
  if (!v) return <div className="h-64 animate-pulse rounded-2xl bg-[var(--swift-subtle)]" />;

  return (
    <div className="space-y-6 pb-24">
      <div className="relative h-44 overflow-hidden rounded-2xl bg-[var(--swift-subtle)] md:h-56">
        {v.coverImageUrl && <Image src={v.coverImageUrl} alt={v.name} fill unoptimized className="object-cover" />}
      </div>
      <div>
        <h1 className="text-2xl font-extrabold md:text-3xl">{v.name}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-3 text-sm text-[var(--swift-muted)]">
          <span className="flex items-center gap-1"><Star className="h-4 w-4 fill-amber-400 text-amber-400" />{v.displayRating === null ? 'New' : `${v.displayRating.toFixed(1)} ${v.ratingBucket}`}</span>
          <span className="flex items-center gap-1"><Clock className="h-4 w-4" />~{v.estimatedPrepTime} min</span>
          {v.deliveryFee != null && <span>· {money(Number(v.deliveryFee))} delivery</span>}
          {!v.isCurrentlyOpen && <span className="font-bold text-[var(--swift-red)]">· Closed now</span>}
        </p>
        {v.description && <p className="mt-2 max-w-2xl text-[var(--swift-muted)]">{v.description}</p>}
      </div>

      {v.categories.map((cat) => (
        <section key={cat.id}>
          <h2 className="mb-3 text-lg font-extrabold">{cat.name}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {cat.items.map((it) => (
              <button key={it.id} onClick={() => openItem(it)} disabled={!it.isAvailable}
                className={`flex items-center gap-3 rounded-2xl border border-black/5 bg-white p-3 text-left transition-shadow ${it.isAvailable ? 'hover:shadow-md' : 'opacity-50'}`}>
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{it.name}</p>
                  {it.description && <p className="line-clamp-2 text-sm text-[var(--swift-muted)]">{it.description}</p>}
                  <p className="mt-1 font-semibold text-[var(--swift-red)]">{money(it.customerPrice ?? it.basePrice)}{!it.isAvailable && ' · sold out'}</p>
                </div>
                <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-[var(--swift-subtle)]">
                  {it.imageUrl && <Image src={it.imageUrl} alt={it.name} fill unoptimized className="object-cover" />}
                  {it.isAvailable && <span className="absolute bottom-1 right-1 grid h-7 w-7 place-items-center rounded-full bg-[var(--swift-red)] text-white shadow"><Plus className="h-4 w-4" /></span>}
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}

      {added > 0 && (
        <Link href="/cart" className="fixed inset-x-0 bottom-4 z-30 mx-auto flex w-[92%] max-w-md items-center justify-between rounded-full bg-[var(--swift-red)] px-5 py-3.5 font-bold text-white shadow-lg">
          <span>View cart</span><span>{added} item{added > 1 ? 's' : ''}</span>
        </Link>
      )}

      {modal && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => setModal(null)}>
          <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <h3 className="text-xl font-extrabold">{modal.name}</h3>
              <button onClick={() => setModal(null)} className="grid h-8 w-8 place-items-center rounded-full hover:bg-[var(--swift-subtle)]"><X className="h-5 w-5" /></button>
            </div>
            {modal.description && <p className="mt-1 text-sm text-[var(--swift-muted)]">{modal.description}</p>}
            {(modal.optionGroups ?? []).map((g) => (
              <div key={g.id} className="mt-4">
                <p className="font-bold">{g.name} {g.isRequired && <span className="text-sm font-semibold text-[var(--swift-red)]">Required</span>}</p>
                <div className="mt-2 space-y-1.5">
                  {g.options.filter((o) => o.isAvailable).map((o) => (
                    <label key={o.id} className="flex cursor-pointer items-center justify-between rounded-xl border border-black/10 px-3 py-2.5 has-[:checked]:border-[var(--swift-red)] has-[:checked]:bg-[var(--swift-red-50)]">
                      <span className="flex items-center gap-2.5">
                        <input type="radio" name={g.id} checked={sel[g.id] === o.id} onChange={() => setSel((s) => ({ ...s, [g.id]: o.id }))} className="accent-[var(--swift-red)]" />
                        {o.name}
                      </span>
                      {Number(o.additionalPrice) > 0 && <span className="text-sm text-[var(--swift-muted)]">+{money(Number(o.additionalPrice))}</span>}
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <div className="mt-5 flex items-center gap-3">
              <div className="flex items-center gap-3 rounded-full border border-black/10 px-2 py-1">
                <button onClick={() => setQty((q) => Math.max(1, q - 1))} className="grid h-8 w-8 place-items-center rounded-full hover:bg-[var(--swift-subtle)]"><Minus className="h-4 w-4" /></button>
                <span className="w-5 text-center font-bold">{qty}</span>
                <button onClick={() => setQty((q) => q + 1)} className="grid h-8 w-8 place-items-center rounded-full hover:bg-[var(--swift-subtle)]"><Plus className="h-4 w-4" /></button>
              </div>
              <button onClick={confirmAdd} disabled={busy} className="flex-1 rounded-full bg-[var(--swift-red)] py-3 font-bold text-white disabled:opacity-60">
                {busy ? 'Adding…' : `Add · ${money(itemPrice(modal, sel) * qty)}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {book && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => setBook(null)}>
          <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <h3 className="text-xl font-extrabold">Book {book.name}</h3>
              <button onClick={() => setBook(null)} className="grid h-8 w-8 place-items-center rounded-full hover:bg-[var(--swift-subtle)]"><X className="h-5 w-5" /></button>
            </div>
            <p className="mt-1 font-semibold text-[var(--swift-red)]">{money(book.customerPrice ?? book.basePrice)}</p>
            <p className="mt-4 font-bold">Pick a day</p>
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
              {nextDays(7).map((d) => (
                <button key={d.key} onClick={() => setBday(d.key)} className={`shrink-0 rounded-xl border px-3 py-2 text-sm font-semibold ${bday === d.key ? 'border-[var(--swift-red)] bg-[var(--swift-red-50)]' : 'border-black/10'}`}>{d.label}</button>
              ))}
            </div>
            <p className="mt-4 font-bold">Pick a time</p>
            {slots === null ? <p className="mt-2 text-sm text-[var(--swift-muted)]">Loading times…</p>
              : slots.length === 0 ? <p className="mt-2 text-sm text-[var(--swift-muted)]">No times available on this day — try another.</p>
              : <div className="mt-2 grid grid-cols-3 gap-2">
                  {slots.map((s) => <button key={s} onClick={() => setSlot(s)} className={`rounded-xl border py-2 text-sm font-semibold ${slot === s ? 'border-[var(--swift-red)] bg-[var(--swift-red-50)]' : 'border-black/10'}`}>{new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</button>)}
                </div>}
            <button onClick={confirmBook} disabled={busy || !slot} className="mt-5 w-full rounded-full bg-[var(--swift-red)] py-3 font-bold text-white disabled:opacity-50">{busy ? 'Booking…' : slot ? 'Add booking to cart' : 'Choose a time'}</button>
          </div>
        </div>
      )}

      {toast && <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[var(--swift-ink)] px-4 py-2.5 text-sm font-semibold text-white shadow-lg">{toast}</div>}
    </div>
  );
}
